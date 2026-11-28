/**
 * Inode-based infoHash backfill — the verified-truth strategy.
 *
 * The path/name/size heuristics in `infohash-backfill-by-path.ts` can be
 * wrong in two directions: false positives on byte-size collisions, false
 * negatives on tokenization edge cases (apostrophes, superscripts, year
 * shifts, release-name truncation). Inode matching has neither failure
 * mode because the (st_dev, st_ino) tuple IS the file's identity on POSIX:
 * two hardlinks to the same content share inodes by definition. If the
 * tuple matches, the files are the same content; if it doesn't, they
 * aren't. There is no gray zone.
 *
 * Mirrored from autobrr/qui's `pkg/hardlink` +
 * `internal/services/dirscan/fileid_index.go`:
 *
 *  - qui's `FileID` = `{Dev, Ino}` on Unix; ours is the string `"dev:ino"`
 *    for use as a JS Map key (Node has no comparable struct primitive).
 *  - qui's `LinkInfo` returns `(fileID, nlink, err)`; display/backfill
 *    indexes skip `nlink == 1` because those files cannot correlate to a
 *    separate hardlink. Destructive verification also indexes them so a
 *    library path that is the qBit content file itself remains visible.
 *  - qui's `addTorrentFilesToFileIDIndex` stats each torrent's FILE list
 *    (from qBit's API). We walk a torrent-specific content root, but when
 *    only the shared save directory exists we index only provider-declared
 *    relative file paths. This is essential because qui's hardlink-mode
 *    cross-seed layout ALWAYS wraps torrents in a `Name--shortHash/`
 *    folder, so an index that stat'd only the folder root would record
 *    the FOLDER's inode and miss the inode of the actual .mkv inside.
 *  - **Caching divergence from qui**: qui doesn't cache their FileID
 *    index — `internal/services/dirscan/service.go` rebuilds it fresh
 *    per scan run because their scans are scheduled background work
 *    (no user blocked on a spinner) and qui is co-located with qBit +
 *    the FS for sub-second builds. WE are on the user's critical path
 *    (panel-load → 12-minute cold build is unacceptable), so we keep an
 *    in-memory TTL cache (`INDEX_CACHE`) AND a disk-persisted snapshot
 *    (`InodeIndexCache` Prisma model). Pre-warm on startup loads the
 *    persisted snapshot before the first user request lands.
 *  - qui's `HasLocalFilesystemAccess` per-instance toggle gates this whole
 *    strategy; the sweep loop in `infohash-backfill-by-path.ts` checks the
 *    flag before calling into here.
 *
 * Scope:
 *
 *  - Linux/macOS first-class. Windows would need `GetFileInformationByHandle`
 *    via a native module; Node's `fs.statSync` on some Windows filesystems
 *    returns `ino = 0` which is unsafe to use as an identity. Windows users
 *    fall back to heuristics by leaving `hasLocalFilesystemAccess = false`.
 *  - Movies: single-file torrents AND folder-wrapped torrents both work.
 *    The index contains the inode of every hardlinked file inside any
 *    qui torrent.
 *  - Sonarr per-episode / Lidarr per-track: the index already contains
 *    the per-file inodes, but the SWEEP layer (in `infohash-backfill-by-path.ts`)
 *    currently only iterates Radarr movie rows. Extending to per-episode
 *    correlation requires schema work — `EpisodeFileCache` (or similar)
 *    rows that the sweep can iterate. That work is queued; the index
 *    built here is already complete.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { posix } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { QuiTorrent } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import { withIndependentCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import type { QuiClient } from "../qui/client-factory.js";
import { readProviderContentPath } from "../qui/torrent-content-path.js";
import { getErrorMessage } from "../utils/error-message.js";

/**
 * The result of a successful inode match. `source: "inode"` is the
 * verified-truth label written to `LibraryCache.infoHashSource` so the
 * UI can render a green "verified" chip vs the amber chip used for
 * heuristic strategies.
 */
export interface InodeMatchResult {
	hash: string;
	source: "inode";
}

/**
 * Index built from a qui instance's torrent list. Keys are `"dev:ino"`
 * strings to match Map's structural-equality semantics. Each key maps
 * to a SET of torrent hashes — multiple torrents can share the same
 * inode (cross-seeded content across trackers, qui's hardlink-mode
 * mirror layout). Pre-2026-05 versions used `Map<string, string>` and
 * silently dropped all but the last hash per inode; that masked
 * cross-seed visibility everywhere downstream.
 */
export interface FileIdIndex {
	/** Connection generation that authorized a persisted index. Missing means legacy/unknown. */
	sourceConnectionGeneration?: number;
	/** Ownership proof used for fallback save-path matches; older snapshots must rebuild. */
	fallbackOwnershipVersion?: number;
	/** Map from `"dev:ino"` → set of torrent hashes that share this inode. */
	byFileId: Map<string, Set<string>>;
	/**
	 * Filesystem marker captured when an indexed inode was observed.
	 * Destructive resolution re-stats the target and requires this marker
	 * to match, so a hardlink added or removed after the scan fails closed.
	 *
	 * Optional because persisted and display-only indexes predate this field.
	 */
	inodeMarkers?: Map<string, FileSystemMarker>;
	/** Number of file→hash associations added (one per torrent file). */
	statted: number;
	/** Number of files skipped because `nlink == 1` (no hardlinks possible). */
	skippedNoLinks: number;
	/** Number of torrents whose root content path couldn't be stat'd. */
	skippedUnstatable: number;
	/** True only when the provider's entire paginated inventory was verified. */
	inventoryComplete?: boolean;
	/**
	 * Number of directory inventories that could not be read completely,
	 * were capped, or contained files that could not be stat'd.
	 *
	 * Optional for backward compatibility with persisted/UI-only indexes.
	 * Destructive callers must use `buildFreshCompleteFileIdIndex`, which
	 * always supplies and validates this field.
	 */
	incompleteDirectoryWalks?: number;
	/** Aggregate-only reasons for incomplete walks; never includes paths or hashes. */
	walkIssues?: DirectoryWalkIssues;
	/** Per-torrent generic failure counts for incomplete walks; contains no names or paths. */
	issues?: FileIdCoverageIssue[];
	/** Digest of the qUI listing indexed; names and paths are not persisted here. */
	torrentInventoryFingerprint?: string;
	/** Aggregate-only scope and size of capped walks; never includes paths or hashes. */
	rootDiagnostics?: RootWalkDiagnostics;
	/** Aggregate-only evidence about provider-reported roots; never serialized paths. */
	contentPathDiagnostics?: ContentPathDiagnostics;
	/** Aggregate-only distribution of failed provider-file inventories. */
	fallbackIssueDiagnostics?: FallbackIssueDiagnostics;
	/**
	 * Torrent-root and nested-directory markers captured before their files
	 * were indexed. A destructive build validates them after the walk, which
	 * catches a torrent path changing after it was visited without requiring
	 * a second 5-15 minute full-file stat pass.
	 */
	stabilityMarkers?: Map<string, FileSystemMarker>;
	/** Strict-build no-follow markers for provider-declared fallback file paths. */
	fallbackPathMarkers?: Map<string, FileSystemMarker>;
}

/** Generic, path-free attribution for one incomplete torrent inventory scope. */
export interface FileIdCoverageIssue {
	hash: string;
	qbitInstanceId: number | null;
	missingFiles: number;
	sizeMismatches: number;
	otherFailures: number;
}

interface FileSystemMarker {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
	ctimeMs: number;
	mtimeMs: number;
	kind: "file" | "directory" | "other";
}

interface DirectoryWalkIssues {
	readFailures: number;
	entryLimitExceeded: number;
	unsupportedEntries: number;
	entryStatFailures: number;
	entryMissing: number;
	entryKindMismatches: number;
	entrySizeMismatches: number;
	fallbackIncompleteFileFailures: number;
	fallbackCompleteFileFailures: number;
	fallbackSizeMismatchSmaller: number;
	fallbackSizeMismatchLarger: number;
	fallbackSizeMismatchErrorTorrent: number;
	fallbackSizeMismatchOtherTorrent: number;
	stabilityFailures: number;
	providerBudgetExceeded: number;
}

interface RootWalkDiagnostics {
	cappedPrimaryWalks: number;
	cappedFallbackWalks: number;
	largestCappedWalkEntries: number;
}

