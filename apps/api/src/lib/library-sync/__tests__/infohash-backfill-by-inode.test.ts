/**
 * Unit tests for the inode-based infoHash backfill helpers.
 *
 * The strategy is the verified-truth pass: when a qui instance has
 * `hasLocalFilesystemAccess === true`, we stat the torrent's content path
 * (and walk into it if it's a directory) and compare (st_dev, st_ino)
 * with library files' inodes. These tests pin the matching semantics by
 * mocking `node:fs/promises` to return controlled stat + readdir results.
 *
 * What we lock in:
 *   - Same (dev, ino) → match (single-file torrent path).
 *   - Same ino, different dev → NO match (POSIX inode uniqueness is
 *     per-filesystem; two files with the same inode number on different
 *     mounts are unrelated).
 *   - nlink == 1 on either side → no match (file has no hardlinks).
 *   - Stat error on either side → no match, no throw.
 *   - Path prefix rewrite applies to qui-reported paths.
 *   - Cache TTL behavior (hit within 2 min, miss after).
 *   - **Folder-wrapped torrents:** when the qui content path is a
 *     directory, we walk inside and index every hardlinked file. This is
 *     the multi-file fix that makes qui's hardlink-mode cross-seed
 *     layout work — those torrents wrap every file in a `Name--hash/`
 *     folder, and the old "stat root only" logic indexed the folder
 *     inode instead of the file inode.
 *   - Recursive directory walk works (season packs with subdirectories).
 *   - Per-torrent walk cap (MAX_WALK_ENTRIES_PER_TORRENT) prevents a
 *     pathological torrent from exploding the index.
 */

import type { Dirent } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { QuiTorrent } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { attachProviderContentPath } from "../../qui/torrent-content-path.js";

// Mock fs/promises BEFORE importing the module under test. The mocks
// return whatever we've staged via `stagedStats` / `stagedDirs`.
vi.mock("node:fs/promises", () => ({
	stat: vi.fn(async (path: string) => {
		statHook?.(path);
		const info = stagedStats.get(path);
		if (!info) {
			const err = new Error(`ENOENT: no such file '${path}'`);
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
		return {
			dev: info.dev,
			ino: info.ino,
			nlink: info.nlink,
			ctimeMs: info.ctimeMs,
			mtimeMs: info.mtimeMs,
			size: info.size ?? 1_000_000,
			isFile: () => info.type === "file",
			isDirectory: () => info.type === "directory",
		};
	}),
	lstat: vi.fn(async (path: string) => {
		const info = stagedStats.get(path);
		if (!info) {
			const err = new Error(`ENOENT: no such file '${path}'`);
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
		return {
			dev: info.dev,
			ino: info.ino,
			nlink: info.nlink,
			ctimeMs: info.ctimeMs,
			mtimeMs: info.mtimeMs,
			size: info.size ?? 1_000_000,
			isFile: () => info.type === "file",
			isDirectory: () => info.type === "directory",
		};
	}),
	readdir: vi.fn(async (path: string, _opts?: unknown) => {
		const children = stagedDirs.get(path);
		if (!children) {
			const err = new Error(`ENOENT: no such directory '${path}'`);
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
		// We always ask for { recursive: true, withFileTypes: true } in the
		// production code. The mock honors that contract: returns Dirent-like
		// objects with `isFile()`, `name`, and `parentPath`. The caller pre-
		// flattens its recursive children when staging, so we don't have to
		// walk subdirectories here.
		return children.map((child) => ({
			name: child.name,
			parentPath: child.parentPath,
			path: child.parentPath, // back-compat alias
			isFile: () => child.type === "file",
			isDirectory: () => child.type === "directory",
			isSymbolicLink: () => child.type === "symlink",
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isFIFO: () => false,
			isSocket: () => false,
		})) as unknown as Dirent[];
	}),
}));

interface StagedStat {
	dev: number;
	ino: number;
	nlink: number;
	ctimeMs: number;
	mtimeMs: number;
	size?: number;
	type: "file" | "directory";
}
interface StagedChild {
	name: string;
	parentPath: string;
	type: "file" | "directory" | "symlink";
}

const stagedStats = new Map<string, StagedStat>();
const stagedDirs = new Map<string, StagedChild[]>();
let statHook: ((path: string) => void) | null = null;

import {
	__testOnly,
	applyPathRewrite,
	buildFileIdIndex,
	buildFreshCompleteFileIdIndex,
	clearFileIdIndexCache,
	deserializeFileIdIndex,
	type FileIdIndex,
	fingerprintQuiTorrentInventory,
	getAllHashesForFileId,
	getAllHashesForFileIdComplete,
	hydrateFileIdIndexFromDb,
	loadFileIdIndexFromDb,
	matchLibraryByFileId,
	readCachedFileIdCoverage,
	serializeFileIdIndex,
} from "../infohash-backfill-by-inode.js";

interface FakeQuiClient {
	listAllTorrents: ReturnType<typeof vi.fn>;
	getTorrentFiles: ReturnType<typeof vi.fn>;
}

function makeFakeClient(torrents: QuiTorrent[]): FakeQuiClient {
	return {
		listAllTorrents: vi.fn(async () => torrents),
		getTorrentFiles: vi.fn(async () => []),
	};
}

function makeQuiTorrent(o: {
	hash: string;
	name: string;
	savePath: string;
	size?: number;
	instanceId?: number;
}): QuiTorrent {
	return {
		hash: o.hash,
		name: o.name,
		savePath: o.savePath,
		size: o.size ?? 1_000_000,
		instanceId: o.instanceId,
		state: "uploading",
		ratio: 1,
		progress: 1,
		numSeeds: 0,
		numLeechs: 0,
		tags: [],
		category: "",
		addedOn: 0,
		completedOn: null,
		seedingTime: 0,
		eta: 0,
		dlSpeed: 0,
		upSpeed: 0,
		priority: 0,
	};
}

/**
 * Stage a single file at `path` with the given inode/link metadata.
 * Files are leaves — they never appear in `stagedDirs`.
 */
function stageFile(path: string, dev: number, ino: number, nlink: number, changedAt = ino): void {
	stagedStats.set(path, {
		dev,
		ino,
		nlink,
		ctimeMs: changedAt,
		mtimeMs: changedAt,
		type: "file",
	});
}

/**
 * Stage a directory at `dirPath` containing flat-list `fileNames`. Each
 * filename gets its own (dev, ino, nlink) entry — the test author owns
 * the inode numbers, so there's no implicit dev/ino mapping. Calls
 * `stageFile` for each child too.
 *
 * The mock's `readdir(dirPath, { recursive: true })` returns ALL
 * descendants in one flat list — so when the production code calls
 * recursive readdir, deeply-nested fixtures must be staged with their
 * full pre-flattened child list.
 */
function stageDir(
	dirPath: string,
	dev: number,
	ino: number,
	files: Array<{ name: string; ino: number; nlink: number; subdir?: string }>,
): void {
	stagedStats.set(dirPath, {
		dev,
		ino,
		nlink: 1,
		ctimeMs: ino,
		mtimeMs: ino,
		type: "directory",
	});
	const children: StagedChild[] = [];
	for (const f of files) {
		const parent = f.subdir ? `${dirPath}/${f.subdir}` : dirPath;
		const filePath = `${parent}/${f.name}`;
		stageFile(filePath, dev, f.ino, f.nlink);
		children.push({ name: f.name, parentPath: parent, type: "file" });
	}
	stagedDirs.set(dirPath, children);
}

const QUI_INSTANCE = {
	id: "qui-1",
	label: "qui-1",
	pathPrefix: null as string | null,
	connectionGeneration: 0,
};

beforeEach(() => {
	stagedStats.clear();
	stagedDirs.clear();
	statHook = null;
	__testOnly.clearCache();
});

describe("applyPathRewrite", () => {
	it("returns input unchanged when pathPrefix is null or empty", () => {
		expect(applyPathRewrite("/data/torrents/x.mkv", null)).toBe("/data/torrents/x.mkv");
		expect(applyPathRewrite("/data/torrents/x.mkv", "")).toBe("/data/torrents/x.mkv");
	});

	it("rewrites a matching prefix", () => {
		expect(applyPathRewrite("/downloads/movies/x.mkv", "/downloads>/qbit-data")).toBe(
			"/qbit-data/movies/x.mkv",
		);
	});

	it("returns input unchanged when the prefix does not apply", () => {
		expect(applyPathRewrite("/elsewhere/movies/x.mkv", "/downloads>/qbit-data")).toBe(
			"/elsewhere/movies/x.mkv",
		);
	});

	it("treats malformed config (no '>') as a no-op", () => {
		expect(applyPathRewrite("/downloads/x", "/downloads")).toBe("/downloads/x");
	});

	it("refuses to rewrite when the source half is empty (would replace everything)", () => {
		expect(applyPathRewrite("/x", ">/y")).toBe("/x");
	});
});

describe("buildFileIdIndex — single-file torrents", () => {
	it("normalizes qUI hashes before publishing inode evidence", async () => {
		stageFile("/data/torrents/Case.mkv", 100, 41, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: " ABCDEF ", name: "Case.mkv", savePath: "/data/torrents" }),
		]);

		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);

		expect(index.byFileId.get("100:41")).toEqual(new Set(["abcdef"]));
	});

	it("indexes single-file torrents at the full content path", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("100:42")).toEqual(new Set(["h1"]));
		expect(index.statted).toBe(1);
		expect(index.skippedNoLinks).toBe(0);
		expect(index.skippedUnstatable).toBe(0);
	});

	it("skips a single-file torrent with nlink == 1", async () => {
		stageFile("/data/torrents/Lonely.mkv", 100, 7, 1);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "lonely", name: "Lonely.mkv", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.skippedNoLinks).toBe(1);
		expect(index.statted).toBe(0);
	});

	it("skips a torrent whose root path cannot be stat'd (ENOENT)", async () => {
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "missing", name: "Gone.mkv", savePath: "/elsewhere" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.skippedUnstatable).toBe(1);
	});
});

