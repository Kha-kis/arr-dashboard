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
 *  - qui's `LinkInfo` returns `(fileID, nlink, err)`; we early-out when
 *    `nlink == 1` because a file with one link has no hardlinks elsewhere
 *    and can't correlate to anything.
 *  - qui's `addTorrentFilesToFileIDIndex` walks each torrent's FILE list
 *    (from qBit's API) and stats every file. We do the same by walking
 *    the directory tree under each torrent's content path — when the
 *    content path is a folder (folder-wrapped releases, season packs,
 *    album packs, etc.), every file inside is stat'd and indexed under
 *    the torrent's hash. This is essential because qui's hardlink-mode
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

import { readdir, stat } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import type { QuiTorrent } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import type { QuiClient } from "../qui/client-factory.js";
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
	/** Map from `"dev:ino"` → set of torrent hashes that share this inode. */
	byFileId: Map<string, Set<string>>;
	/** Number of file→hash associations added (one per torrent file). */
	statted: number;
	/** Number of files skipped because `nlink == 1` (no hardlinks possible). */
	skippedNoLinks: number;
	/** Number of torrents whose root content path couldn't be stat'd. */
	skippedUnstatable: number;
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
const INDEX_PENDING = new Map<string, Promise<FileIdIndex>>();

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
		statted: index.statted,
		skippedNoLinks: index.skippedNoLinks,
		skippedUnstatable: index.skippedUnstatable,
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
			statted: number;
			skippedNoLinks: number;
			skippedUnstatable: number;
			entries: Array<[string, string[]]>;
		};
		if (data.v !== 1) return null;
		const byFileId = new Map<string, Set<string>>();
		for (const [key, hashes] of data.entries) {
			byFileId.set(key, new Set(hashes));
		}
		return {
			byFileId,
			statted: data.statted,
			skippedNoLinks: data.skippedNoLinks,
			skippedUnstatable: data.skippedUnstatable,
		};
	} catch {
		return null;
	}
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
		select: { builtAt: true, serializedData: true },
	});
	if (!row) return null;
	const buf = Buffer.isBuffer(row.serializedData)
		? row.serializedData
		: Buffer.from(row.serializedData);
	const index = deserializeFileIdIndex(buf);
	if (!index) return null;
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
): Promise<void> {
	try {
		const serialized = serializeFileIdIndex(index);
		// Prisma's Bytes type wants `Uint8Array<ArrayBuffer>`. Node Buffer
		// is `Uint8Array<ArrayBufferLike>`. Allocate a fresh ArrayBuffer
		// (not the SharedArrayBuffer-permissible union) and copy into it.
		const ab = new ArrayBuffer(serialized.byteLength);
		const bytes = new Uint8Array(ab);
		bytes.set(serialized);
		await prisma.inodeIndexCache.upsert({
			where: { instanceId },
			create: {
				instanceId,
				builtAt: new Date(),
				filesIndexed: index.statted,
				serializedData: bytes,
			},
			update: {
				builtAt: new Date(),
				filesIndexed: index.statted,
				serializedData: bytes,
			},
		});
		log?.info(
			{ instanceId, filesIndexed: index.statted, bytes: serialized.length },
			"inode-index: persisted snapshot to DB",
		);
	} catch (err) {
		log?.warn(
			{ err, instanceId },
			"inode-index: persistence write failed (non-fatal; rebuild will retry)",
		);
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
	try {
		const rows = await prisma.inodeIndexCache.findMany({
			select: { instanceId: true, builtAt: true, serializedData: true, filesIndexed: true },
		});
		for (const row of rows) {
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
			INDEX_CACHE.set(row.instanceId, { index, builtAt: row.builtAt.getTime() });
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
 * Mirrors qui's `addTorrentFilesToFileIDIndex` but reads files via
 * filesystem walk instead of qBit's per-torrent files API — same end
 * state, no extra HTTP round-trips.
 *
 * Files with `nlink == 1` are skipped (no hardlinks → can't correlate
 * to anything). Files we can't stat are skipped silently — a single
 * unreadable file in a torrent shouldn't kill the index build.
 */
export async function buildFileIdIndex(
	client: QuiClient,
	instance: Pick<ServiceInstance, "id" | "label" | "pathPrefix">,
	log?: FastifyBaseLogger,
	/**
	 * Optional Prisma client. When provided, successful builds are
	 * persisted to the `InodeIndexCache` table so the next server
	 * startup can hydrate immediately via `hydrateFileIdIndexFromDb`.
	 * Omitted in unit tests that don't need DB-side effects.
	 */
	prisma?: PrismaClient,
): Promise<FileIdIndex> {
	const cached = INDEX_CACHE.get(instance.id);
	if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
		return cached.index;
	}

	// In-flight dedup: if a build is already running for this instance,
	// await it instead of kicking off a parallel one. The previous code
	// had no dedup, so concurrent panel loads after a cold start would
	// each spawn their own `listAllTorrents` + ~50k stat ops in parallel
	// — saturating both qui and the FS until everything timed out.
	const pending = INDEX_PENDING.get(instance.id);
	if (pending) return pending;

	const buildPromise = (async (): Promise<FileIdIndex> => {
		const built = await doBuildFileIdIndex(client, instance, log);
		INDEX_CACHE.set(instance.id, { index: built, builtAt: Date.now() });
		// Persist asynchronously — caller doesn't need to wait on the
		// DB write, and a failed persist is non-fatal (next rebuild
		// will retry). Floating Promise is intentional.
		if (prisma) {
			void saveFileIdIndexToDb(prisma, instance.id, built, log);
		}
		return built;
	})();
	INDEX_PENDING.set(instance.id, buildPromise);
	try {
		return await buildPromise;
	} finally {
		INDEX_PENDING.delete(instance.id);
	}
}

async function doBuildFileIdIndex(
	client: QuiClient,
	instance: Pick<ServiceInstance, "id" | "label" | "pathPrefix">,
	log?: FastifyBaseLogger,
): Promise<FileIdIndex> {
	const torrents = await client.listAllTorrents();
	const byFileId = new Map<string, Set<string>>();
	let statted = 0;
	let skippedNoLinks = 0;
	let skippedUnstatable = 0;
	let firstStatErrorLogged = false;

	// Helper: add a hash to the set at this FileID key, creating the set
	// if needed. Centralized so the single-file and directory branches
	// stay consistent.
	const addHash = (key: string, hash: string): void => {
		const existing = byFileId.get(key);
		if (existing) {
			existing.add(hash);
		} else {
			byFileId.set(key, new Set([hash]));
		}
	};

	for (const torrent of torrents) {
		const trimmed = torrent.savePath ? torrent.savePath.replace(/\/+$/, "") : "";
		if (!trimmed) {
			skippedUnstatable++;
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
		for (const rootPath of candidates) {
			const rootInfo = await statSafe(rootPath);
			if (!rootInfo) continue;
			resolved = true;

			if (rootInfo.kind === "file") {
				if (rootInfo.nlink < 2) {
					skippedNoLinks++;
				} else {
					addHash(`${rootInfo.dev}:${rootInfo.ino}`, torrent.hash);
					statted++;
				}
			} else if (rootInfo.kind === "directory") {
				const stats = await indexDirectoryFiles(rootPath, torrent.hash, addHash);
				statted += stats.statted;
				skippedNoLinks += stats.skippedNoLinks;
			}
			break;
		}

		if (!resolved) {
			skippedUnstatable++;
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
	}

	const index: FileIdIndex = { byFileId, statted, skippedNoLinks, skippedUnstatable };
	// Cache write happens in the buildFileIdIndex wrapper (after this
	// function resolves) so the in-flight Promise dedup stays consistent.
	log?.info(
		{
			quiInstanceId: instance.id,
			torrents: torrents.length,
			filesIndexed: statted,
			skippedNoLinks,
			skippedUnstatable,
		},
		"inode-backfill: built FileID index",
	);
	return index;
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
	addHash: (key: string, hash: string) => void,
): Promise<{ statted: number; skippedNoLinks: number }> {
	let statted = 0;
	let skippedNoLinks = 0;

	let entries;
	try {
		entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
	} catch {
		return { statted, skippedNoLinks };
	}

	// Cap the walk so a misconfigured torrent pointing at a media root
	// can't blow up the index build. qBit refuses to add torrents with
	// pathologically many files anyway; this cap is defense-in-depth.
	const limited =
		entries.length > MAX_WALK_ENTRIES_PER_TORRENT
			? entries.slice(0, MAX_WALK_ENTRIES_PER_TORRENT)
			: entries;

	for (const entry of limited) {
		if (!entry.isFile()) continue;
		// `parentPath` is always present on Node 20.12+. We target Node 22
		// (Dockerfile uses node:22-alpine3.21), so no fallback needed.
		const filePath = `${entry.parentPath}/${entry.name}`;
		const info = await statSafe(filePath);
		if (!info || info.kind !== "file") continue;
		if (info.nlink < 2) {
			skippedNoLinks++;
			continue;
		}
		addHash(`${info.dev}:${info.ino}`, hash);
		statted++;
	}

	return { statted, skippedNoLinks };
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
	if (!info || info.kind !== "file") return null;
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
	const info = await statSafe(libraryPath);
	if (!info || info.kind !== "file") return [];
	if (info.nlink < 2) return [];
	const hashes = index.byFileId.get(`${info.dev}:${info.ino}`);
	if (!hashes) return [];
	return Array.from(hashes);
}

interface StatInfo {
	dev: number;
	ino: number;
	nlink: number;
	kind: "file" | "directory" | "other";
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
		return { dev: Number(s.dev), ino: Number(s.ino), nlink: Number(s.nlink), kind };
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
		INDEX_CACHE.delete(instanceId);
	} else {
		INDEX_CACHE.clear();
	}
}

export const __testOnly = {
	applyPathRewrite,
	clearCache: () => INDEX_CACHE.clear(),
	INDEX_TTL_MS,
	MAX_WALK_ENTRIES_PER_TORRENT,
	peekCache: (instanceId: string): CachedIndex | undefined => INDEX_CACHE.get(instanceId),
	primeCache: (instanceId: string, entry: CachedIndex): void => {
		INDEX_CACHE.set(instanceId, entry);
	},
};

export type { QuiTorrent };

void getErrorMessage;