interface ContentPathDiagnostics {
	present: number;
	fallbackPresent: number;
	fallbackDistinctFromSavePath: number;
	fallbackStatable: number;
	fallbackContentFileRoots: number;
	fallbackContentDirectoryRoots: number;
	/** Failed fallback entries whose declared size matches an alternate provider root. Diagnostic only. */
	fallbackFailedFilesAltExact: number;
	fallbackFailedFilesAltLarger: number;
	fallbackFailedFilesAltSmaller: number;
}

interface FallbackIssueDiagnostics {
	missingEntryTorrents: number;
	sizeMismatchTorrents: number;
	maxMissingEntriesPerTorrent: number;
	maxSizeMismatchesPerTorrent: number;
	sizeMismatchFileContentRoots: number;
	sizeMismatchDirectoryContentRoots: number;
	sizeMismatchUnavailableContentRoots: number;
}

function emptyDirectoryWalkIssues(): DirectoryWalkIssues {
	return {
		readFailures: 0,
		entryLimitExceeded: 0,
		unsupportedEntries: 0,
		entryStatFailures: 0,
		entryMissing: 0,
		entryKindMismatches: 0,
		entrySizeMismatches: 0,
		fallbackIncompleteFileFailures: 0,
		fallbackCompleteFileFailures: 0,
		fallbackSizeMismatchSmaller: 0,
		fallbackSizeMismatchLarger: 0,
		fallbackSizeMismatchErrorTorrent: 0,
		fallbackSizeMismatchOtherTorrent: 0,
		stabilityFailures: 0,
		providerBudgetExceeded: 0,
	};
}

interface CachedIndex {
	index: FileIdIndex;
	builtAt: number;
}

const INDEX_CACHE = new Map<string, CachedIndex>();

// Refresh cadence for the in-memory index. Original 2-min TTL was
// mythology-based (the comment said "qui uses 2 min" — they don't cache
// at all). 30 min is honest given the typical churn rate of a hardlink
// library: torrents are added/removed on the order of minutes-to-hours,
// not seconds. Combined with disk-persistence (below), this means a
// fresh-after-restart user request finds a warm cache 99% of the time,
// and the worst-case staleness for a new cross-seed is 30 min.
//
// Test code overrides via `__testOnly.INDEX_TTL_MS`.
const INDEX_TTL_MS = 30 * 60 * 1000;
export const FILE_ID_INDEX_FRESH_MS = INDEX_TTL_MS;

/**
 * In-flight build deduplication. When a cold cache + concurrent panel
 * loads collide, every request would otherwise kick off its own
 * `listAllTorrents` + filesystem walk — hammering qui and the FS in
 * parallel. Storing the in-flight Promise here means all concurrent
 * callers await the same build and split the cost once.
 *
 * Entries are cleared when the build resolves (success or failure) so a
 * later request can retry. The TTL cache (above) handles the "succeeded
 * recently" case independently.
 */
const INDEX_PENDING = new Map<
	string,
	{ promise: Promise<FileIdIndex>; connectionGeneration: number; epoch: number }
>();
const LEGACY_UPGRADE_RETRY_MS = 5 * 60 * 1000;
const LEGACY_UPGRADE_RETRY_AFTER = new Map<string, number>();
const INDEX_EPOCH = new Map<string, number>();

function indexEpoch(instanceId: string): number {
	return INDEX_EPOCH.get(instanceId) ?? 0;
}

function builtIndexIsIncomplete(index: FileIdIndex | undefined): boolean {
	if (!index) return true;
	return (
		index.inventoryComplete !== true ||
		index.skippedUnstatable !== 0 ||
		index.incompleteDirectoryWalks === undefined ||
		index.incompleteDirectoryWalks > 0
	);
}

/**
 * Hard safety cap on the recursive directory walk per torrent. Movies and
 * episodes are 1-30 files at most; an album pack might be 20 tracks plus
 * a folder.jpg. Refusing to walk past 500 entries protects against an
 * accidental symlink loop or a pathological "torrent" that's actually
 * pointed at a media root by misconfiguration. qui has no equivalent cap
 * because qBit's API gives them an explicit file list — we walk the
 * filesystem ourselves, so we need our own bound.
 */
const MAX_WALK_ENTRIES_PER_TORRENT = 500;
const MAX_FALLBACK_FILE_INVENTORIES = 128;
const MAX_FALLBACK_FILES_PER_TORRENT = 5000;
const FALLBACK_OWNERSHIP_VERSION = 4;

// ─── Persistence layer ─────────────────────────────────────────────────
//
// The in-memory cache is lost on every container restart. Production
// libraries take 5-15 minutes to cold-build the index (12k torrents x
// ~50k stat ops). On a critical-path user request, that's a UX cliff.
//
// Persisting the built index to the DB lets us load a hot index on
// startup. Subsequent panel loads serve from in-memory immediately;
// background refresh checks for drift on the TTL schedule.
//
// Format: gzipped JSON. Map<"dev:ino", Set<hash>> serializes to
// [["dev:ino", ["hash1", "hash2"]], ...]. For 80k file entries the
// uncompressed JSON is ~6 MB; gzip-9 brings it under 1 MB. Decompression
// and parsing on startup takes <500ms even on a slow machine.

/**
 * Serialize a FileIdIndex to a gzipped JSON Buffer for DB storage.
 * Sets become arrays — JSON can't represent Set natively.
 */
export function serializeFileIdIndex(index: FileIdIndex): Buffer {
	const entries: Array<[string, string[]]> = [];
	for (const [key, hashes] of index.byFileId) {
		entries.push([key, Array.from(hashes)]);
	}
	const payload = JSON.stringify({
		v: 1,
		sourceConnectionGeneration: index.sourceConnectionGeneration,
		fallbackOwnershipVersion: index.fallbackOwnershipVersion,
		statted: index.statted,
		skippedNoLinks: index.skippedNoLinks,
		skippedUnstatable: index.skippedUnstatable,
		inventoryComplete: index.inventoryComplete === true,
		incompleteDirectoryWalks: index.incompleteDirectoryWalks,
		walkIssues: index.walkIssues,
		issues: index.issues?.map((issue) => ({
			hash: issue.hash,
			qbitInstanceId: issue.qbitInstanceId,
			missingFiles: issue.missingFiles,
			sizeMismatches: issue.sizeMismatches,
			otherFailures: issue.otherFailures,
		})),
		torrentInventoryFingerprint: index.torrentInventoryFingerprint,
		rootDiagnostics: index.rootDiagnostics,
		contentPathDiagnostics: index.contentPathDiagnostics,
		fallbackIssueDiagnostics: index.fallbackIssueDiagnostics,
		entries,
	});
	return gzipSync(Buffer.from(payload, "utf8"), { level: 9 });
}

/**
 * Inverse of serializeFileIdIndex. Returns null on corruption / schema-
 * version mismatch instead of throwing — a bad cache row shouldn't
 * break the route, just trigger a fresh rebuild.
 */
export function deserializeFileIdIndex(buf: Buffer): FileIdIndex | null {
	try {
		const json = gunzipSync(buf).toString("utf8");
		const data = JSON.parse(json) as {
			v: number;
			sourceConnectionGeneration?: number;
			fallbackOwnershipVersion?: number;
			statted: number;
			skippedNoLinks: number;
			skippedUnstatable: number;
			inventoryComplete?: boolean;
			incompleteDirectoryWalks?: number;
			walkIssues?: DirectoryWalkIssues;
			issues?: unknown;
			torrentInventoryFingerprint?: unknown;
			rootDiagnostics?: RootWalkDiagnostics;
			contentPathDiagnostics?: ContentPathDiagnostics;
			fallbackIssueDiagnostics?: FallbackIssueDiagnostics;
			entries: Array<[string, string[]]>;
		};
		if (data.v !== 1) return null;
		if (data.fallbackOwnershipVersion === FALLBACK_OWNERSHIP_VERSION) {
			if (
				!Array.isArray(data.issues) ||
				!data.issues.every(isFileIdCoverageIssue) ||
				!isTorrentInventoryFingerprint(data.torrentInventoryFingerprint) ||
				!Number.isSafeInteger(data.skippedUnstatable) ||
				data.skippedUnstatable < 0 ||
				!Number.isSafeInteger(data.incompleteDirectoryWalks) ||
				(data.incompleteDirectoryWalks ?? -1) < 0 ||
				data.issues.length !== data.skippedUnstatable + data.incompleteDirectoryWalks!
			) {
				return null;
			}
		}
		const byFileId = new Map<string, Set<string>>();
		for (const [key, hashes] of data.entries) {
			byFileId.set(key, new Set(hashes));
		}
		return {
			byFileId,
			sourceConnectionGeneration: data.sourceConnectionGeneration,
			fallbackOwnershipVersion: data.fallbackOwnershipVersion,
			statted: data.statted,
			skippedNoLinks: data.skippedNoLinks,
			skippedUnstatable: data.skippedUnstatable,
			inventoryComplete:
				typeof data.inventoryComplete === "boolean" ? data.inventoryComplete : undefined,
			incompleteDirectoryWalks: data.incompleteDirectoryWalks,
			walkIssues: data.walkIssues,
			issues: Array.isArray(data.issues) ? data.issues : undefined,
			torrentInventoryFingerprint: isTorrentInventoryFingerprint(data.torrentInventoryFingerprint)
				? data.torrentInventoryFingerprint
				: undefined,
			rootDiagnostics: data.rootDiagnostics,
			contentPathDiagnostics: data.contentPathDiagnostics,
			fallbackIssueDiagnostics: data.fallbackIssueDiagnostics,
		};
	} catch {
		return null;
	}
}