describe("buildFileIdIndex — folder-wrapped torrents (THE BUG FIX)", () => {
	it("walks into a folder-wrapped torrent and indexes the .mkv inside (qui hardlink-mode cross-seed pattern)", async () => {
		// This is the canonical bug case: qui's hardlink-mode wraps every
		// cross-seed in `Name--shortHash/file.mkv`. The OLD code stat'd the
		// folder and indexed the FOLDER's inode (which never matches any
		// library file). The fix walks inside and indexes the .mkv.
		const torrentFolder =
			"/data/torrents/links/UHDBits/Atomic.Blonde.2017.REMUX-FraMeSToR--c4d4a86d";
		stageDir(torrentFolder, 61, 99999, [
			{ name: "Atomic.Blonde.2017.REMUX-FraMeSToR.mkv", ino: 80142, nlink: 6 },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "atomic",
				name: "Atomic.Blonde.2017.REMUX-FraMeSToR--c4d4a86d",
				savePath: "/data/torrents/links/UHDBits",
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		// THE PROOF: the .mkv's inode (80142) is in the index, NOT the
		// folder's inode (99999).
		expect(index.byFileId.get("61:80142")).toEqual(new Set(["atomic"]));
		expect(index.byFileId.get("61:99999")).toBeUndefined();
		expect(index.statted).toBe(1);
	});

	it("indexes multiple files in a season-pack-style multi-file torrent", async () => {
		const seasonFolder = "/data/torrents/tv/Some.Show.S01";
		stageDir(seasonFolder, 61, 100000, [
			{ name: "Some.Show.S01E01.mkv", ino: 1001, nlink: 2 },
			{ name: "Some.Show.S01E02.mkv", ino: 1002, nlink: 2 },
			{ name: "Some.Show.S01E03.mkv", ino: 1003, nlink: 2 },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "seasonpack",
				name: "Some.Show.S01",
				savePath: "/data/torrents/tv",
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		// All three episode inodes resolve to the same torrent hash —
		// any library file hardlinked to any of them correlates to the pack.
		expect(index.byFileId.get("61:1001")).toEqual(new Set(["seasonpack"]));
		expect(index.byFileId.get("61:1002")).toEqual(new Set(["seasonpack"]));
		expect(index.byFileId.get("61:1003")).toEqual(new Set(["seasonpack"]));
		expect(index.statted).toBe(3);
	});

	it("indexes deeply-nested files (recursive walk)", async () => {
		// Some torrents nest: `Show.S01/Season 01/S01E01.mkv`. readdir's
		// recursive flag finds all leaves; our prod code uses that flag.
		const torrentFolder = "/data/torrents/tv/Deep.Show.S01";
		stageDir(torrentFolder, 61, 200000, [
			{ name: "Deep.S01E01.mkv", ino: 2001, nlink: 2, subdir: "Season 01" },
			{ name: "Deep.S01E02.mkv", ino: 2002, nlink: 2, subdir: "Season 01" },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "deepshow",
				name: "Deep.Show.S01",
				savePath: "/data/torrents/tv",
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:2001")).toEqual(new Set(["deepshow"]));
		expect(index.byFileId.get("61:2002")).toEqual(new Set(["deepshow"]));
	});

	it("skips nlink==1 files inside a folder while indexing nlink>=2 siblings", async () => {
		// Common: a torrent folder contains the .mkv (hardlinked into library,
		// nlink=2) PLUS a .nfo and a .torrent file that aren't hardlinked
		// anywhere (nlink=1). The hardlinked .mkv must be indexed; the others
		// must be skipped so they don't pollute the map with single-link entries.
		const torrentFolder = "/data/torrents/movies/Some.Movie.2024.1080p";
		stageDir(torrentFolder, 61, 300000, [
			{ name: "Some.Movie.2024.1080p.mkv", ino: 3001, nlink: 2 },
			{ name: "Some.Movie.2024.1080p.nfo", ino: 3002, nlink: 1 },
			{ name: "release.torrent", ino: 3003, nlink: 1 },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "moviepack",
				name: "Some.Movie.2024.1080p",
				savePath: "/data/torrents/movies",
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:3001")).toEqual(new Set(["moviepack"]));
		expect(index.byFileId.get("61:3002")).toBeUndefined();
		expect(index.byFileId.get("61:3003")).toBeUndefined();
		expect(index.statted).toBe(1);
		expect(index.skippedNoLinks).toBe(2);
	});

	it("does NOT index the folder's own inode (only files inside)", async () => {
		// Defense-in-depth: even if a folder somehow had nlink>=2 (it can't
		// on POSIX, but old buggy logic recorded the folder anyway), we
		// only index file entries from the readdir result. This test pins
		// that contract by giving the folder nlink=2 (impossible IRL) and
		// confirming it doesn't end up in the map.
		const folder = "/data/torrents/weird";
		stageDir(folder, 61, 400000, [{ name: "x.mkv", ino: 4001, nlink: 2 }]);
		stagedStats.set(folder, {
			dev: 61,
			ino: 400000,
			nlink: 2,
			ctimeMs: 400000,
			mtimeMs: 400000,
			type: "directory",
		});
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h", name: "weird", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:400000")).toBeUndefined();
		expect(index.byFileId.get("61:4001")).toEqual(new Set(["h"]));
	});

	it("caps the walk at MAX_WALK_ENTRIES_PER_TORRENT entries", async () => {
		// Pathological case: a "torrent" that's somehow pointed at a media
		// root with thousands of files. We refuse to walk past the cap and
		// log a warning. This is qui-equivalent safety — qui never hits this
		// because qBit's file list is bounded by torrent size, but our fs
		// walk has no such inherent bound.
		const folder = "/data/torrents/huge";
		const tooMany = Array.from(
			{ length: __testOnly.MAX_WALK_ENTRIES_PER_TORRENT + 50 },
			(_, i) => ({
				name: `f${i}.mkv`,
				ino: 500_000 + i,
				nlink: 2,
			}),
		);
		stageDir(folder, 61, 500000, tooMany);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "huge", name: "huge", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		// Exactly MAX entries got indexed; the rest were silently dropped
		// by the cap.
		expect(index.statted).toBe(__testOnly.MAX_WALK_ENTRIES_PER_TORRENT);
		expect(index.walkIssues?.entryLimitExceeded).toBe(1);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.rootDiagnostics).toEqual({
			cappedPrimaryWalks: 1,
			cappedFallbackWalks: 0,
			largestCappedWalkEntries: __testOnly.MAX_WALK_ENTRIES_PER_TORRENT + 50,
		});
	});

	it("never scans a broad fallback save directory without torrent file evidence", async () => {
		const savePath = "/data/torrents";
		const entries = Array.from({ length: __testOnly.MAX_WALK_ENTRIES_PER_TORRENT + 1 }, (_, i) => ({
			name: `f${i}.mkv`,
			ino: 700_000 + i,
			nlink: 2,
		}));
		stageDir(savePath, 61, 700000, entries);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "fallback", name: "missing-content-root", savePath }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.byFileId.size).toBe(0);
		expect(index.walkIssues?.readFailures).toBe(1);
		expect(index.rootDiagnostics).toEqual({
			cappedPrimaryWalks: 0,
			cappedFallbackWalks: 0,
			largestCappedWalkEntries: 0,
		});
	});

	it("counts provider content paths in fallback cases without trusting them as ownership", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 710100, []);
		stageDir("/data/other-content", 61, 710101, []);
		const client = makeFakeClient([
			attachProviderContentPath(
				makeQuiTorrent({ hash: "fallback", name: "missing-root", savePath, instanceId: 7 }),
				"/data/other-content",
			),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "missing.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.contentPathDiagnostics).toMatchObject({
			present: 1,
			fallbackPresent: 1,
			fallbackDistinctFromSavePath: 1,
			fallbackStatable: 1,
		});
	});

	it("diagnoses an exact provider content file without publishing a failed fallback match", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 710200, [{ name: "owned.mkv", ino: 710201, nlink: 2 }]);
		stagedStats.get(`${savePath}/owned.mkv`)!.size = 2_000_000;
		stageFile("/data/actual/owned.mkv", 61, 710202, 2);
		const client = makeFakeClient([
			attachProviderContentPath(
				makeQuiTorrent({ hash: "fallback", name: "missing-root", savePath, instanceId: 7 }),
				"/data/actual/owned.mkv",
			),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.contentPathDiagnostics?.fallbackFailedFilesAltExact).toBe(1);
		expect(index.contentPathDiagnostics?.fallbackContentFileRoots).toBe(1);
		expect(index.walkIssues?.entrySizeMismatches).toBe(1);
	});

	it("classifies a provider content file with the same oversized drift as the fallback", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 710300, [{ name: "owned.mkv", ino: 710301, nlink: 2 }]);
		stagedStats.get(`${savePath}/owned.mkv`)!.size = 2_000_000;
		stageFile("/data/actual/renamed.mkv", 61, 710302, 2);
		stagedStats.get("/data/actual/renamed.mkv")!.size = 2_000_000;
		const client = makeFakeClient([
			attachProviderContentPath(
				makeQuiTorrent({ hash: "fallback", name: "missing-root", savePath, instanceId: 7 }),
				"/data/actual/renamed.mkv",
			),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.contentPathDiagnostics?.fallbackContentFileRoots).toBe(1);
		expect(index.contentPathDiagnostics?.fallbackFailedFilesAltLarger).toBe(1);
		expect(index.contentPathDiagnostics?.fallbackFailedFilesAltExact).toBe(0);
	});

	it("diagnoses a provider directory whose trailing components repeat in the file list", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 710400, []);
		stageDir(`${savePath}/Show`, 61, 710401, []);
		stageDir(`${savePath}/Show/Season`, 61, 710402, []);
		stageFile(`${savePath}/Show/Season/episode.mkv`, 61, 710403, 2);
		stagedStats.get(`${savePath}/Show/Season/episode.mkv`)!.size = 2_000_000;
		stageDir("/data/actual", 61, 710404, []);
		stageDir("/data/actual/Show", 61, 710405, []);
		stageDir("/data/actual/Show/Season", 61, 710406, []);
		stageFile("/data/actual/Show/Season/episode.mkv", 61, 710407, 2);
		const client = makeFakeClient([
			attachProviderContentPath(
				makeQuiTorrent({ hash: "nested-root", name: "missing-root", savePath, instanceId: 7 }),
				"/data/actual/Show/Season",
			),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "Show/Season/episode.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.contentPathDiagnostics?.fallbackFailedFilesAltExact).toBe(1);
	});

	it("indexes only the provider-declared file, not its fallback-directory sibling", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 710000, [
			{ name: "owned.mkv", ino: 710001, nlink: 2 },
			{ name: "unrelated.mkv", ino: 710002, nlink: 2 },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "owned-hash", name: "missing-content-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:710001")).toEqual(new Set(["owned-hash"]));
		expect(index.byFileId.get("61:710002")).toBeUndefined();
		expect(index.incompleteDirectoryWalks).toBe(0);
	});

	it("rejects a fallback file whose current size disagrees with qUI", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 715000, [{ name: "owned.mkv", ino: 715001, nlink: 2 }]);
		stagedStats.get(`${savePath}/owned.mkv`)!.size = 2_000_000;
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "stale-file", name: "missing-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.entrySizeMismatches).toBe(1);
		expect(index.walkIssues?.fallbackCompleteFileFailures).toBe(1);
		expect(index.walkIssues?.fallbackIncompleteFileFailures).toBe(0);
		expect(index.walkIssues?.fallbackSizeMismatchLarger).toBe(1);
		expect(index.walkIssues?.fallbackSizeMismatchOtherTorrent).toBe(1);
		expect(index.fallbackIssueDiagnostics).toMatchObject({
			sizeMismatchTorrents: 1,
			maxSizeMismatchesPerTorrent: 1,
			sizeMismatchDirectoryContentRoots: 0,
		});
	});

	it("groups multiple size disagreements under one failed torrent without exposing its identity", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 715100, [
			{ name: "first.mkv", ino: 715101, nlink: 2 },
			{ name: "second.mkv", ino: 715102, nlink: 2 },
		]);
		stagedStats.get(`${savePath}/first.mkv`)!.size = 2_000_000;
		stagedStats.get(`${savePath}/second.mkv`)!.size = 2_000_000;
		stageDir("/data/actual-content", 61, 715103, []);
		const client = makeFakeClient([
			attachProviderContentPath(
				makeQuiTorrent({ hash: "grouped-failure", name: "missing-root", savePath, instanceId: 7 }),
				"/data/actual-content",
			),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "first.mkv", size: 1_000_000, progress: 1, priority: 1 },
			{ index: 1, name: "second.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.fallbackIssueDiagnostics).toMatchObject({
			sizeMismatchTorrents: 1,
			maxSizeMismatchesPerTorrent: 2,
			sizeMismatchDirectoryContentRoots: 1,
		});
	});

	it("classifies a smaller completed file in qUI's missing-files state", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 715050, [{ name: "owned.mkv", ino: 715051, nlink: 2 }]);
		stagedStats.get(`${savePath}/owned.mkv`)!.size = 500_000;
		const client = makeFakeClient([
			{
				...makeQuiTorrent({ hash: "missing-files", name: "missing-root", savePath, instanceId: 7 }),
				state: "missingFiles",
			},
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.walkIssues?.fallbackSizeMismatchSmaller).toBe(1);
		expect(index.walkIssues?.fallbackSizeMismatchErrorTorrent).toBe(1);
	});

	it("counts missing provider-declared fallback files separately", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 715100, []);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "missing-file", name: "missing-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "missing.mkv", size: 1_000_000, progress: 0.5, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.entryMissing).toBe(1);
		expect(index.walkIssues?.fallbackIncompleteFileFailures).toBe(1);
		expect(index.walkIssues?.fallbackCompleteFileFailures).toBe(0);
	});

	it("never treats a fallback save path that is a file as torrent ownership", async () => {
		stageFile("/data/torrents", 61, 720001, 2);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "invalid-root",
				name: "missing-content-root",
				savePath: "/data/torrents",
				instanceId: 7,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.incompleteDirectoryWalks).toBe(1);
	});

	it("bounds fallback file-list requests when many torrent roots are ambiguous", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 730000, [{ name: "owned.mkv", ino: 730001, nlink: 2 }]);
		const client = makeFakeClient(
			Array.from({ length: 129 }, (_, i) =>
				makeQuiTorrent({ hash: `h-${i}`, name: `missing-root-${i}`, savePath, instanceId: 7 }),
			),
		);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(client.getTorrentFiles.mock.calls.length).toBeLessThanOrEqual(128);
		expect(index.incompleteDirectoryWalks).toBeGreaterThan(0);
		expect(index.byFileId.get("61:730001")?.has("h-128")).toBe(false);
	});

	it("refuses an oversized fallback file list without attempting a partial ownership claim", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 740000, [{ name: "owned.mkv", ino: 740001, nlink: 2 }]);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "large", name: "missing-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue(
			Array.from({ length: 5001 }, (_, index) => ({
				index,
				name: index === 0 ? "owned.mkv" : `other-${index}.mkv`,
				size: 1_000_000,
				progress: 1,
				priority: 1,
			})),
		);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.size).toBe(0);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.entryLimitExceeded).toBe(1);
	});

	it("counts unreadable directory walks without exposing their paths", async () => {
		const folder = "/data/torrents/unreadable";
		stageDir(folder, 61, 600000, []);
		stagedDirs.delete(folder);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h", name: "unreadable", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.readFailures).toBe(1);
	});

	it("counts unsupported entries while retaining positive siblings", async () => {
		const folder = "/data/torrents/links";
		stageDir(folder, 61, 600001, [{ name: "media.mkv", ino: 600002, nlink: 2 }]);
		stagedDirs.get(folder)?.push({ name: "link", parentPath: folder, type: "symlink" });
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h", name: "links", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:600002")).toEqual(new Set(["h"]));
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.unsupportedEntries).toBe(1);
	});

	it("counts files that disappear between readdir and stat", async () => {
		const folder = "/data/torrents/changing";
		stageDir(folder, 61, 600003, [{ name: "media.mkv", ino: 600004, nlink: 2 }]);
		stagedStats.delete(`${folder}/media.mkv`);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h", name: "changing", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.incompleteDirectoryWalks).toBe(1);
		expect(index.walkIssues?.entryStatFailures).toBe(1);
		expect(index.walkIssues?.entryMissing).toBe(1);
		expect(index.issues).toEqual([
			{
				hash: "h",
				qbitInstanceId: null,
				missingFiles: 1,
				sizeMismatches: 0,
				otherFailures: 0,
			},
		]);
	});

	it("attributes generic missing, size-mismatch, and unreadable walk counts to torrent scopes", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 61, 600010, []);
		stageFile(`${savePath}/large.mkv`, 61, 600021, 2);
		stageDir(`${savePath}/unreadable`, 61, 600030, []);
		stagedDirs.delete(`${savePath}/unreadable`);
		stagedStats.get(`${savePath}/large.mkv`)!.size = 2_000_000;
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "MISSING", name: "missing", savePath, instanceId: 7 }),
			makeQuiTorrent({ hash: "OVERSIZED", name: "no-primary-oversized", savePath, instanceId: 8 }),
			makeQuiTorrent({ hash: "UNREADABLE", name: "unreadable", savePath, instanceId: 9 }),
		]);
		client.getTorrentFiles.mockImplementation(async (instanceId: number) =>
			instanceId === 7
				? [{ index: 0, name: "gone.mkv", size: 1_000_000, progress: 1, priority: 1 }]
				: instanceId === 8
					? [{ index: 0, name: "large.mkv", size: 1_000_000, progress: 1, priority: 1 }]
					: [],
		);

		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.torrentInventoryFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(deserializeFileIdIndex(serializeFileIdIndex(index))?.torrentInventoryFingerprint).toBe(
			index.torrentInventoryFingerprint,
		);

		expect(index.issues).toEqual([
			{
				hash: "missing",
				qbitInstanceId: 7,
				missingFiles: 1,
				sizeMismatches: 0,
				otherFailures: 0,
			},
			{
				hash: "oversized",
				qbitInstanceId: 8,
				missingFiles: 0,
				sizeMismatches: 1,
				otherFailures: 0,
			},
			{
				hash: "unreadable",
				qbitInstanceId: 9,
				missingFiles: 0,
				sizeMismatches: 0,
				otherFailures: 1,
			},
		]);
	});
});

