/**
 * Integration test: inode strategy against REAL filesystem hardlinks.
 *
 * The unit tests in `infohash-backfill-by-inode.test.ts` mock
 * `node:fs/promises` so they're fast and deterministic — but they only
 * prove the matcher's logic, not that Node's `fs.stat()` actually returns
 * matching `(dev, ino)` for hardlinked files on the host OS.
 *
 * This test creates real files and real hardlinks under `os.tmpdir()`,
 * then runs `buildFileIdIndex` + `matchLibraryByFileId` against them
 * using actual syscalls. If a future Node version, FS driver, or
 * containerization layer breaks the expected stat semantics, this test
 * fails loudly instead of letting users discover it via "no items got
 * correlated after migration."
 *
 * Linux/macOS only. Skipped on Windows because Node's fs.stat behavior
 * for ino on Windows is filesystem-dependent (NTFS exposes a useful
 * value via NumberOfLinks but ino may be zeroed on some volumes).
 */

import { linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuiTorrent } from "@arr/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__testOnly,
	buildFileIdIndex,
	matchLibraryByFileId,
} from "../infohash-backfill-by-inode.js";

const isPosix = process.platform !== "win32";

function makeFakeClient(torrents: QuiTorrent[]) {
	return { listAllTorrents: async () => torrents };
}