function isFileIdCoverageIssue(value: unknown): value is FileIdCoverageIssue {
	if (!value || typeof value !== "object") return false;
	const issue = value as Partial<FileIdCoverageIssue>;
	const keys = Object.keys(value);
	return (
		keys.length === 5 &&
		keys.every((key) =>
			["hash", "qbitInstanceId", "missingFiles", "sizeMismatches", "otherFailures"].includes(key),
		) &&
		typeof issue.hash === "string" &&
		issue.hash.length > 0 &&
		issue.hash === issue.hash.trim().toLowerCase() &&
		(issue.qbitInstanceId === null ||
			(Number.isSafeInteger(issue.qbitInstanceId) && (issue.qbitInstanceId as number) > 0)) &&
		Number.isSafeInteger(issue.missingFiles) &&
		(issue.missingFiles as number) >= 0 &&
		Number.isSafeInteger(issue.sizeMismatches) &&
		(issue.sizeMismatches as number) >= 0 &&
		Number.isSafeInteger(issue.otherFailures) &&
		(issue.otherFailures as number) >= 0
	);
}

function isTorrentInventoryFingerprint(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Load the persisted index for a single instance from the DB. Returns
 * null when no row exists OR the payload is corrupt. The caller treats
 * either case as cache miss and rebuilds from scratch.
 *
 * Doesn't validate freshness — the caller decides based on `builtAt`
 * whether to use the loaded index or trigger a refresh.
 */
export async function loadFileIdIndexFromDb(
	prisma: PrismaClient,
	instanceId: string,
): Promise<CachedIndex | null> {
	const row = await prisma.inodeIndexCache.findUnique({
		where: { instanceId },
		select: {
			builtAt: true,
			serializedData: true,
			instance: { select: { connectionGeneration: true } },
		},
	});
	if (!row) return null;
	const buf = Buffer.isBuffer(row.serializedData)
		? row.serializedData
		: Buffer.from(row.serializedData);
	const index = deserializeFileIdIndex(buf);
	if (
		!index ||
		index.sourceConnectionGeneration !== row.instance.connectionGeneration ||
		index.fallbackOwnershipVersion !== FALLBACK_OWNERSHIP_VERSION
	)
		return null;
	return { index, builtAt: row.builtAt.getTime() };
}

/**
 * Persist a built index. Upsert so repeated builds for the same instance
 * just overwrite the prior row. Failure is logged but non-fatal —
 * persistence is an optimization, not source of truth.
 */
async function saveFileIdIndexToDb(
	prisma: PrismaClient,
	instanceId: string,
	index: FileIdIndex,
	log?: FastifyBaseLogger,
): Promise<"saved" | "stale" | "unavailable"> {
	try {
		const serializeStartedAt = Date.now();
		const serialized = serializeFileIdIndex(index);
		log?.info(
			{ bytes: serialized.length, serializeMs: Date.now() - serializeStartedAt },
			"inode-index: serialized snapshot before publication",
		);
		// Prisma's Bytes type wants `Uint8Array<ArrayBuffer>`. Node Buffer
		// is `Uint8Array<ArrayBufferLike>`. Allocate a fresh ArrayBuffer
		// (not the SharedArrayBuffer-permissible union) and copy into it.
		const ab = new ArrayBuffer(serialized.byteLength);
		const bytes = new Uint8Array(ab);
		bytes.set(serialized);
		const transactionStartedAt = Date.now();
		const saved = await prisma.$transaction(async (tx) => {
			const instance = await tx.serviceInstance.findUnique({
				where: { id: instanceId },
				select: { connectionGeneration: true },
			});
			if (!instance || instance.connectionGeneration !== index.sourceConnectionGeneration)
				return false;
			const builtAt = new Date();
			await tx.inodeIndexCache.upsert({
				where: { instanceId },
				create: { instanceId, builtAt, filesIndexed: index.statted, serializedData: bytes },
				update: { builtAt, filesIndexed: index.statted, serializedData: bytes },
			});
			return true;
		});
		log?.info(
			{ transactionMs: Date.now() - transactionStartedAt, saved },
			"inode-index: publication transaction finished",
		);
		if (!saved) return "stale";
		log?.info(
			{ instanceId, filesIndexed: index.statted, bytes: serialized.length },
			"inode-index: persisted snapshot to DB",
		);
		return "saved";
	} catch (err) {
		log?.warn(
			{ err, instanceId },
			"inode-index: persistence write failed (non-fatal; rebuild will retry)",
		);
		return "unavailable";
	}
}

/**
 * Hydrate INDEX_CACHE from persisted snapshots at server startup.
 * Called once during boot — see `preloadInodeIndexes` in server.ts.
 *
 * Loaded entries are immediately available to user requests via the
 * usual `INDEX_CACHE` path. Their `builtAt` is preserved so the TTL
 * check still applies — a snapshot older than INDEX_TTL_MS triggers
 * a background refresh the first time a request asks for it.
 *
 * Concurrent load is fine: this is called once before request traffic,
 * but the in-memory map's set operations are atomic at the JS level.
 */
export async function hydrateFileIdIndexFromDb(
	prisma: PrismaClient,
	log?: FastifyBaseLogger,
): Promise<{ loaded: number; failed: number }> {
	let loaded = 0;
	let failed = 0;
	const hydrationEpoch = new Map(INDEX_EPOCH);
	try {
		const rows = await prisma.inodeIndexCache.findMany({
			select: {
				instanceId: true,
				builtAt: true,
				serializedData: true,
				filesIndexed: true,
				instance: { select: { connectionGeneration: true } },
			},
		});
		for (const row of rows) {
			if (indexEpoch(row.instanceId) !== (hydrationEpoch.get(row.instanceId) ?? 0)) continue;
			const buf = Buffer.isBuffer(row.serializedData)
				? row.serializedData
				: Buffer.from(row.serializedData);
			const index = deserializeFileIdIndex(buf);
			if (!index) {
				failed++;
				log?.warn(
					{ instanceId: row.instanceId },
					"inode-index: persisted snapshot corrupt — will rebuild on first request",
				);
				continue;
			}
			if (
				index.sourceConnectionGeneration !== row.instance.connectionGeneration ||
				index.fallbackOwnershipVersion !== FALLBACK_OWNERSHIP_VERSION
			) {
				// Pre-generation snapshots cannot prove which qUI connection
				// produced their hashes. Rebuild cold once rather than treating
				// old positive matches as authority after a possible repoint.
				failed++;
				log?.info(
					{ instanceId: row.instanceId },
					"inode-index: persisted snapshot lacks current connection generation; rebuilding",
				);
				continue;
			}
			const current = INDEX_CACHE.get(row.instanceId);
			if (!current || current.builtAt < row.builtAt.getTime()) {
				INDEX_CACHE.set(row.instanceId, { index, builtAt: row.builtAt.getTime() });
			}
			loaded++;
			log?.info(
				{
					instanceId: row.instanceId,
					filesIndexed: row.filesIndexed,
					ageMinutes: Math.round((Date.now() - row.builtAt.getTime()) / 60000),
				},
				"inode-index: hydrated from persisted snapshot",
			);
		}
	} catch (err) {
		log?.warn({ err }, "inode-index: hydrate-from-db failed (continuing with empty cache)");
	}
	return { loaded, failed };
}

/**
 * Apply the instance's path-prefix rewrite to a qui-reported path.
 *
 * Format: `"qui-prefix>local-prefix"`. Example: `"/downloads>/qbit-data"`
 * rewrites `/downloads/movies/Foo.mkv` → `/qbit-data/movies/Foo.mkv`.
 *
 * Returns the input unchanged if `pathPrefix` is null/empty or doesn't
 * match the qui-prefix half. We don't fall back to "try without prefix"
 * because that hides config mistakes — if the prefix doesn't apply,
 * the file path likely isn't right for stat anyway.
 */
export function applyPathRewrite(quiPath: string, pathPrefix: string | null | undefined): string {
	if (!pathPrefix) return quiPath;
	const arrowIdx = pathPrefix.indexOf(">");
	if (arrowIdx < 0) return quiPath;
	const fromPrefix = pathPrefix.slice(0, arrowIdx);
	const toPrefix = pathPrefix.slice(arrowIdx + 1);
	if (!fromPrefix) return quiPath;
	if (!quiPath.startsWith(fromPrefix)) return quiPath;
	return toPrefix + quiPath.slice(fromPrefix.length);
}

/**
 * Build the (dev, ino) → hash map for a qui instance.
 *
 * For each torrent, we resolve its on-disk content path and index every
 * hardlinked file underneath it:
 *   - Single-file torrent → index the file itself.
 *   - Folder-wrapped torrent (qBit's "create subfolder" enabled, qui's
 *     hardlink-mode cross-seeds, season packs, album packs) → walk into
 *     the folder and index each file inside.
 *
 * Torrent-specific roots use the bounded filesystem walk. A fallback to a
 * potentially shared save directory uses qUI's per-torrent file list and
 * no-follow filesystem checks; scanning that directory as a whole could
 * assign unrelated hardlinks to the wrong torrent.
 *
 * Files with `nlink == 1` are skipped (no hardlinks → can't correlate
 * to anything). Files we can't stat are skipped silently — a single
 * unreadable file in a torrent shouldn't kill the index build.
 */
export async function buildFileIdIndex(
	client: QuiClient,
	instance: Pick<ServiceInstance, "id" | "label" | "pathPrefix" | "connectionGeneration">,
	log?: FastifyBaseLogger,
	/**
	 * Optional Prisma client. When provided, successful builds are
	 * persisted to the `InodeIndexCache` table so the next server
	 * startup can hydrate immediately via `hydrateFileIdIndexFromDb`.
	 * Omitted in unit tests that don't need DB-side effects.
	 */
	prisma?: PrismaClient,
): Promise<FileIdIndex> {
	const cachedCandidate = INDEX_CACHE.get(instance.id);
	const cached =
		cachedCandidate?.index.sourceConnectionGeneration === instance.connectionGeneration
			? cachedCandidate
			: undefined;
	const fresh = cached && Date.now() - cached.builtAt < INDEX_TTL_MS;
	const legacy =
		cached &&
		(cached.index.inventoryComplete === undefined ||
			cached.index.incompleteDirectoryWalks === undefined);
	const retryable =
		cached &&
		(legacy ||
			cached.index.inventoryComplete !== true ||
			cached.index.skippedUnstatable !== 0 ||
			(cached.index.incompleteDirectoryWalks ?? 0) > 0);
	if (fresh && !retryable) {
		return cached.index;
	}
	const retryAfter =
		LEGACY_UPGRADE_RETRY_AFTER.get(instance.id) ??
		(legacy ? 0 : (cached?.builtAt ?? 0) + LEGACY_UPGRADE_RETRY_MS);
	if (fresh && retryable && Date.now() < retryAfter) {
		return cached.index;
	}

	// In-flight dedup: if a build is already running for this instance,
	// await it instead of kicking off a parallel one. The previous code
	// had no dedup, so concurrent panel loads after a cold start would
	// each spawn their own `listAllTorrents` + ~50k stat ops in parallel
	// — saturating both qui and the FS until everything timed out.
	const pending = INDEX_PENDING.get(instance.id);
	if (
		pending &&
		pending.connectionGeneration === instance.connectionGeneration &&
		pending.epoch === indexEpoch(instance.id)
	) {
		return fresh && retryable ? cached.index : pending.promise;
	}

	const epoch = indexEpoch(instance.id);
	const assertCurrent = (): void => {
		if (indexEpoch(instance.id) !== epoch) {
			throw new Error("qUI inode index was invalidated during build");
		}
		const publishedGeneration = INDEX_CACHE.get(instance.id)?.index.sourceConnectionGeneration;
		if (publishedGeneration !== undefined && publishedGeneration > instance.connectionGeneration) {
			throw new Error("qUI inode index connection changed during build");
		}
	};
	const buildAndPublish = async (): Promise<FileIdIndex> => {
		const built = await doBuildFileIdIndex(client, instance, log);
		built.sourceConnectionGeneration = instance.connectionGeneration;
		assertCurrent();
		// Persist before publishing completion so database maintenance cannot
		// replace topology while a stale cache write remains in flight.
		// Persistence remains best-effort inside saveFileIdIndexToDb.
		if (prisma) {
			const persistence = await saveFileIdIndexToDb(prisma, instance.id, built, log);
			if (persistence === "stale") {
				throw new Error("qUI inode index connection changed during publication");
			}
		}
		assertCurrent();
		INDEX_CACHE.set(instance.id, { index: built, builtAt: Date.now() });
		return built;
	};
	// A panel route stops awaiting this single-flight producer after its
	// response timeout. When persistence is enabled, give the producer its own
	// lease so restore remains blocked until the durable publication settles.
	const buildPromise = prisma
		? withIndependentCleanupOperationGuard(buildAndPublish)
		: buildAndPublish();
	INDEX_PENDING.set(instance.id, {
		promise: buildPromise,
		connectionGeneration: instance.connectionGeneration,
		epoch,
	});
	const clearPending = (): void => {
		if (INDEX_PENDING.get(instance.id)?.promise === buildPromise) INDEX_PENDING.delete(instance.id);
	};
	if (fresh && retryable) {
		// Preserve positive matches from the older persisted snapshot while
		// upgrading its unknown coverage metadata. A single-flight rebuild
		// continues under the same restore/cleanup guard as a normal build.
		void buildPromise.then(
			() => {
				clearPending();
				if (indexEpoch(instance.id) !== epoch) return;
				if (builtIndexIsIncomplete(INDEX_CACHE.get(instance.id)?.index)) {
					LEGACY_UPGRADE_RETRY_AFTER.set(instance.id, Date.now() + LEGACY_UPGRADE_RETRY_MS);
				} else {
					LEGACY_UPGRADE_RETRY_AFTER.delete(instance.id);
				}
			},
			(err) => {
				clearPending();
				if (indexEpoch(instance.id) !== epoch) return;
				LEGACY_UPGRADE_RETRY_AFTER.set(instance.id, Date.now() + LEGACY_UPGRADE_RETRY_MS);
				log?.warn(
					{ err, quiInstanceId: instance.id },
					"inode-index: legacy coverage upgrade failed; retaining positive-only snapshot",
				);
			},
		);
		return cached.index;
	}
	try {
		return await buildPromise;
	} finally {
		clearPending();
	}
}

/**
 * Build an uncached inode snapshot suitable for destructive authorization.
 *
 * Unlike `buildFileIdIndex`, this never consumes the 30-minute in-memory or
 * persisted snapshot. It indexes single-link torrent files as well as
 * hardlinks, and refuses to return an index when any torrent root or directory
 * inventory could not be examined completely. A missing entry is safe for
 * display/backfill heuristics, but is not proof that a newly added cross-seed
 * or same-file torrent does not own the target file.
 */
export async function buildFreshCompleteFileIdIndex(
	client: QuiClient,
	instance: Pick<ServiceInstance, "id" | "label" | "pathPrefix">,
	log?: FastifyBaseLogger,
): Promise<FileIdIndex> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = await client.listAllTorrents({ requireComplete: true });
		const index = await doBuildFileIdIndex(client, instance, log, before, true);
		assertCompleteFileIdIndex(index);
		const after = await client.listAllTorrents({ requireComplete: true });
		if (torrentInventoryFingerprint(before) === torrentInventoryFingerprint(after)) {
			try {
				await assertStableFileSystemSnapshot(index);
				return index;
			} catch {
				// Fall through to the shared retry warning below.
			}
		}
		log?.warn(
			{ quiInstanceId: instance.id, attempt: attempt + 1 },
			"qUI torrent or filesystem inode inventory changed during destructive verification; rebuilding",
		);
	}
	throw new Error("qUI torrent and filesystem inode inventory did not remain stable");
}