describe("buildFileIdIndex — caching", () => {
	it("reads only current-generation, issue-provenanced cached coverage without rebuilding", () => {
		const builtAtMs = 1_700_000_000_000;
		__testOnly.primeCache(QUI_INSTANCE.id, {
			builtAt: builtAtMs,
			index: {
				sourceConnectionGeneration: 4,
				fallbackOwnershipVersion: 4,
				torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
				byFileId: new Map(),
				statted: 5,
				skippedNoLinks: 2,
				skippedUnstatable: 1,
				inventoryComplete: true,
				incompleteDirectoryWalks: 0,
				issues: [
					{
						hash: "hash",
						qbitInstanceId: null,
						missingFiles: 1,
						sizeMismatches: 0,
						otherFailures: 2,
					},
				],
				rootDiagnostics: {
					cappedPrimaryWalks: 0,
					cappedFallbackWalks: 0,
					largestCappedWalkEntries: 0,
				},
			},
		});

		expect(readCachedFileIdCoverage({ id: QUI_INSTANCE.id, connectionGeneration: 4 })).toEqual({
			builtAtMs,
			inventoryComplete: true,
			skippedUnstatable: 1,
			incompleteDirectoryWalks: 0,
			issues: [
				{
					hash: "hash",
					qbitInstanceId: null,
					missingFiles: 1,
					sizeMismatches: 0,
					otherFailures: 2,
				},
			],
			torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
		});
	});

	it("returns null for absent, legacy, and generation-mismatched coverage", () => {
		expect(readCachedFileIdCoverage({ id: "absent", connectionGeneration: 4 })).toBeNull();
		__testOnly.primeCache("old-generation", {
			builtAt: 1,
			index: {
				sourceConnectionGeneration: 3,
				fallbackOwnershipVersion: 4,
				torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
				byFileId: new Map(),
				statted: 0,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				inventoryComplete: true,
				incompleteDirectoryWalks: 0,
				issues: [],
			},
		});
		__testOnly.primeCache("legacy", {
			builtAt: 1,
			index: {
				sourceConnectionGeneration: 4,
				fallbackOwnershipVersion: 2,
				byFileId: new Map(),
				statted: 0,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				inventoryComplete: true,
				incompleteDirectoryWalks: 0,
			},
		});

		expect(readCachedFileIdCoverage({ id: "old-generation", connectionGeneration: 4 })).toBeNull();
		expect(readCachedFileIdCoverage({ id: "legacy", connectionGeneration: 4 })).toBeNull();
		__testOnly.primeCache("missing-issues", {
			builtAt: 1,
			index: {
				sourceConnectionGeneration: 4,
				fallbackOwnershipVersion: 4,
				torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
				byFileId: new Map(),
				statted: 0,
				skippedNoLinks: 0,
				skippedUnstatable: 0,
				inventoryComplete: true,
				incompleteDirectoryWalks: 1,
				issues: [],
			},
		});
		expect(readCachedFileIdCoverage({ id: "missing-issues", connectionGeneration: 4 })).toBeNull();
	});

	it("holds an independent restore barrier until best-effort persistence settles", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		let releasePersist!: () => void;
		const upsert = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releasePersist = resolve;
				}),
		);
		const prisma = {
			serviceInstance: { findUnique: vi.fn().mockResolvedValue({ connectionGeneration: 0 }) },
			inodeIndexCache: { upsert },
			$transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
		};

		let completed = false;
		const build = buildFileIdIndex(client as never, QUI_INSTANCE, undefined, prisma as never).then(
			(result) => {
				completed = true;
				return result;
			},
		);
		await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
		expect(completed).toBe(false);
		const maintenanceWork = vi.fn(async () => undefined);
		await expect(withCleanupMaintenanceGuard(maintenanceWork)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(maintenanceWork).not.toHaveBeenCalled();

		releasePersist();
		await expect(build).resolves.toMatchObject({ statted: 1 });
		expect(completed).toBe(true);
		await expect(withCleanupMaintenanceGuard(maintenanceWork)).resolves.toBeUndefined();
		expect(maintenanceWork).toHaveBeenCalledTimes(1);
	});

	it("returns cached index on second call within TTL", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(1);
	});

	it("serves a fresh legacy index while a single background completeness rebuild runs", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const torrents = [
			makeQuiTorrent({ hash: "fresh", name: "Foo.mkv", savePath: "/data/torrents" }),
		];
		const client = makeFakeClient(torrents);
		let release!: (value: QuiTorrent[]) => void;
		client.listAllTorrents.mockReturnValueOnce(
			new Promise<QuiTorrent[]>((resolve) => {
				release = resolve;
			}),
		);
		const legacy: FileIdIndex = {
			sourceConnectionGeneration: 0,
			byFileId: new Map([["100:42", new Set(["legacy"])]]),
			statted: 1,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		__testOnly.primeCache(QUI_INSTANCE.id, { index: legacy, builtAt: Date.now() });
		expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(legacy);
		expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(legacy);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(1);
		release(torrents);
		await vi.waitFor(() => {
			expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index.inventoryComplete).toBe(true);
		});
		expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index.byFileId.get("100:42")).toEqual(
			new Set(["fresh"]),
		);
	});

	it("retains legacy positives and cools down a failed background upgrade", async () => {
		const client = makeFakeClient([]);
		client.listAllTorrents.mockRejectedValue(new Error("synthetic unavailable"));
		const legacy: FileIdIndex = {
			sourceConnectionGeneration: 0,
			byFileId: new Map([["100:42", new Set(["legacy"])]]),
			statted: 1,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		__testOnly.primeCache(QUI_INSTANCE.id, { index: legacy, builtAt: Date.now() });
		expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(legacy);
		await vi.waitFor(() => expect(client.listAllTorrents).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(legacy);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(2);
		expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index).toBe(legacy);
	});

	it("does not publish an old background build after a connection repoint", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const oldTorrent = makeQuiTorrent({ hash: "old", name: "Foo.mkv", savePath: "/data/torrents" });
		const newTorrent = makeQuiTorrent({ hash: "new", name: "Foo.mkv", savePath: "/data/torrents" });
		let releaseOld!: (value: QuiTorrent[]) => void;
		const oldClient = makeFakeClient([]);
		oldClient.listAllTorrents.mockReturnValueOnce(
			new Promise<QuiTorrent[]>((resolve) => {
				releaseOld = resolve;
			}),
		);
		const legacy: FileIdIndex = {
			sourceConnectionGeneration: 0,
			byFileId: new Map([["100:42", new Set(["legacy"])]]),
			statted: 1,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		__testOnly.primeCache(QUI_INSTANCE.id, { index: legacy, builtAt: Date.now() });
		expect(await buildFileIdIndex(oldClient as never, QUI_INSTANCE)).toBe(legacy);
		clearFileIdIndexCache(QUI_INSTANCE.id);
		const replacement = { ...QUI_INSTANCE, connectionGeneration: 1 };
		const newClient = makeFakeClient([newTorrent]);
		const rebuilt = await buildFileIdIndex(newClient as never, replacement);
		expect(rebuilt.byFileId.get("100:42")).toEqual(new Set(["new"]));
		releaseOld([oldTorrent]);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index).toBe(rebuilt);
	});

	it("does not join an old-generation producer before cache invalidation runs", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		let releaseOld!: (value: QuiTorrent[]) => void;
		const oldClient = makeFakeClient([]);
		oldClient.listAllTorrents.mockReturnValueOnce(
			new Promise<QuiTorrent[]>((resolve) => {
				releaseOld = resolve;
			}),
		);
		const oldBuild = buildFileIdIndex(oldClient as never, QUI_INSTANCE);
		const replacement = { ...QUI_INSTANCE, connectionGeneration: 1 };
		const newClient = makeFakeClient([
			makeQuiTorrent({ hash: "new", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		const rebuilt = await buildFileIdIndex(newClient as never, replacement);
		expect(newClient.listAllTorrents).toHaveBeenCalledTimes(1);
		releaseOld([makeQuiTorrent({ hash: "old", name: "Foo.mkv", savePath: "/data/torrents" })]);
		await expect(oldBuild).rejects.toThrow("connection changed");
		expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index).toBe(rebuilt);
	});

	it("rejects a durable publication when the connection generation changed", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "old", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		const prisma = {
			serviceInstance: { findUnique: vi.fn().mockResolvedValue({ connectionGeneration: 1 }) },
			inodeIndexCache: { upsert: vi.fn() },
			$transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
		};
		await expect(
			buildFileIdIndex(client as never, QUI_INSTANCE, undefined, prisma as never),
		).rejects.toThrow("connection changed");
		expect(prisma.inodeIndexCache.upsert).not.toHaveBeenCalled();
		expect(__testOnly.peekCache(QUI_INSTANCE.id)).toBeUndefined();
	});

	it("rebuilds when cache is manually cleared", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		__testOnly.clearCache();
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(2);
	});

	it("retains positive matches but not completeness after a legacy inventory fallback", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		client.listAllTorrents.mockRejectedValueOnce(new Error("metadata-free inventory"));
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("100:42")).toEqual(new Set(["h1"]));
		expect(index.inventoryComplete).toBe(false);
		expect(client.listAllTorrents).toHaveBeenNthCalledWith(1, { requireComplete: true });
		expect(client.listAllTorrents).toHaveBeenNthCalledWith(2);
	});

	it("retries transiently incomplete inventory before the 30-minute index TTL", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		client.listAllTorrents.mockRejectedValueOnce(new Error("transient strict timeout"));
		const partial = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(partial.inventoryComplete).toBe(false);
		const now = Date.now();
		const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1000 + 1);
		try {
			expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(partial);
			await vi.waitFor(() => {
				expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index.inventoryComplete).toBe(true);
			});
			expect(client.listAllTorrents).toHaveBeenCalledTimes(3);
		} finally {
			dateSpy.mockRestore();
		}
	});

	it("retries transiently unstatable torrent paths before the 30-minute TTL", async () => {
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		const partial = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(partial.skippedUnstatable).toBe(1);
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const now = Date.now();
		const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1000 + 1);
		try {
			expect(await buildFileIdIndex(client as never, QUI_INSTANCE)).toBe(partial);
			await vi.waitFor(() => {
				expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index.skippedUnstatable).toBe(0);
			});
			expect(client.listAllTorrents).toHaveBeenCalledTimes(2);
		} finally {
			dateSpy.mockRestore();
		}
	});

	it("destructive snapshots bypass the normal 30-minute cache", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(3);
		expect(client.listAllTorrents).toHaveBeenNthCalledWith(1, { requireComplete: true });
		expect(client.listAllTorrents).toHaveBeenNthCalledWith(2, { requireComplete: true });
		expect(client.listAllTorrents).toHaveBeenNthCalledWith(3, { requireComplete: true });
	});

	it("destructive snapshots reject an incomplete torrent inventory", async () => {
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "missing", name: "Missing.mkv", savePath: "/unreachable" }),
		]);
		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"inode inventory was incomplete",
		);
	});

	it("destructive snapshots retain ownership of a deselected file still hardlinked on disk", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 100, 900000, [{ name: "retained.mkv", ino: 900001, nlink: 2 }]);
		stageFile("/data/media/retained.mkv", 100, 900001, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "deselected", name: "missing-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "retained.mkv", size: 1_000_000, progress: 1, priority: 0 },
		]);

		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		await expect(getAllHashesForFileIdComplete("/data/media/retained.mkv", index)).resolves.toEqual(
			{
				hashes: ["deselected"],
				complete: true,
			},
		);
	});

	it("destructive snapshots reject a deselected file whose disk ownership is unverified", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 100, 900100, []);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "deselected", name: "missing-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles.mockResolvedValue([
			{ index: 0, name: "unverified.mkv", size: 1_000_000, progress: 0, priority: 0 },
		]);

		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"inode inventory was incomplete",
		);
	});

	it("destructive snapshots reject directory torrents containing symlinks", async () => {
		const root = "/data/torrents/Symlinked";
		stagedStats.set(root, {
			dev: 100,
			ino: 1_000,
			nlink: 1,
			ctimeMs: 1_000,
			mtimeMs: 1_000,
			type: "directory",
		});
		stagedDirs.set(root, [{ name: "Episode.mkv", parentPath: root, type: "symlink" }]);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "symlinked", name: "Symlinked", savePath: "/data/torrents" }),
		]);

		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"inode inventory was incomplete",
		);
	});

	it("destructive snapshots reject a changed fallback torrent file list", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 100, 800000, [
			{ name: "owned.mkv", ino: 800001, nlink: 2 },
			{ name: "replacement.mkv", ino: 800002, nlink: 2 },
		]);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "changing", name: "missing-content-root", savePath, instanceId: 7 }),
		]);
		client.getTorrentFiles
			.mockResolvedValueOnce([
				{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 },
			])
			.mockResolvedValueOnce([
				{ index: 0, name: "replacement.mkv", size: 1_000_000, progress: 1, priority: 1 },
			]);
		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"incomplete",
		);
		expect(client.getTorrentFiles).toHaveBeenCalledTimes(2);
	});

	it("destructive snapshots reject a fallback file replaced after its first stat", async () => {
		const savePath = "/data/torrents";
		stageDir(savePath, 100, 810000, [{ name: "owned.mkv", ino: 810001, nlink: 2 }]);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "changing-file", name: "missing-root", savePath, instanceId: 7 }),
		]);
		let reads = 0;
		client.getTorrentFiles.mockImplementation(async () => {
			reads++;
			if (reads % 2 === 0) stageFile(`${savePath}/owned.mkv`, 100, 810001 + reads, 2);
			return [{ index: 0, name: "owned.mkv", size: 1_000_000, progress: 1, priority: 1 }];
		});
		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"did not remain stable",
		);
	});

	it("rebuilds when a cross-seed appears during the filesystem walk", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 3);
		stageFile("/data/cross-seeds/Foo.mkv", 100, 42, 3);
		const primary = makeQuiTorrent({
			hash: "primary",
			name: "Foo.mkv",
			savePath: "/data/torrents",
		});
		const crossSeed = makeQuiTorrent({
			hash: "cross-seed",
			name: "Foo.mkv",
			savePath: "/data/cross-seeds",
		});
		const client = makeFakeClient([]);
		client.listAllTorrents
			.mockResolvedValueOnce([primary])
			.mockResolvedValueOnce([primary, crossSeed])
			.mockResolvedValueOnce([primary, crossSeed])
			.mockResolvedValueOnce([primary, crossSeed])
			.mockResolvedValueOnce([primary, crossSeed]);

		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		expect(index.byFileId.get("100:42")).toEqual(new Set(["primary", "cross-seed"]));
		expect(client.listAllTorrents).toHaveBeenCalledTimes(4);
	});

	it("rebuilds when an existing torrent creates a hardlink during the walk", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 3);
		stageFile("/data/cross-seeds/Foo.mkv", 100, 43, 1);
		const torrents = [
			makeQuiTorrent({ hash: "primary", name: "Foo.mkv", savePath: "/data/torrents" }),
			makeQuiTorrent({ hash: "cross-seed", name: "Foo.mkv", savePath: "/data/cross-seeds" }),
		];
		let inventoryReads = 0;
		const client = {
			listAllTorrents: vi.fn(async () => {
				inventoryReads++;
				if (inventoryReads === 2) {
					stageFile("/data/cross-seeds/Foo.mkv", 100, 42, 3);
				}
				return torrents;
			}),
		};

		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		expect(index.byFileId.get("100:42")).toEqual(new Set(["primary", "cross-seed"]));
		expect(client.listAllTorrents).toHaveBeenCalledTimes(4);
	});

	it("preserves the earliest marker when torrents share the same root", async () => {
		const sharedPath = "/data/torrents/Foo.mkv";
		stageFile(sharedPath, 100, 42, 2);
		const torrents = [
			makeQuiTorrent({ hash: "primary", name: "Foo.mkv", savePath: "/data/torrents" }),
			makeQuiTorrent({ hash: "duplicate", name: "Foo.mkv", savePath: "/data/torrents" }),
		];
		let sharedStats = 0;
		statHook = (path) => {
			if (path !== sharedPath) return;
			sharedStats++;
			if (sharedStats === 2) {
				stageFile(sharedPath, 100, 42, 3, 43);
			}
		};
		const client = makeFakeClient(torrents);

		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		expect(index.byFileId.get("100:42")).toEqual(new Set(["primary", "duplicate"]));
		expect(client.listAllTorrents).toHaveBeenCalledTimes(4);
	});

	it("rejects a nested-directory entry added between inventory and marker capture", async () => {
		const root = "/data/torrents/Season";
		const nested = `${root}/Season 01`;
		stagedStats.set(root, {
			dev: 100,
			ino: 1000,
			nlink: 1,
			ctimeMs: 1000,
			mtimeMs: 1000,
			type: "directory",
		});
		stagedStats.set(nested, {
			dev: 100,
			ino: 1001,
			nlink: 1,
			ctimeMs: 1001,
			mtimeMs: 1001,
			type: "directory",
		});
		stageFile(`${nested}/S01E01.mkv`, 100, 42, 2);
		stagedDirs.set(root, [
			{ name: "Season 01", parentPath: root, type: "directory" },
			{ name: "S01E01.mkv", parentPath: nested, type: "file" },
		]);
		let injected = false;
		statHook = (path) => {
			if (path !== nested || injected) return;
			injected = true;
			stageFile(`${nested}/S01E02.mkv`, 100, 43, 2);
			stagedDirs.get(root)?.push({
				name: "S01E02.mkv",
				parentPath: nested,
				type: "file",
			});
		};
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "season", name: "Season", savePath: "/data/torrents" }),
		]);

		await expect(buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE)).rejects.toThrow(
			"inode inventory was incomplete",
		);
	});
});