function makeQuiTorrent(o: {
	hash: string;
	name: string;
	savePath: string;
	size: number;
}): QuiTorrent {
	return {
		hash: o.hash,
		name: o.name,
		savePath: o.savePath,
		size: o.size,
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

const QUI_INSTANCE = { id: "qui-integ", label: "qui-integ", pathPrefix: null as string | null };

describe.skipIf(!isPosix)("inode backfill — real filesystem", () => {
	let root: string;
	let torrentDir: string;
	let mediaDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arr-dash-inode-"));
		torrentDir = join(root, "torrents");
		mediaDir = join(root, "media");
		// Both dirs on the same tmpfs/disk → hardlinks across them work.
		// This mirrors the production layout where /data/torrents and
		// /data/media live on the same volume so the *arr import step
		// can hardlink instead of copy.
		require("node:fs").mkdirSync(torrentDir, { recursive: true });
		require("node:fs").mkdirSync(mediaDir, { recursive: true });
		__testOnly.clearCache();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("correlates a library file to its hardlinked torrent via real (dev, ino) match", async () => {
		// Write the actual content to the torrent directory…
		const torrentPath = join(torrentDir, "Real.Movie.2024.mkv");
		writeFileSync(torrentPath, "fake video bytes for testing");

		// …then hardlink it into the library directory under a different
		// name (the *arr-rename-on-import case). hardlink → same inode.
		const libraryPath = join(mediaDir, "Real Movie (2024) - WEBDL.mkv");
		linkSync(torrentPath, libraryPath);

		// Sanity check: real OS reports matching dev/ino for both paths.
		const tStat = statSync(torrentPath);
		const lStat = statSync(libraryPath);
		expect(tStat.dev).toBe(lStat.dev);
		expect(tStat.ino).toBe(lStat.ino);
		expect(tStat.nlink).toBe(2); // The link is bidirectional in nlink terms.

		// Build the index from qui's view (the torrent path)…
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "real-hash-1",
				name: "Real.Movie.2024.mkv",
				savePath: torrentDir,
				size: tStat.size,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(index.statted).toBe(1);
		expect(index.byFileId.size).toBe(1);

		// …and look up the library path. Different filename, different
		// directory — only the inode connects them.
		const match = await matchLibraryByFileId(libraryPath, index);
		expect(match).toEqual({ hash: "real-hash-1", source: "inode" });
	});

	it("does not match when the library file is a COPY (different inode) of the torrent file", async () => {
		// Same byte content, different inode — the heuristic matcher would
		// have caught this via (name, size), but the inode matcher MUST
		// refuse. A copy isn't seeding; correlating it would falsely claim
		// "this library item has a live torrent."
		const torrentPath = join(torrentDir, "Copied.mkv");
		const libraryPath = join(mediaDir, "Copied.mkv");
		writeFileSync(torrentPath, "byte-identical content");
		writeFileSync(libraryPath, "byte-identical content"); // separate inode

		const tStat = statSync(torrentPath);
		const lStat = statSync(libraryPath);
		expect(tStat.ino).not.toBe(lStat.ino); // sanity: real OS gave us different inodes

		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "copy-hash",
				name: "Copied.mkv",
				savePath: torrentDir,
				size: tStat.size,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		expect(await matchLibraryByFileId(libraryPath, index)).toBeNull();
	});

	it("skips a torrent file with nlink==1 (no hardlink target exists)", async () => {
		const torrentPath = join(torrentDir, "Orphan.mkv");
		writeFileSync(torrentPath, "no library counterpart");
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "orphan-hash",
				name: "Orphan.mkv",
				savePath: torrentDir,
				size: 12,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);
		// nlink==1 → counted in skippedNoLinks, NOT in the index. Saves
		// memory on libraries where most torrents aren't *arr-imported.
		expect(index.statted).toBe(0);
		expect(index.skippedNoLinks).toBe(1);
		expect(index.byFileId.size).toBe(0);
	});

	it("applies the path-prefix rewrite against a real path", async () => {
		// qui reports the torrent at an aliased path that doesn't exist on
		// disk; the prefix rewrites it to the real location. Verifies the
		// rewrite happens BEFORE the stat call, not after, by giving the
		// rewrite-source path no on-disk presence.
		const realTorrentPath = join(torrentDir, "Prefixed.mkv");
		writeFileSync(realTorrentPath, "x");
		const libraryPath = join(mediaDir, "Prefixed.mkv");
		linkSync(realTorrentPath, libraryPath);

		// qui says the torrent lives at "/qui-view/...". arr-dashboard sees
		// it at the real torrentDir. Prefix bridges the two views.
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "prefixed-hash",
				name: "Prefixed.mkv",
				savePath: "/qui-view/Prefixed",
				size: statSync(realTorrentPath).size,
			}),
		]);
		const index = await buildFileIdIndex(client as never, {
			...QUI_INSTANCE,
			pathPrefix: `/qui-view/Prefixed>${torrentDir}`,
		});
		const match = await matchLibraryByFileId(libraryPath, index);
		expect(match).toEqual({ hash: "prefixed-hash", source: "inode" });
	});

	it("walks into a folder-wrapped torrent and correlates the file inside (THE BUG FIX, real fs)", async () => {
		// This is the canonical bug case reproduced on real syscalls.
		// qui's hardlink-mode wraps every cross-seed in `Name--shortHash/`
		// and the actual media file lives INSIDE the folder. Pre-fix code
		// stat'd the folder and indexed the FOLDER's inode (never matches
		// any library file). This test creates that exact layout — real
		// folder with a real file hardlinked into media — and verifies the
		// strategy now finds the file's inode, not the folder's.
		const mkdirSync = require("node:fs").mkdirSync;
		const torrentFolder = join(torrentDir, "Movie.Release--abc123");
		mkdirSync(torrentFolder, { recursive: true });
		const torrentFilePath = join(torrentFolder, "Movie.Release.mkv");
		writeFileSync(torrentFilePath, "movie bytes");

		// Hardlink the file into the library at a renamed path (mimicking
		// *arr's import-rename-on-import). Folders can't be hardlinked on
		// POSIX, so the only path that shares the inode is the file itself
		// — which is exactly why folder-level indexing breaks down.
		const libraryPath = join(mediaDir, "Movie (Year) {tmdb-1}", "Movie (Year) - Remux.mkv");
		mkdirSync(join(mediaDir, "Movie (Year) {tmdb-1}"), { recursive: true });
		linkSync(torrentFilePath, libraryPath);

		// Sanity: file inodes match, folder inode does NOT match the file.
		const fileStat = statSync(torrentFilePath);
		const folderStat = statSync(torrentFolder);
		expect(folderStat.ino).not.toBe(fileStat.ino);
		expect(fileStat.nlink).toBe(2);

		// qui reports: savePath = torrentDir, name = "Movie.Release--abc123"
		// (the folder name, qBit's convention for folder-wrapped torrents).
		// So content path resolves to a DIRECTORY — the bug case.
		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "folder-wrapped-hash",
				name: "Movie.Release--abc123",
				savePath: torrentDir,
				size: fileStat.size,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);

		// THE PROOF: index contains the file's inode (so library lookup
		// will hit), NOT the folder's inode.
		expect(index.byFileId.size).toBe(1);
		expect(index.byFileId.get(`${fileStat.dev}:${fileStat.ino}`)).toBe("folder-wrapped-hash");
		expect(index.byFileId.get(`${folderStat.dev}:${folderStat.ino}`)).toBeUndefined();

		const match = await matchLibraryByFileId(libraryPath, index);
		expect(match).toEqual({ hash: "folder-wrapped-hash", source: "inode" });
	});

	it("indexes ALL files in a multi-file torrent (season pack pattern, real fs)", async () => {
		const mkdirSync = require("node:fs").mkdirSync;
		const seasonFolder = join(torrentDir, "Some.Show.S01");
		mkdirSync(seasonFolder, { recursive: true });

		// Create 3 episode files + a non-hardlinked .nfo. Hardlink the
		// episodes into the library (*arr's import flow); leave the .nfo
		// without hardlinks (nlink=1 — must be skipped).
		const e1Torrent = join(seasonFolder, "Some.Show.S01E01.mkv");
		const e2Torrent = join(seasonFolder, "Some.Show.S01E02.mkv");
		const e3Torrent = join(seasonFolder, "Some.Show.S01E03.mkv");
		const nfoPath = join(seasonFolder, "Some.Show.S01.nfo");
		writeFileSync(e1Torrent, "ep1");
		writeFileSync(e2Torrent, "ep2");
		writeFileSync(e3Torrent, "ep3");
		writeFileSync(nfoPath, "nfo");

		const showLib = join(mediaDir, "Some Show (2024) {tvdb-1}", "Season 01");
		mkdirSync(showLib, { recursive: true });
		linkSync(e1Torrent, join(showLib, "S01E01.mkv"));
		linkSync(e2Torrent, join(showLib, "S01E02.mkv"));
		linkSync(e3Torrent, join(showLib, "S01E03.mkv"));

		const client = makeFakeClient([
			makeQuiTorrent({
				hash: "season-pack-hash",
				name: "Some.Show.S01",
				savePath: torrentDir,
				size: 100,
			}),
		]);
		const index = await buildFileIdIndex(client as never, QUI_INSTANCE);

		// All 3 episodes indexed (each one's library counterpart will
		// correlate). .nfo skipped (nlink=1).
		expect(index.statted).toBe(3);
		expect(index.skippedNoLinks).toBe(1);

		// Each library episode correlates to the season-pack torrent hash.
		const e1Stat = statSync(e1Torrent);
		const e2Stat = statSync(e2Torrent);
		const e3Stat = statSync(e3Torrent);
		expect(index.byFileId.get(`${e1Stat.dev}:${e1Stat.ino}`)).toBe("season-pack-hash");
		expect(index.byFileId.get(`${e2Stat.dev}:${e2Stat.ino}`)).toBe("season-pack-hash");
		expect(index.byFileId.get(`${e3Stat.dev}:${e3Stat.ino}`)).toBe("season-pack-hash");
	});
});