async function doBuildFileIdIndex(
	client: QuiClient,
	instance: Pick<ServiceInstance, "id" | "label" | "pathPrefix">,
	log?: FastifyBaseLogger,
	snapshot?: QuiTorrent[],
	requireStableSnapshot = false,
): Promise<FileIdIndex> {
	let torrents: QuiTorrent[];
	let inventoryComplete = true;
	if (snapshot) {
		torrents = snapshot;
	} else {
		try {
			torrents = await client.listAllTorrents({ requireComplete: true });
		} catch {
			// Legacy qUI inventory shapes can still provide positive display
			// matches, but cannot prove absence or an exact count.
			inventoryComplete = false;
			torrents = await client.listAllTorrents();
		}
	}
	const byFileId = new Map<string, Set<string>>();
	const inodeMarkers = new Map<string, FileSystemMarker>();
	const stabilityMarkers = requireStableSnapshot ? new Map<string, FileSystemMarker>() : undefined;
	const fallbackPathMarkers = requireStableSnapshot
		? new Map<string, FileSystemMarker>()
		: undefined;
	let statted = 0;
	let skippedNoLinks = 0;
	let skippedUnstatable = 0;
	let incompleteDirectoryWalks = 0;
	let fallbackFileInventories = 0;
	const walkIssues = emptyDirectoryWalkIssues();
	const rootDiagnostics: RootWalkDiagnostics = {
		cappedPrimaryWalks: 0,
		cappedFallbackWalks: 0,
		largestCappedWalkEntries: 0,
	};
	const issues: FileIdCoverageIssue[] = [];
	const contentPathDiagnostics: ContentPathDiagnostics = {
		present: 0,
		fallbackPresent: 0,
		fallbackDistinctFromSavePath: 0,
		fallbackStatable: 0,
		fallbackContentFileRoots: 0,
		fallbackContentDirectoryRoots: 0,
		fallbackFailedFilesAltExact: 0,
		fallbackFailedFilesAltLarger: 0,
		fallbackFailedFilesAltSmaller: 0,
	};
	const fallbackIssueDiagnostics: FallbackIssueDiagnostics = {
		missingEntryTorrents: 0,
		sizeMismatchTorrents: 0,
		maxMissingEntriesPerTorrent: 0,
		maxSizeMismatchesPerTorrent: 0,
		sizeMismatchFileContentRoots: 0,
		sizeMismatchDirectoryContentRoots: 0,
		sizeMismatchUnavailableContentRoots: 0,
	};
	let firstStatErrorLogged = false;

	// Helper: add a hash to the set at this FileID key, creating the set
	// if needed. Centralized so the single-file and directory branches
	// stay consistent.
	const addHash = (key: string, hash: string, info: StatInfo): void => {
		const normalizedHash = hash.trim().toLowerCase();
		if (!normalizedHash) return;
		const existing = byFileId.get(key);
		if (existing) {
			existing.add(normalizedHash);
		} else {
			byFileId.set(key, new Set([normalizedHash]));
		}
		if (!inodeMarkers.has(key)) {
			inodeMarkers.set(key, toFileSystemMarker(info));
		}
	};

	for (const torrent of torrents) {
		const issue: FileIdCoverageIssue = {
			hash: torrent.hash.trim().toLowerCase(),
			qbitInstanceId:
				Number.isSafeInteger(torrent.instanceId) && (torrent.instanceId ?? 0) > 0
					? torrent.instanceId!
					: null,
			missingFiles: 0,
			sizeMismatches: 0,
			otherFailures: 0,
		};
		let torrentIncomplete = false;
		const providerContentPath = readProviderContentPath(torrent);
		const rewrittenProviderContentPath = providerContentPath
			? applyPathRewrite(providerContentPath, instance.pathPrefix).replace(/\/+$/, "")
			: undefined;
		if (providerContentPath) contentPathDiagnostics.present++;
		const trimmed = torrent.savePath ? torrent.savePath.replace(/\/+$/, "") : "";
		if (!trimmed) {
			skippedUnstatable++;
			issue.otherFailures++;
			torrentIncomplete = true;
			issues.push(issue);
			continue;
		}

		// qBit's convention: torrent content lives at `savePath/name`. For a
		// single-file torrent with "create subfolder" off, this IS the file.
		// For everything else, this is a directory (qui's hardlink-mode wraps
		// every cross-seed in `Name--shortHash/`, qBit folder-wraps by default,
		// multi-file torrents have their own root folder). Fall through to
		// `savePath` alone only if the first form doesn't stat — covers the
		// edge case where qBit's savePath itself already includes the name.
		const candidates = [
			applyPathRewrite(`${trimmed}/${torrent.name}`, instance.pathPrefix),
			applyPathRewrite(trimmed, instance.pathPrefix),
		];

		let resolved = false;
		for (const [candidateIndex, rootPath] of candidates.entries()) {
			const rootInfo = await statSafe(rootPath);
			if (!rootInfo) continue;
			resolved = true;
			let providerContentRootKind: "file" | "directory" | "unavailable" = "unavailable";
			if (candidateIndex > 0 && rewrittenProviderContentPath) {
				contentPathDiagnostics.fallbackPresent++;
				if (rewrittenProviderContentPath !== rootPath)
					contentPathDiagnostics.fallbackDistinctFromSavePath++;
				const providerRootInfo = await lstatSafe(rewrittenProviderContentPath);
				if (providerRootInfo?.kind === "file" || providerRootInfo?.kind === "directory")
					providerContentRootKind = providerRootInfo.kind;
				if (providerRootInfo) contentPathDiagnostics.fallbackStatable++;
				if (providerRootInfo?.kind === "file") contentPathDiagnostics.fallbackContentFileRoots++;
				if (providerRootInfo?.kind === "directory")
					contentPathDiagnostics.fallbackContentDirectoryRoots++;
			}
			if (stabilityMarkers && !stabilityMarkers.has(rootPath)) {
				stabilityMarkers.set(rootPath, toFileSystemMarker(rootInfo));
			}

			if (rootInfo.kind === "file") {
				if (candidateIndex > 0) {
					// A save path is a directory, never a torrent-owned file.
					incompleteDirectoryWalks++;
					walkIssues.unsupportedEntries++;
					issue.otherFailures++;
					torrentIncomplete = true;
					break;
				}
				if (rootInfo.nlink < 2 && !requireStableSnapshot) {
					skippedNoLinks++;
				} else {
					addHash(`${rootInfo.dev}:${rootInfo.ino}`, torrent.hash, rootInfo);
					statted++;
				}
			} else if (rootInfo.kind === "directory") {
				const stats =
					candidateIndex === 0
						? await indexDirectoryFiles(
								rootPath,
								torrent.hash,
								addHash,
								stabilityMarkers,
								requireStableSnapshot,
							)
						: fallbackFileInventories++ >= MAX_FALLBACK_FILE_INVENTORIES
							? {
									statted: 0,
									skippedNoLinks: 0,
									complete: false,
									issues: { ...emptyDirectoryWalkIssues(), providerBudgetExceeded: 1 },
									entriesSeen: 0,
								}
							: await indexFallbackTorrentFiles(
									client,
									torrent,
									rootPath,
									addHash,
									requireStableSnapshot,
									fallbackPathMarkers,
									rewrittenProviderContentPath,
									contentPathDiagnostics,
								);
				statted += stats.statted;
				skippedNoLinks += stats.skippedNoLinks;
				if (!stats.complete) {
					incompleteDirectoryWalks++;
					torrentIncomplete = true;
					issue.missingFiles += stats.issues.entryMissing;
					issue.sizeMismatches += stats.issues.entrySizeMismatches;
					issue.otherFailures += countOtherWalkFailures(stats.issues);
				}
				if (stats.issues.entryLimitExceeded > 0) {
					if (candidateIndex === 0) rootDiagnostics.cappedPrimaryWalks++;
					else rootDiagnostics.cappedFallbackWalks++;
					rootDiagnostics.largestCappedWalkEntries = Math.max(
						rootDiagnostics.largestCappedWalkEntries,
						stats.entriesSeen,
					);
				}
				for (const reason of Object.keys(walkIssues) as Array<keyof DirectoryWalkIssues>) {
					walkIssues[reason] += stats.issues[reason];
				}
				if (candidateIndex > 0) {
					if (stats.issues.entryMissing > 0) {
						fallbackIssueDiagnostics.missingEntryTorrents++;
						fallbackIssueDiagnostics.maxMissingEntriesPerTorrent = Math.max(
							fallbackIssueDiagnostics.maxMissingEntriesPerTorrent,
							stats.issues.entryMissing,
						);
					}
					if (stats.issues.entrySizeMismatches > 0) {
						fallbackIssueDiagnostics.sizeMismatchTorrents++;
						fallbackIssueDiagnostics.maxSizeMismatchesPerTorrent = Math.max(
							fallbackIssueDiagnostics.maxSizeMismatchesPerTorrent,
							stats.issues.entrySizeMismatches,
						);
						if (providerContentRootKind === "file")
							fallbackIssueDiagnostics.sizeMismatchFileContentRoots++;
						else if (providerContentRootKind === "directory")
							fallbackIssueDiagnostics.sizeMismatchDirectoryContentRoots++;
						else fallbackIssueDiagnostics.sizeMismatchUnavailableContentRoots++;
					}
				}
			}
			break;
		}

		if (!resolved) {
			skippedUnstatable++;
			issue.otherFailures++;
			torrentIncomplete = true;
			if (!firstStatErrorLogged) {
				log?.warn(
					{
						quiInstanceId: instance.id,
						quiInstanceLabel: instance.label,
						sampleTorrentName: torrent.name,
						sampleSavePath: torrent.savePath,
						pathPrefix: instance.pathPrefix,
					},
					"inode-backfill: first stat failure for this qui instance (path unreachable from arr-dashboard); further misses suppressed",
				);
				firstStatErrorLogged = true;
			}
		}
		if (torrentIncomplete) issues.push(issue);
	}

	const index: FileIdIndex = {
		fallbackOwnershipVersion: FALLBACK_OWNERSHIP_VERSION,
		torrentInventoryFingerprint: fingerprintQuiTorrentInventory(torrents),
		byFileId,
		inodeMarkers,
		statted,
		skippedNoLinks,
		skippedUnstatable,
		incompleteDirectoryWalks,
		walkIssues,
		issues,
		rootDiagnostics,
		contentPathDiagnostics,
		fallbackIssueDiagnostics,
		inventoryComplete,
		...(stabilityMarkers ? { stabilityMarkers } : {}),
		...(fallbackPathMarkers ? { fallbackPathMarkers } : {}),
	};
	// Cache write happens in the buildFileIdIndex wrapper (after this
	// function resolves) so the in-flight Promise dedup stays consistent.
	log?.info(
		{
			quiInstanceId: instance.id,
			torrents: torrents.length,
			filesIndexed: statted,
			skippedNoLinks,
			skippedUnstatable,
			incompleteDirectoryWalks,
			walkIssues,
			rootDiagnostics,
			contentPathDiagnostics,
			fallbackIssueDiagnostics,
		},
		"inode-backfill: built FileID index",
	);
	return index;
}