describe("buildFileIdIndex — path prefix rewrite", () => {
	it("applies path prefix rewrite to qui-reported paths (single-file)", async () => {
		stageFile("/qbit-data/movies/Foo.mkv", 100, 1, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "prefixed", name: "Foo.mkv", savePath: "/downloads/movies" }),
		]);
		const index = await buildFileIdIndex(client as never, {
			...QUI_INSTANCE,
			pathPrefix: "/downloads>/qbit-data",
		});
		expect(index.byFileId.get("100:1")).toEqual(new Set(["prefixed"]));
	});

	it("applies path prefix rewrite to folder-wrapped torrents", async () => {
		const realFolder = "/qbit-data/movies/Foo--abc";
		stageDir(realFolder, 100, 800000, [{ name: "Foo.mkv", ino: 5001, nlink: 2 }]);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "prefixed-folder",
				name: "Foo--abc",
				savePath: "/downloads/movies",
			}),
		]);
		const index = await buildFileIdIndex(client as never, {
			...QUI_INSTANCE,
			pathPrefix: "/downloads>/qbit-data",
		});
		expect(index.byFileId.get("100:5001")).toEqual(new Set(["prefixed-folder"]));
	});
});

describe("matchLibraryByFileId", () => {
	function makeIndex(entries: Array<[string, string]>): FileIdIndex {
		// Wrap each scalar hash into a single-element Set — the new
		// multi-hash index shape. matchLibraryByFileId still returns one
		// canonical hash per inode (first from the set), so single-element
		// sets exercise the same behavior as the old single-string map.
		const m = new Map<string, Set<string>>(entries.map(([key, hash]) => [key, new Set([hash])]));
		return { byFileId: m, statted: m.size, skippedNoLinks: 0, skippedUnstatable: 0 };
	}

	it("matches when (dev, ino) is in the index", async () => {
		stageFile("/data/media/Foo.mkv", 100, 42, 2);
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/data/media/Foo.mkv", index)).toEqual({
			hash: "hash-A",
			source: "inode",
		});
	});

	it("does NOT match when ino matches but dev differs (different filesystems)", async () => {
		// Two files on different mounts can share an inode number. Strictly
		// requiring (dev, ino) equality is the whole reason qui's FileID is
		// a struct, not just an inode. Drop this guard and you'd correlate
		// unrelated files across mounted volumes.
		stageFile("/mnt/disk2/Foo.mkv", 200, 42, 2);
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/mnt/disk2/Foo.mkv", index)).toBeNull();
	});

	it("returns null when the library file has nlink == 1 (cannot be hardlinked)", async () => {
		stageFile("/data/media/Lonely.mkv", 100, 42, 1);
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/data/media/Lonely.mkv", index)).toBeNull();
	});

	it("returns null when the library path cannot be stat'd", async () => {
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/path/does/not/exist", index)).toBeNull();
	});

	it("returns null when (dev, ino) is not in the index (miss)", async () => {
		stageFile("/data/media/Foo.mkv", 100, 999, 2);
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/data/media/Foo.mkv", index)).toBeNull();
	});

	it("returns null when the library path resolves to a directory (defense-in-depth)", async () => {
		// A library "file" that's somehow a directory shouldn't accidentally
		// match against a torrent root if their inodes collide. The kind
		// check on the StatInfo guards this.
		stagedStats.set("/data/media/somehow-a-dir", {
			dev: 100,
			ino: 42,
			nlink: 2,
			ctimeMs: 42,
			mtimeMs: 42,
			type: "directory",
		});
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/data/media/somehow-a-dir", index)).toBeNull();
	});
});

