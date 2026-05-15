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
import type { QuiTorrent } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/promises BEFORE importing the module under test. The mocks
// return whatever we've staged via `stagedStats` / `stagedDirs`.
vi.mock("node:fs/promises", () => ({
	stat: vi.fn(async (path: string) => {
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
			isSymbolicLink: () => false,
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
	type: "file" | "directory";
}
interface StagedChild {
	name: string;
	parentPath: string;
	type: "file" | "directory";
}

const stagedStats = new Map<string, StagedStat>();
const stagedDirs = new Map<string, StagedChild[]>();

import {
	__testOnly,
	applyPathRewrite,
	buildFileIdIndex,
	type FileIdIndex,
	matchLibraryByFileId,
} from "../infohash-backfill-by-inode.js";

interface FakeQuiClient {
	listAllTorrents: ReturnType<typeof vi.fn>;
}

function makeFakeClient(torrents: QuiTorrent[]): FakeQuiClient {
	return {
		listAllTorrents: vi.fn(async () => torrents),
	};
}

function makeQuiTorrent(o: {
	hash: string;
	name: string;
	savePath: string;
	size?: number;
}): QuiTorrent {
	return {
		hash: o.hash,
		name: o.name,
		savePath: o.savePath,
		size: o.size ?? 1_000_000,
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
function stageFile(path: string, dev: number, ino: number, nlink: number): void {
	stagedStats.set(path, { dev, ino, nlink, type: "file" });
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
	stagedStats.set(dirPath, { dev, ino, nlink: 1, type: "directory" });
	const children: StagedChild[] = [];
	for (const f of files) {
		const parent = f.subdir ? `${dirPath}/${f.subdir}` : dirPath;
		const filePath = `${parent}/${f.name}`;
		stageFile(filePath, dev, f.ino, f.nlink);
		children.push({ name: f.name, parentPath: parent, type: "file" });
	}
	stagedDirs.set(dirPath, children);
}

const QUI_INSTANCE = { id: "qui-1", label: "qui-1", pathPrefix: null as string | null };

beforeEach(() => {
	stagedStats.clear();
	stagedDirs.clear();
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
	it("indexes single-file torrents at the full content path", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("100:42")).toBe("h1");
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
		expect(index.byFileId.get("61:80142")).toBe("atomic");
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
		expect(index.byFileId.get("61:1001")).toBe("seasonpack");
		expect(index.byFileId.get("61:1002")).toBe("seasonpack");
		expect(index.byFileId.get("61:1003")).toBe("seasonpack");
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
		expect(index.byFileId.get("61:2001")).toBe("deepshow");
		expect(index.byFileId.get("61:2002")).toBe("deepshow");
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
		expect(index.byFileId.get("61:3001")).toBe("moviepack");
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
		stagedStats.set(folder, { dev: 61, ino: 400000, nlink: 2, type: "directory" });
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h", name: "weird", savePath: "/data/torrents" }),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.byFileId.get("61:400000")).toBeUndefined();
		expect(index.byFileId.get("61:4001")).toBe("h");
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
	});
});

describe("buildFileIdIndex — caching", () => {
	it("returns cached index on second call within TTL", async () => {
		stageFile("/data/torrents/Foo.mkv", 100, 42, 2);
		const client = makeFakeClient([
			makeQuiTorrent({ hash: "h1", name: "Foo.mkv", savePath: "/data/torrents" }),
		]);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(client.listAllTorrents).toHaveBeenCalledTimes(1);
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
		expect(index.byFileId.get("100:1")).toBe("prefixed");
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
		expect(index.byFileId.get("100:5001")).toBe("prefixed-folder");
	});
});

describe("matchLibraryByFileId", () => {
	function makeIndex(entries: Array<[string, string]>): FileIdIndex {
		const m = new Map<string, string>(entries);
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
			type: "directory",
		});
		const index = makeIndex([["100:42", "hash-A"]]);
		expect(await matchLibraryByFileId("/data/media/somehow-a-dir", index)).toBeNull();
	});
});