function countOtherWalkFailures(issues: DirectoryWalkIssues): number {
	return (
		issues.readFailures +
		issues.entryLimitExceeded +
		issues.unsupportedEntries +
		issues.entryKindMismatches +
		issues.stabilityFailures +
		issues.providerBudgetExceeded +
		Math.max(
			0,
			issues.entryStatFailures -
				issues.entryMissing -
				issues.entrySizeMismatches -
				issues.entryKindMismatches,
		)
	);
}

async function indexFallbackTorrentFiles(
	client: QuiClient,
	torrent: QuiTorrent,
	rootPath: string,
	addHash: (key: string, hash: string, info: StatInfo) => void,
	includeSingleLinks: boolean,
	fallbackPathMarkers?: Map<string, FileSystemMarker>,
	providerContentPath?: string,
	contentPathDiagnostics?: ContentPathDiagnostics,
): Promise<{
	statted: number;
	skippedNoLinks: number;
	complete: boolean;
	issues: DirectoryWalkIssues;
	entriesSeen: number;
}> {
	const issues = emptyDirectoryWalkIssues();
	let statted = 0;
	let skippedNoLinks = 0;
	if ((await lstatSafe(rootPath))?.kind !== "directory") {
		issues.unsupportedEntries++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: 0 };
	}
	if (!Number.isInteger(torrent.instanceId) || (torrent.instanceId ?? 0) <= 0) {
		issues.readFailures++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: 0 };
	}
	let files: Awaited<ReturnType<typeof client.getTorrentFiles>>;
	try {
		files = await client.getTorrentFiles(torrent.instanceId!, torrent.hash, { refresh: true });
	} catch {
		issues.readFailures++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: 0 };
	}
	if (files.length === 0) {
		issues.readFailures++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: 0 };
	}
	if (files.length > MAX_FALLBACK_FILES_PER_TORRENT) {
		issues.entryLimitExceeded++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: files.length };
	}
	let complete = true;
	for (const file of files) {
		const parts = file.name.split("/");
		if (
			file.name.startsWith("/") ||
			parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
		) {
			complete = false;
			issues.unsupportedEntries++;
			continue;
		}
		const recordFallbackFailure = (): void => {
			if (file.progress < 1) issues.fallbackIncompleteFileFailures++;
			else issues.fallbackCompleteFileFailures++;
		};
		const diagnoseAlternate = async (): Promise<void> => {
			if (includeSingleLinks || !providerContentPath || !contentPathDiagnostics) return;
			const category = await classifyProviderContentFileSize(
				providerContentPath,
				rootPath,
				parts,
				file.size,
				files.length,
			);
			if (category === "exact") contentPathDiagnostics.fallbackFailedFilesAltExact++;
			else if (category === "larger") contentPathDiagnostics.fallbackFailedFilesAltLarger++;
			else if (category === "smaller") contentPathDiagnostics.fallbackFailedFilesAltSmaller++;
		};
		let filePath = rootPath;
		let info: StatInfo | null = null;
		let pathValid = true;
		for (const [partIndex, part] of parts.entries()) {
			filePath = posix.join(filePath, part);
			info = await lstatSafe(filePath);
			if (!info || info.kind !== (partIndex === parts.length - 1 ? "file" : "directory")) {
				complete = false;
				issues.entryStatFailures++;
				if (!info) issues.entryMissing++;
				else issues.entryKindMismatches++;
				recordFallbackFailure();
				await diagnoseAlternate();
				pathValid = false;
				break;
			}
			if (fallbackPathMarkers && !fallbackPathMarkers.has(filePath)) {
				fallbackPathMarkers.set(filePath, toFileSystemMarker(info));
			}
		}
		if (!pathValid || !info) continue;
		if (info.size !== file.size) {
			complete = false;
			issues.entryStatFailures++;
			issues.entrySizeMismatches++;
			if (info.size < file.size) issues.fallbackSizeMismatchSmaller++;
			else issues.fallbackSizeMismatchLarger++;
			if (torrent.state === "error" || torrent.state === "missingFiles")
				issues.fallbackSizeMismatchErrorTorrent++;
			else issues.fallbackSizeMismatchOtherTorrent++;
			recordFallbackFailure();
			await diagnoseAlternate();
			continue;
		}
		if (info.nlink < 2 && !includeSingleLinks) {
			skippedNoLinks++;
			continue;
		}
		addHash(`${info.dev}:${info.ino}`, torrent.hash, info);
		statted++;
	}
	if (includeSingleLinks) {
		try {
			const after = await client.getTorrentFiles(torrent.instanceId!, torrent.hash, {
				refresh: true,
			});
			const fingerprint = (items: typeof files) =>
				JSON.stringify(
					items
						.map((item) => [
							item.index,
							item.name,
							item.size,
							item.progress,
							item.priority,
							item.isSeeding ?? null,
						])
						.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
				);
			if (fingerprint(files) !== fingerprint(after)) {
				complete = false;
				issues.stabilityFailures++;
			}
		} catch {
			complete = false;
			issues.readFailures++;
		}
	}
	return { statted, skippedNoLinks, complete, issues, entriesSeen: files.length };
}