/**
 * Multi-hash semantics: the index now tracks EVERY torrent that shares
 * a given (dev, ino), not just the last one to win Map.set(). This is
 * the architectural fix that lets the series-torrents panel surface
 * cross-seed siblings even on single-instance qui setups (where qui's
 * own local-matches endpoint returns nothing).
 *
 * The core invariants pinned here:
 *   1. Two torrents sharing an inode → both stored.
 *   2. matchLibraryByFileId still returns ONE canonical hash (first
 *      from the set) so backfill sweeps writing to single-column
 *      infoHash continue to work unchanged.
 *   3. getAllHashesForFileId returns the full array of hashes.
 *   4. nlink == 1 / stat-fails / not-in-index still return empty.
 */
describe("multi-hash per FileID (cross-seed visibility)", () => {
	it("indexes multiple torrents pointing at the same inode (cross-seed case)", async () => {
		// Three torrents — primary + 2 cross-seeds at different trackers —
		// all hardlink-pointing at the same .mkv. Old Map<string, string>
		// would have stored only the LAST hash; the new Set<string> stores
		// all three.
		stageFile("/data/torrents/primary/foo.mkv", 61, 12345, 4);
		stageFile("/data/torrents/links/PTP/foo.mkv", 61, 12345, 4);
		stageFile("/data/torrents/links/BHD/foo.mkv", 61, 12345, 4);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "primary-hash", name: "foo.mkv", savePath: "/data/torrents/primary" }),
			makeQuiTorrent({ hash: "ptp-hash", name: "foo.mkv", savePath: "/data/torrents/links/PTP" }),
			makeQuiTorrent({ hash: "bhd-hash", name: "foo.mkv", savePath: "/data/torrents/links/BHD" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:12345")).toEqual(
			new Set(["primary-hash", "ptp-hash", "bhd-hash"]),
		);
	});

	it("matchLibraryByFileId still returns ONE canonical hash from a multi-hash set (backfill compat)", async () => {
		// Backfill sweeps write to single-column episode_file_cache.infoHash.
		// matchLibraryByFileId must keep returning a single value — the
		// canonical choice is "first hash in iteration order" (matches
		// qui's torrent enumeration order). Set iteration is insertion
		// order in JS, so primary-hash (inserted first) wins.
		stageFile("/data/media/foo.mkv", 61, 12345, 4);
		const index: FileIdIndex = {
			byFileId: new Map([["61:12345", new Set(["primary-hash", "ptp-hash", "bhd-hash"])]]),
			statted: 3,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		expect(await matchLibraryByFileId("/data/media/foo.mkv", index)).toEqual({
			hash: "primary-hash",
			source: "inode",
		});
	});

	it("getAllHashesForFileId returns the full set as an array (series panel use)", async () => {
		stageFile("/data/media/foo.mkv", 61, 12345, 4);
		const index: FileIdIndex = {
			byFileId: new Map([["61:12345", new Set(["primary-hash", "ptp-hash", "bhd-hash"])]]),
			statted: 3,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		const hashes = await getAllHashesForFileId("/data/media/foo.mkv", index);
		expect(hashes).toHaveLength(3);
		// Order matches insertion order. Tests can rely on this for
		// deterministic snapshot assertions.
		expect(hashes).toEqual(["primary-hash", "ptp-hash", "bhd-hash"]);
	});

	it("complete resolver returns every exact hash and fails on an unreadable target", async () => {
		stageFile("/data/media/foo.mkv", 61, 12345, 4);
		const index: FileIdIndex = {
			byFileId: new Map([["61:12345", new Set(["primary-hash", "cross-seed-hash"])]]),
			inodeMarkers: new Map([
				[
					"61:12345",
					{
						dev: 61,
						ino: 12345,
						nlink: 4,
						size: 1_000_000,
						ctimeMs: 12345,
						mtimeMs: 12345,
						kind: "file",
					},
				],
			]),
			statted: 2,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
		};
		await expect(getAllHashesForFileIdComplete("/data/media/foo.mkv", index)).resolves.toEqual({
			hashes: ["primary-hash", "cross-seed-hash"],
			complete: true,
		});
		await expect(getAllHashesForFileIdComplete("/missing.mkv", index)).rejects.toThrow(
			"could not be stat'd",
		);
	});

	it("complete resolver finds a single-link qUI content file used directly by the library", async () => {
		stageFile("/data/torrents/foo.mkv", 61, 54321, 1);
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "single-link-hash",
				name: "foo.mkv",
				savePath: "/data/torrents",
			}),
		]);

		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		expect(index.byFileId.get("61:54321")).toEqual(new Set(["single-link-hash"]));
		await expect(getAllHashesForFileIdComplete("/data/torrents/foo.mkv", index)).resolves.toEqual({
			hashes: ["single-link-hash"],
			complete: true,
		});
	});

	it("complete resolver fails closed when the target inode changes after indexing", async () => {
		stageFile("/data/media/foo.mkv", 61, 12345, 3);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "primary-hash", name: "foo.mkv", savePath: "/data/media" }),
		]);
		const index = await buildFreshCompleteFileIdIndex(client as never, QUI_INSTANCE);

		stageFile("/data/media/foo.mkv", 61, 12345, 4, 12346);

		await expect(getAllHashesForFileIdComplete("/data/media/foo.mkv", index)).rejects.toThrow(
			"inode changed after qUI inventory verification",
		);
	});

	it("getAllHashesForFileId returns [] for nlink==1 / stat failure / no match", async () => {
		// nlink == 1: file is alone on disk, can't be in the index → empty
		stageFile("/data/media/lonely.mkv", 61, 99, 1);
		// no stagedStat for /missing.mkv → ENOENT
		const index: FileIdIndex = {
			byFileId: new Map([["61:99", new Set(["wouldnt-match-anyway"])]]),
			statted: 1,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		expect(await getAllHashesForFileId("/data/media/lonely.mkv", index)).toEqual([]);
		expect(await getAllHashesForFileId("/missing.mkv", index)).toEqual([]);
	});

	it("REJECTS multi-hash matches when ino matches but dev differs (cross-filesystem)", async () => {
		// Same (dev, ino) check applies regardless of multi-hash. Different
		// filesystems → different identity → no match.
		stageFile("/mnt/disk2/foo.mkv", 200, 12345, 2);
		const index: FileIdIndex = {
			byFileId: new Map([["61:12345", new Set(["a", "b", "c"])]]),
			statted: 3,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		expect(await getAllHashesForFileId("/mnt/disk2/foo.mkv", index)).toEqual([]);
	});
});

