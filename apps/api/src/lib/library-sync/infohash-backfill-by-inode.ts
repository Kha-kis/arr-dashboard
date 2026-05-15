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
 *  - qui caches their HardlinkIndex for 2 minutes; we use the same TTL.
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
import type { QuiTorrent } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ServiceInstance } from "../prisma.js";
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
 * strings to match Map's structural-equality semantics. We never iterate
 * the index — only `.get()` — so the string key cost is negligible.
 */
export interface FileIdIndex {
	/** Map from `"dev:ino"` → torrent hash. */
	byFileId: Map<string, string>;
	/** Number of files successfully stat'd and indexed (with `nlink >= 2`). */
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
const INDEX_TTL_MS = 2 * 60 * 1000;

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
): Promise<FileIdIndex> {
	const cached = INDEX_CACHE.get(instance.id);
	if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
		return cached.index;
	}

	const torrents = await client.listAllTorrents();
	const byFileId = new Map<string, string>();
	let statted = 0;
	let skippedNoLinks = 0;
	let skippedUnstatable = 0;
	let firstStatErrorLogged = false;

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
					byFileId.set(`${rootInfo.dev}:${rootInfo.ino}`, torrent.hash);
					statted++;
				}
			} else if (rootInfo.kind === "directory") {
				const stats = await indexDirectoryFiles(rootPath, torrent.hash, byFileId);
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
	INDEX_CACHE.set(instance.id, { index, builtAt: Date.now() });
	log?.debug(
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
	byFileId: Map<string, string>,
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
		byFileId.set(`${info.dev}:${info.ino}`, hash);
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
	const hash = index.byFileId.get(`${info.dev}:${info.ino}`);
	if (!hash) return null;
	return { hash, source: "inode" };
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