async function classifyProviderContentFileSize(
	providerPath: string,
	fallbackRoot: string,
	parts: string[],
	expectedSize: number,
	fileCount: number,
): Promise<"exact" | "larger" | "smaller" | "missing"> {
	if (providerPath === fallbackRoot) return "missing";
	const rootInfo = await lstatSafe(providerPath);
	if (rootInfo?.kind === "file") {
		if (fileCount !== 1) return "missing";
		return rootInfo.size === expectedSize
			? "exact"
			: rootInfo.size > expectedSize
				? "larger"
				: "smaller";
	}
	if (rootInfo?.kind !== "directory") return "missing";
	let foundLarger = false;
	let foundSmaller = false;
	const candidateRoots = new Set([providerPath, posix.dirname(providerPath)]);
	const providerParts = providerPath.split("/").filter(Boolean);
	for (let overlap = 2; overlap < parts.length && overlap <= providerParts.length; overlap++) {
		if (providerParts.slice(-overlap).every((part, index) => part === parts[index])) {
			let ancestor = providerPath;
			for (let depth = 0; depth < overlap; depth++) ancestor = posix.dirname(ancestor);
			candidateRoots.add(ancestor);
		}
	}
	for (const candidateRoot of candidateRoots) {
		if (candidateRoot === fallbackRoot) continue;
		let current = candidateRoot;
		let candidateInfo: StatInfo | null = null;
		let valid = true;
		for (const [index, part] of parts.entries()) {
			current = posix.join(current, part);
			candidateInfo = await lstatSafe(current);
			if (
				!candidateInfo ||
				candidateInfo.kind !== (index === parts.length - 1 ? "file" : "directory")
			) {
				valid = false;
				break;
			}
		}
		if (!valid || candidateInfo?.kind !== "file") continue;
		if (candidateInfo.size === expectedSize) return "exact";
		if (candidateInfo.size > expectedSize) foundLarger = true;
		else foundSmaller = true;
	}
	return foundLarger ? "larger" : foundSmaller ? "smaller" : "missing";
}