describe("serialize/deserialize round-trip", () => {
	it("rejects an old ownership snapshot even when its connection generation matches", async () => {
		const legacy = gzipSync(
			Buffer.from(
				JSON.stringify({
					v: 1,
					sourceConnectionGeneration: 3,
					statted: 1,
					skippedNoLinks: 0,
					skippedUnstatable: 0,
					inventoryComplete: true,
					incompleteDirectoryWalks: 0,
					entries: [["100:42", ["unverified"]]],
				}),
			),
		);
		const row = {
			instanceId: QUI_INSTANCE.id,
			builtAt: new Date(),
			filesIndexed: 1,
			serializedData: legacy,
			instance: { connectionGeneration: 3 },
		};
		const prisma = {
			inodeIndexCache: {
				findMany: vi.fn().mockResolvedValue([row]),
				findUnique: vi.fn().mockResolvedValue(row),
			},
		};
		expect(await loadFileIdIndexFromDb(prisma as never, QUI_INSTANCE.id)).toBeNull();
		expect(await hydrateFileIdIndexFromDb(prisma as never)).toEqual({ loaded: 0, failed: 1 });
		expect(__testOnly.peekCache(QUI_INSTANCE.id)).toBeUndefined();
	});

	it("hydrates only a snapshot bound to the current connection generation", async () => {
		const index: FileIdIndex = {
			sourceConnectionGeneration: 3,
			fallbackOwnershipVersion: 4,
			torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
			byFileId: new Map([["100:42", new Set(["matched"])]]),
			statted: 1,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			inventoryComplete: true,
			incompleteDirectoryWalks: 0,
			issues: [],
		};
		const row = {
			instanceId: QUI_INSTANCE.id,
			builtAt: new Date(),
			filesIndexed: 1,
			serializedData: serializeFileIdIndex(index),
			instance: { connectionGeneration: 4 },
		};
		const prisma = { inodeIndexCache: { findMany: vi.fn().mockResolvedValue([row]) } };
		expect(await hydrateFileIdIndexFromDb(prisma as never)).toEqual({ loaded: 0, failed: 1 });
		expect(__testOnly.peekCache(QUI_INSTANCE.id)).toBeUndefined();

		row.instance.connectionGeneration = 3;
		expect(await hydrateFileIdIndexFromDb(prisma as never)).toEqual({ loaded: 1, failed: 0 });
		expect(__testOnly.peekCache(QUI_INSTANCE.id)?.index.byFileId.get("100:42")).toEqual(
			new Set(["matched"]),
		);
	});

	it("does not hydrate a pre-generation legacy blob as current connection evidence", async () => {
		const legacy = gzipSync(
			Buffer.from(
				JSON.stringify({
					v: 1,
					statted: 1,
					skippedNoLinks: 0,
					skippedUnstatable: 0,
					entries: [["100:42", ["old"]]],
				}),
			),
		);
		const prisma = {
			inodeIndexCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: QUI_INSTANCE.id,
						builtAt: new Date(),
						filesIndexed: 1,
						serializedData: legacy,
						instance: { connectionGeneration: 0 },
					},
				]),
			},
		};
		expect(await hydrateFileIdIndexFromDb(prisma as never)).toEqual({ loaded: 0, failed: 1 });
		expect(__testOnly.peekCache(QUI_INSTANCE.id)).toBeUndefined();
	});

	it("retains the unknown completeness state of a persisted v1 index", () => {
		const legacy = gzipSync(
			Buffer.from(
				JSON.stringify({
					v: 1,
					statted: 1,
					skippedNoLinks: 0,
					skippedUnstatable: 0,
					entries: [["100:42", ["legacy"]]],
				}),
			),
		);
		const hydrated = deserializeFileIdIndex(legacy);
		expect(hydrated?.inventoryComplete).toBeUndefined();
		expect(hydrated?.incompleteDirectoryWalks).toBeUndefined();
		expect(hydrated?.byFileId.get("100:42")).toEqual(new Set(["legacy"]));
	});

	it("fails closed when a current ownership snapshot has malformed issue provenance", () => {
		const malformed = gzipSync(
			Buffer.from(
				JSON.stringify({
					v: 1,
					sourceConnectionGeneration: 3,
					fallbackOwnershipVersion: 4,
					torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
					statted: 1,
					skippedNoLinks: 0,
					skippedUnstatable: 0,
					inventoryComplete: true,
					incompleteDirectoryWalks: 1,
					issues: [{ hash: "scope", qbitInstanceId: 7, missingFiles: "one" }],
					entries: [["100:42", ["scope"]]],
				}),
			),
		);

		expect(deserializeFileIdIndex(malformed)).toBeNull();
	});

	it("rejects current-version cached coverage without a torrent membership fingerprint", () => {
		const missingFingerprint = serializeFileIdIndex({
			sourceConnectionGeneration: 3,
			fallbackOwnershipVersion: 4,
			byFileId: new Map(),
			statted: 0,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			inventoryComplete: true,
			incompleteDirectoryWalks: 0,
			issues: [],
		});
		expect(deserializeFileIdIndex(missingFingerprint)).toBeNull();
	});

	it("persists only allowlisted issue metadata", () => {
		const blob = serializeFileIdIndex({
			sourceConnectionGeneration: 3,
			fallbackOwnershipVersion: 4,
			torrentInventoryFingerprint: fingerprintQuiTorrentInventory([]),
			byFileId: new Map(),
			statted: 0,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
			inventoryComplete: true,
			incompleteDirectoryWalks: 1,
			issues: [
				{
					hash: "private-hash",
					qbitInstanceId: null,
					missingFiles: 0,
					sizeMismatches: 0,
					otherFailures: 1,
					name: "Private Torrent Name",
					path: "/private/torrent",
					providerBody: { secret: "private-value" },
				},
			] as never,
		});
		const serialized = gunzipSync(blob).toString("utf8");

		expect(serialized).not.toContain("Private Torrent Name");
		expect(serialized).not.toContain("/private/torrent");
		expect(serialized).not.toContain("private-value");
		expect(deserializeFileIdIndex(blob)?.issues).toEqual([
			{
				hash: "private-hash",
				qbitInstanceId: null,
				missingFiles: 0,
				sizeMismatches: 0,
				otherFailures: 1,
			},
		]);
	});

	it("preserves the byFileId Map and metadata fields", () => {
		const original: FileIdIndex = {
			sourceConnectionGeneration: 3,
			byFileId: new Map([
				["1:1001", new Set(["a", "b", "c"])],
				["1:1002", new Set(["d"])],
				["64:99", new Set(["e", "f"])],
			]),
			statted: 100,
			skippedNoLinks: 25,
			skippedUnstatable: 0,
			inventoryComplete: true,
			incompleteDirectoryWalks: 1,
			walkIssues: {
				readFailures: 1,
				entryLimitExceeded: 1,
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
			},
			rootDiagnostics: {
				cappedPrimaryWalks: 1,
				cappedFallbackWalks: 1,
				largestCappedWalkEntries: 817,
			},
			fallbackIssueDiagnostics: {
				missingEntryTorrents: 1,
				sizeMismatchTorrents: 1,
				maxMissingEntriesPerTorrent: 1,
				maxSizeMismatchesPerTorrent: 2,
				sizeMismatchFileContentRoots: 0,
				sizeMismatchDirectoryContentRoots: 1,
				sizeMismatchUnavailableContentRoots: 0,
			},
			issues: [
				{
					hash: "private-hash",
					qbitInstanceId: 7,
					missingFiles: 2,
					sizeMismatches: 1,
					otherFailures: 3,
				},
			],
		};
		const blob = serializeFileIdIndex(original);
		expect(blob).toBeInstanceOf(Buffer);
		expect(blob.length).toBeGreaterThan(0);

		const restored = deserializeFileIdIndex(blob);
		expect(restored).not.toBeNull();
		expect(restored!.statted).toBe(100);
		expect(restored!.sourceConnectionGeneration).toBe(3);
		expect(restored!.skippedNoLinks).toBe(25);
		expect(restored!.skippedUnstatable).toBe(0);
		expect(restored!.inventoryComplete).toBe(true);
		expect(restored!.incompleteDirectoryWalks).toBe(1);
		expect(restored!.issues).toEqual(original.issues);
		expect(restored!.walkIssues).toEqual(original.walkIssues);
		expect(restored!.rootDiagnostics).toEqual(original.rootDiagnostics);
		expect(restored!.fallbackIssueDiagnostics).toEqual(original.fallbackIssueDiagnostics);
		expect(restored!.byFileId.size).toBe(3);
		expect(restored!.byFileId.get("1:1001")).toEqual(new Set(["a", "b", "c"]));
		expect(restored!.byFileId.get("1:1002")).toEqual(new Set(["d"]));
		expect(restored!.byFileId.get("64:99")).toEqual(new Set(["e", "f"]));
	});

	it("handles an empty index", () => {
		const empty: FileIdIndex = {
			byFileId: new Map(),
			statted: 0,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		};
		const restored = deserializeFileIdIndex(serializeFileIdIndex(empty));
		expect(restored).not.toBeNull();
		expect(restored!.byFileId.size).toBe(0);
		expect(restored!.inventoryComplete).toBe(false);
	});

	it("returns null for corrupt input rather than throwing", () => {
		expect(deserializeFileIdIndex(Buffer.from("not gzip data"))).toBeNull();
		expect(deserializeFileIdIndex(Buffer.alloc(0))).toBeNull();
	});

	it("compresses meaningfully — 1000 entries should fit under 50KB", () => {
		// Stress test the gzip ratio: with structurally similar entries
		// (same dev, sequential inos, two random hashes each), gzip-9 should
		// crush the payload aggressively. Real-world payloads have higher
		// entropy in hashes but lower entropy in keys, so net ratio holds.
		const byFileId = new Map<string, Set<string>>();
		for (let i = 0; i < 1000; i++) {
			byFileId.set(`64:${1000 + i}`, new Set([`hash${i.toString(16).padStart(40, "0")}`]));
		}
		const blob = serializeFileIdIndex({
			byFileId,
			statted: 1000,
			skippedNoLinks: 0,
			skippedUnstatable: 0,
		});
		expect(blob.length).toBeLessThan(50_000);
		const restored = deserializeFileIdIndex(blob);
		expect(restored!.byFileId.size).toBe(1000);
	});
});