function torrentInventoryFingerprint(
	torrents: ReadonlyArray<Pick<QuiTorrent, "instanceId" | "hash" | "name" | "savePath" | "size">>,
): string {
	return JSON.stringify(
		torrents
			.map((torrent) =>
				JSON.stringify([
					torrent.instanceId ?? null,
					torrent.hash.toLowerCase(),
					torrent.name,
					torrent.savePath,
					torrent.size,
				]),
			)
			.sort(),
	);
}

/** Digest the canonical listing without persisting its private names or paths. */
export function fingerprintQuiTorrentInventory(
	torrents: ReadonlyArray<Pick<QuiTorrent, "instanceId" | "hash" | "name" | "savePath" | "size">>,
): string {
	return createHash("sha256").update(torrentInventoryFingerprint(torrents)).digest("hex");
}

function assertCompleteFileIdIndex(index: FileIdIndex): void {
	if (index.skippedUnstatable > 0 || (index.incompleteDirectoryWalks ?? 0) > 0) {
		throw new Error(
			`qUI inode inventory was incomplete (${index.skippedUnstatable} unreachable torrents, ${index.incompleteDirectoryWalks ?? 0} incomplete directory walks)`,
		);
	}
}

async function assertStableFileSystemSnapshot(index: FileIdIndex): Promise<void> {
	if (!index.stabilityMarkers) {
		throw new Error("qUI inode inventory has no filesystem stability markers");
	}
	for (const [path, expected] of index.stabilityMarkers) {
		const current = await statSafe(path);
		if (!current || !sameFileSystemMarker(expected, current)) {
			throw new Error("qUI torrent filesystem changed during inode verification");
		}
	}
	for (const [path, expected] of index.fallbackPathMarkers ?? []) {
		const current = await lstatSafe(path);
		if (!current || !sameFileSystemMarker(expected, current)) {
			throw new Error("qUI fallback file changed during destructive verification");
		}
	}
}

/**
 * Walk every file under `rootPath` and add hardlinked entries to the
 * index. Returns per-call stats so the caller can aggregate.
 *
 * Mirrors qui's per-file indexing semantics: every file is stat'd, every
 * `nlink >= 2` file is recorded under the torrent's hash. We use
 * `fs.readdir({ recursive: true, withFileTypes: true })` so the walk is
 * a single syscall sequence at the OS level. Capped at
 * `MAX_WALK_ENTRIES_PER_TORRENT` to guard against pathological inputs.
 *
 * Errors per-file are swallowed — a single unreadable file shouldn't
 * abort the entire torrent's indexing.
 */
async function indexDirectoryFiles(
	rootPath: string,
	hash: string,
	addHash: (key: string, hash: string, info: StatInfo) => void,
	stabilityMarkers?: Map<string, FileSystemMarker>,
	includeSingleLinks = false,
): Promise<{
	statted: number;
	skippedNoLinks: number;
	complete: boolean;
	issues: DirectoryWalkIssues;
	entriesSeen: number;
}> {
	let statted = 0;
	let skippedNoLinks = 0;
	let complete = true;
	const issues = emptyDirectoryWalkIssues();

	let entries: Dirent[];
	try {
		entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
	} catch {
		issues.readFailures++;
		return { statted, skippedNoLinks, complete: false, issues, entriesSeen: 0 };
	}

	if (stabilityMarkers) {
		const directoryPaths = new Set([rootPath]);
		for (const entry of entries) {
			directoryPaths.add(entry.parentPath);
			if (entry.isDirectory()) {
				directoryPaths.add(`${entry.parentPath}/${entry.name}`);
			}
		}
		for (const directoryPath of directoryPaths) {
			if (stabilityMarkers.has(directoryPath)) continue;
			const directoryInfo = await statSafe(directoryPath);
			if (directoryInfo?.kind !== "directory") {
				complete = false;
				issues.stabilityFailures++;
				continue;
			}
			stabilityMarkers.set(directoryPath, toFileSystemMarker(directoryInfo));
		}

		let verifiedEntries: Dirent[];
		try {
			verifiedEntries = await readdir(rootPath, {
				recursive: true,
				withFileTypes: true,
			});
		} catch {
			issues.readFailures++;
			return { statted, skippedNoLinks, complete: false, issues, entriesSeen: entries.length };
		}
		if (directoryEntriesFingerprint(entries) !== directoryEntriesFingerprint(verifiedEntries)) {
			issues.stabilityFailures++;
			return { statted, skippedNoLinks, complete: false, issues, entriesSeen: entries.length };
		}
		entries = verifiedEntries;
	}

	// Cap the walk so a misconfigured torrent pointing at a media root
	// can't blow up the index build. qBit refuses to add torrents with
	// pathologically many files anyway; this cap is defense-in-depth.
	const limited =
		entries.length > MAX_WALK_ENTRIES_PER_TORRENT
			? entries.slice(0, MAX_WALK_ENTRIES_PER_TORRENT)
			: entries;
	if (limited.length !== entries.length) {
		complete = false;
		issues.entryLimitExceeded++;
	}

	for (const entry of limited) {
		if (entry.isDirectory()) continue;
		if (!entry.isFile()) {
			// readdir does not follow symbolic links. Skipping a symlink (or
			// another unsupported non-directory entry) would let a destructive
			// inventory claim completeness without indexing content qBit may
			// still be reading through that entry.
			complete = false;
			issues.unsupportedEntries++;
			continue;
		}
		// `parentPath` is always present on Node 20.12+. We target Node 22
		// (Dockerfile uses node:22-alpine3.21), so no fallback needed.
		const filePath = `${entry.parentPath}/${entry.name}`;
		const info = await statSafe(filePath);
		if (!info) {
			complete = false;
			issues.entryStatFailures++;
			issues.entryMissing++;
			continue;
		}
		if (info.kind !== "file") {
			complete = false;
			issues.entryStatFailures++;
			issues.entryKindMismatches++;
			continue;
		}
		if (info.nlink < 2 && !includeSingleLinks) {
			skippedNoLinks++;
			continue;
		}
		addHash(`${info.dev}:${info.ino}`, hash, info);
		statted++;
	}

	return { statted, skippedNoLinks, complete, issues, entriesSeen: entries.length };
}

function directoryEntriesFingerprint(entries: Dirent[]): string {
	return JSON.stringify(
		entries
			.map((entry): [string, string] => [
				`${entry.parentPath}/${entry.name}`,
				entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
			])
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/**
 * Stat a library file and look up its (dev, ino) in the index. Returns
 * the matching qui torrent hash on a hit, null on miss.
 *
 * We don't apply `pathPrefix` here because library paths come from *arr,
 * not from qui — *arr paths are assumed to be stat-able as-is from
 * arr-dashboard's view. If your *arr container reports paths that
 * arr-dashboard can't see, the inode strategy will produce no matches
 * for that library and the heuristic ladder takes over (assuming the
 * qui instance has `hasLocalFilesystemAccess = false`).
 */
export async function matchLibraryByFileId(
	libraryPath: string,
	index: FileIdIndex,
): Promise<InodeMatchResult | null> {
	const info = await statSafe(libraryPath);
	if (info?.kind !== "file") return null;
	if (info.nlink < 2) return null;
	const hashes = index.byFileId.get(`${info.dev}:${info.ino}`);
	if (!hashes || hashes.size === 0) return null;
	// The index can now hold multiple hashes per inode (cross-seeded
	// content across trackers). The library_cache.infoHash column is
	// single-valued, so this matcher returns ONE canonical hash —
	// iteration-order first, which is the order hashes were inserted
	// (qui's torrent enumeration order). The series-torrents panel
	// uses `getAllHashesForFileId` to see the full set; this single-
	// hash semantics is just for the backfill sweeps.
	const canonical = hashes.values().next().value;
	if (!canonical) return null;
	return { hash: canonical, source: "inode" };
}

/**
 * Return EVERY torrent hash that shares an inode with the given path.
 * Used by the series-torrents panel to surface all cross-seeds of a
 * library file — not just the one that happened to win the Map.set()
 * race during indexing.
 *
 * Caller is responsible for ordering the returned array if they want
 * deterministic display; the Set's iteration order matches insertion,
 * which is qui's torrent enumeration order (typically alphabetical or
 * by add date, depending on qui's caching).
 */
export async function getAllHashesForFileId(
	libraryPath: string,
	index: FileIdIndex,
): Promise<string[]> {
	return (await getAllHashesForFileIdWithPathEvidence(libraryPath, index)).hashes;
}

/** Display lookup that preserves whether a missing hash was actually observable. */
export async function getAllHashesForFileIdWithPathEvidence(
	libraryPath: string,
	index: FileIdIndex,
): Promise<{ hashes: string[]; pathVerified: boolean; correlationComplete: boolean }> {
	const info = await statSafe(libraryPath);
	if (info?.kind !== "file") {
		return { hashes: [], pathVerified: false, correlationComplete: false };
	}
	if (info.nlink < 2) {
		return { hashes: [], pathVerified: true, correlationComplete: false };
	}
	const hashes = index.byFileId.get(`${info.dev}:${info.ino}`);
	return {
		hashes: hashes ? Array.from(hashes) : [],
		pathVerified: true,
		correlationComplete: true,
	};
}

export interface CompleteFileIdHashResolution {
	hashes: string[];
	complete: true;
}

/**
 * Resolve all inode-sharing hashes while preserving whether the target path
 * itself could be verified. This is intentionally separate from the lenient
 * display/backfill helper above: destructive cleanup must fail closed on an
 * unreadable path instead of treating it as "no matches".
 */
export async function getAllHashesForFileIdComplete(
	libraryPath: string,
	index: FileIdIndex,
): Promise<CompleteFileIdHashResolution> {
	if (index.skippedUnstatable > 0 || (index.incompleteDirectoryWalks ?? 0) > 0) {
		throw new Error("qUI inode inventory is incomplete");
	}
	let info: StatInfo;
	try {
		const value = await stat(libraryPath);
		info = {
			dev: value.dev,
			ino: value.ino,
			nlink: value.nlink,
			size: value.size,
			ctimeMs: value.ctimeMs,
			mtimeMs: value.mtimeMs,
			kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other",
		};
	} catch {
		throw new Error("Target media path could not be stat'd");
	}
	if (info.kind !== "file") {
		throw new Error("Target media path is not a file");
	}
	const fileId = `${info.dev}:${info.ino}`;
	const hashes = Array.from(index.byFileId.get(fileId) ?? []);
	const marker = index.inodeMarkers?.get(fileId);
	if (hashes.length > 0 && (!marker || !sameFileSystemMarker(marker, info))) {
		throw new Error("Target media inode changed after qUI inventory verification");
	}
	return {
		hashes,
		complete: true,
	};
}

interface StatInfo {
	dev: number;
	ino: number;
	nlink: number;
	size: number;
	ctimeMs: number;
	mtimeMs: number;
	kind: "file" | "directory" | "other";
}

function toFileSystemMarker(info: StatInfo): FileSystemMarker {
	return {
		dev: info.dev,
		ino: info.ino,
		nlink: info.nlink,
		size: info.size,
		ctimeMs: info.ctimeMs,
		mtimeMs: info.mtimeMs,
		kind: info.kind,
	};
}

function sameFileSystemMarker(expected: FileSystemMarker, current: StatInfo): boolean {
	return (
		expected.dev === current.dev &&
		expected.ino === current.ino &&
		expected.nlink === current.nlink &&
		expected.size === current.size &&
		expected.ctimeMs === current.ctimeMs &&
		expected.mtimeMs === current.mtimeMs &&
		expected.kind === current.kind
	);
}

/**
 * Thin wrapper over fs.stat that returns null on any error instead of
 * throwing. We don't care WHY a path can't be stat'd — ENOENT means the
 * torrent moved, EACCES means the mount isn't readable, EIO means the
 * disk hiccup'd. None of these are recoverable here, and all of them
 * mean "no match" for this row. The caller logs aggregate counts.
 *
 * Returns `kind` so the caller can branch between "single file" (index
 * directly) and "directory" (walk inside) without re-stating.
 */
async function statSafe(path: string): Promise<StatInfo | null> {
	try {
		const s = await stat(path);
		const kind: StatInfo["kind"] = s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
		return {
			dev: Number(s.dev),
			ino: Number(s.ino),
			nlink: Number(s.nlink),
			size: Number(s.size),
			ctimeMs: Number(s.ctimeMs),
			mtimeMs: Number(s.mtimeMs),
			kind,
		};
	} catch {
		return null;
	}
}

/** Reject symlinks at every declared fallback-file path component. */
async function lstatSafe(path: string): Promise<StatInfo | null> {
	try {
		const s = await lstat(path);
		const kind: StatInfo["kind"] = s.isFile() ? "file" : s.isDirectory() ? "directory" : "other";
		return {
			dev: Number(s.dev),
			ino: Number(s.ino),
			nlink: Number(s.nlink),
			size: Number(s.size),
			ctimeMs: Number(s.ctimeMs),
			mtimeMs: Number(s.mtimeMs),
			kind,
		};
	} catch {
		return null;
	}
}

/**
 * Drop the cached index for a specific instance, or all instances if
 * `instanceId` is omitted. Used by tests and by routes that mutate
 * `hasLocalFilesystemAccess` or `pathPrefix` (the new config invalidates
 * the previous index immediately, no waiting 2 minutes).
 */
export function clearFileIdIndexCache(instanceId?: string): void {
	if (instanceId) {
		INDEX_EPOCH.set(instanceId, indexEpoch(instanceId) + 1);
		INDEX_CACHE.delete(instanceId);
		INDEX_PENDING.delete(instanceId);
		LEGACY_UPGRADE_RETRY_AFTER.delete(instanceId);
	} else {
		for (const id of new Set([
			...INDEX_CACHE.keys(),
			...INDEX_PENDING.keys(),
			...LEGACY_UPGRADE_RETRY_AFTER.keys(),
		])) {
			INDEX_EPOCH.set(id, indexEpoch(id) + 1);
		}
		INDEX_CACHE.clear();
		INDEX_PENDING.clear();
		LEGACY_UPGRADE_RETRY_AFTER.clear();
	}
}

/** Read generic cached coverage without triggering filesystem or provider work. */
export function readCachedFileIdCoverage(instance: { id: string; connectionGeneration: number }): {
	builtAtMs: number;
	inventoryComplete: boolean;
	skippedUnstatable: number;
	incompleteDirectoryWalks: number;
	issues: FileIdCoverageIssue[];
	torrentInventoryFingerprint: string;
} | null {
	const cached = INDEX_CACHE.get(instance.id);
	if (!cached) return null;
	const index = cached.index;
	if (
		index.sourceConnectionGeneration !== instance.connectionGeneration ||
		index.fallbackOwnershipVersion !== FALLBACK_OWNERSHIP_VERSION ||
		typeof index.inventoryComplete !== "boolean" ||
		!Number.isSafeInteger(index.skippedUnstatable) ||
		!Number.isSafeInteger(index.incompleteDirectoryWalks) ||
		!Array.isArray(index.issues) ||
		!index.issues.every(isFileIdCoverageIssue) ||
		!isTorrentInventoryFingerprint(index.torrentInventoryFingerprint) ||
		index.issues.length !== index.skippedUnstatable + index.incompleteDirectoryWalks!
	) {
		return null;
	}
	return {
		builtAtMs: cached.builtAt,
		inventoryComplete: index.inventoryComplete,
		skippedUnstatable: index.skippedUnstatable,
		incompleteDirectoryWalks: index.incompleteDirectoryWalks!,
		issues: index.issues,
		torrentInventoryFingerprint: index.torrentInventoryFingerprint,
	};
}

export const __testOnly = {
	applyPathRewrite,
	clearCache: () => {
		clearFileIdIndexCache();
	},
	INDEX_TTL_MS,
	MAX_WALK_ENTRIES_PER_TORRENT,
	peekCache: (instanceId: string): CachedIndex | undefined => INDEX_CACHE.get(instanceId),
	primeCache: (instanceId: string, entry: CachedIndex): void => {
		INDEX_CACHE.set(instanceId, entry);
	},
};

export type { QuiTorrent };

void getErrorMessage;
