/**
 * Unit tests for the path-correlation infoHash backfill helpers.
 *
 * Covers the pure-logic seams (`extractMovieFingerprint`, `buildSearchIndex`,
 * `findMatch`) without spinning up a Prisma DB or qui client mock. The
 * scheduler-driven `runPathBackfillSweep` itself is exercised by the
 * cleanup-executor / scheduler integration tests; here we lock down the
 * matching semantics that the entire feature depends on.
 *
 * The two strategies pinned by these tests:
 *   1. **Exact path match** via `savePath + "/" + name` — works when
 *      *arr and qui see identical paths.
 *   2. **`(name, size)` fingerprint** — catches the hardlinked case
 *      where qui's path differs from *arr's path but the file content
 *      is identical (same name + same byte count).
 *
 * Regressions either of those silently breaks "find me my torrents
 * via hardlink" for ~50%+ of the library on a typical setup, so the
 * tests are written to fail loudly on any drift.
 */

import { describe, expect, it } from "vitest";
import { __testOnly } from "../infohash-backfill-by-path.js";

const { extractMovieFingerprint, buildSearchIndex, findMatch } = __testOnly;

// Realistic Radarr movieFile shape (subset of fields the matcher reads).
function makeRadarrCacheData(
	overrides?: Partial<{
		path: string;
		relativePath: string;
		size: number;
		title: string;
		year: number | null;
	}>,
) {
	return JSON.stringify({
		id: 3603,
		title: overrides?.title ?? "After.Life",
		year: overrides?.year === null ? undefined : (overrides?.year ?? 2009),
		path: overrides?.path ?? "/data/media/movies/After.Life (2009) {tmdb-36419}",
		movieFile: {
			id: 1939,
			relativePath:
				overrides?.relativePath ??
				"After.Life (2009) {tmdb-36419} - [Repack2 v3][Remux-1080p Proper][DTS-HD MA 5.1][AVC]-KRaLiMaRKo.mkv",
			size: overrides?.size ?? 24_518_693_624,
		},
	});
}

function makeQuiTorrent(overrides: { hash: string; name: string; savePath: string; size: number }) {
	// Only the fields the matcher reads — the real QuiTorrent shape has many
	// more, but the search-index builder is a structural-typing duck-type.
	return {
		hash: overrides.hash,
		name: overrides.name,
		savePath: overrides.savePath,
		size: overrides.size,
		// Filler — present on the real shape but unused by the matcher.
		state: "uploading" as const,
		ratio: 1.5,
		progress: 1,
		numSeeds: 0,
		numLeechs: 0,
		tags: [] as string[],
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

describe("extractMovieFingerprint", () => {
	it("pulls path / filename / size from a typical Radarr movieFile blob", () => {
		const fp = extractMovieFingerprint(makeRadarrCacheData());
		expect(fp).not.toBeNull();
		expect(fp?.libraryPath).toBe(
			"/data/media/movies/After.Life (2009) {tmdb-36419}/After.Life (2009) {tmdb-36419} - [Repack2 v3][Remux-1080p Proper][DTS-HD MA 5.1][AVC]-KRaLiMaRKo.mkv",
		);
		expect(fp?.filename).toBe(
			"After.Life (2009) {tmdb-36419} - [Repack2 v3][Remux-1080p Proper][DTS-HD MA 5.1][AVC]-KRaLiMaRKo.mkv",
		);
		expect(fp?.size).toBe(24_518_693_624);
	});

	it("trims trailing slashes off the path before joining the filename", () => {
		const fp = extractMovieFingerprint(
			makeRadarrCacheData({ path: "/data/media/movies/Foo/", relativePath: "file.mkv" }),
		);
		// Pre-fix versions could produce `/data/media/movies/Foo//file.mkv`
		// which `qui.savePath` will NEVER match (qBit normalises paths).
		expect(fp?.libraryPath).toBe("/data/media/movies/Foo/file.mkv");
	});

	it("returns null when movieFile is absent (unmonitored or no file yet)", () => {
		const raw = JSON.stringify({
			id: 1,
			title: "Untouched",
			path: "/data/media/movies/Untouched",
			// movieFile omitted
		});
		expect(extractMovieFingerprint(raw)).toBeNull();
	});

	it("returns null on malformed JSON rather than throwing", () => {
		expect(extractMovieFingerprint("{not-json}")).toBeNull();
	});

	it("returns null when size is missing or non-numeric", () => {
		const raw = JSON.stringify({
			path: "/data/media/movies/X",
			movieFile: { relativePath: "x.mkv" /* no size */ },
		});
		expect(extractMovieFingerprint(raw)).toBeNull();
	});
});

describe("buildSearchIndex + findMatch", () => {
	const fp = extractMovieFingerprint(
		makeRadarrCacheData({
			path: "/data/media/movies/After.Life (2009)",
			relativePath: "After.Life.mkv",
			size: 24_518_693_624,
		}),
	);

	it("matches via savePath + name (path-identical case)", () => {
		// qui sees the same on-disk path *arr sees — the common
		// single-host / shared-volume setup.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "deadbeef".repeat(5),
				name: "After.Life.mkv",
				savePath: "/data/media/movies/After.Life (2009)",
				size: 24_518_693_624,
			}),
		]);
		expect(findMatch(fp!, index)).toEqual({ hash: "deadbeef".repeat(5), source: "path-exact" });
	});

	it("matches via (name, size) fingerprint when paths differ (HARDLINK CASE)", () => {
		// qui sees the download path (/data/torrents/...), *arr sees the
		// library path (/data/media/...). Different strings, same inode.
		// The fingerprint pass MUST catch this — otherwise hardlinked
		// imports never get correlated, defeating the purpose of this
		// whole module.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "abcdef".repeat(10),
				name: "After.Life.mkv",
				savePath: "/data/torrents/movies/After.Life (2009)",
				size: 24_518_693_624,
			}),
		]);
		expect(findMatch(fp!, index)).toEqual({ hash: "abcdef".repeat(10), source: "name-size" });
	});

	it("does NOT match when filename matches but size differs (different release)", () => {
		// Same filename, different size — almost always means a different
		// release (e.g., re-encode, repack at a different quality). We
		// MUST NOT correlate these; doing so would write the wrong hash
		// to library_cache and stale torrent state would propagate.
		// Note: this is the FINGERPRINT pass; the size-only fallback can't
		// rescue it either because there's no size match at all.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "wronghash".padEnd(40, "0"),
				name: "After.Life.mkv",
				savePath: "/somewhere/else",
				size: 1_000_000_000, // Different from the library's size
			}),
		]);
		expect(findMatch(fp!, index)).toBeNull();
	});

	it("matches via size + title+year when *arr renamed the file (RENAME + HARDLINK CASE)", () => {
		// The most common real-world case: *arr renames the imported file
		// from `Some.Release.Name.mkv` → `Title (Year) {tmdb-NNN} ...mkv`.
		// qui still shows the original release name. Path and filename
		// differ — only the byte-exact size survives the rename. We
		// corroborate by requiring qui's name to contain every non-
		// stopword token from *arr's title AND the year.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "renamehash".padEnd(40, "0"),
				name: "After.Life.2009.Repack.1080p.Blu-ray.Remux-KRaLiMaRKo", // ORIGINAL release name
				savePath: "/data/torrents/movies/After.Life (2009)",
				size: 24_518_693_624,
			}),
		]);
		expect(findMatch(fp!, index)).toEqual({
			hash: "renamehash".padEnd(40, "0"),
			source: "title-year",
		});
	});

	it("REJECTS size-match when title tokens don't appear in qui name (unrelated content)", () => {
		// Two unrelated movies can have the same byte size — pre-fix
		// versions would write the wrong hash here. Title+year check
		// catches it: "After.Life" tokens [after, life] don't appear
		// in "Spider-Man.2009.1080p..." → reject.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "wronghash".padEnd(40, "0"),
				name: "Spider-Man.2009.1080p.Blu-ray.Remux-FooBar",
				savePath: "/wherever",
				size: 24_518_693_624, // exact size collision with After.Life
			}),
		]);
		expect(findMatch(fp!, index)).toBeNull();
	});

	it("REJECTS size-match when year differs even if title tokens overlap (remake case)", () => {
		// Remakes share title but have different years. Without the
		// year check, "Lord.of.the.Flies" (1963) would happily match
		// "Lord.of.the.Flies" (1990) — both titles tokenize identically.
		const fp1963 = extractMovieFingerprint(
			makeRadarrCacheData({
				title: "Lord of the Flies",
				year: 1963,
				size: 10_000_000_000,
				relativePath: "Lord.of.the.Flies.1963.mkv",
				path: "/data/media/movies/Lord of the Flies (1963)",
			}),
		);
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "remakehash".padEnd(40, "0"),
				name: "Lord.of.the.Flies.1990.1080p.WEB-DL", // different year
				savePath: "/somewhere",
				size: 10_000_000_000, // size collides
			}),
		]);
		expect(findMatch(fp1963!, index)).toBeNull();
	});

	it("ABSTAINS when multiple qui torrents at the same size BOTH pass title+year (ambiguous)", () => {
		// Extreme edge case: same title, same year, same size — e.g.,
		// the user has two copies of the same release in qui (different
		// trackers). We have no way to disambiguate which one *arr's
		// library copy is hardlinked from, so we refuse to guess.
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "a".repeat(40),
				name: "After.Life.2009.Repack.1080p.Blu-ray.Remux-KRaLiMaRKo",
				savePath: "/data/torrents/site-a",
				size: 24_518_693_624,
			}),
			makeQuiTorrent({
				hash: "b".repeat(40),
				name: "After.Life.2009.Repack.1080p.Blu-ray.Remux-KRaLiMaRKo",
				savePath: "/data/torrents/site-b",
				size: 24_518_693_624,
			}),
		]);
		expect(findMatch(fp!, index)).toBeNull();
	});

	it("returns null when no torrent matches any strategy", () => {
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "x".repeat(40),
				name: "Some.Other.Movie.mkv",
				savePath: "/data/torrents/movies/Other",
				size: 999,
			}),
		]);
		expect(findMatch(fp!, index)).toBeNull();
	});

	it("indexes BOTH savePath+name AND savePath alone (multi-file torrent case)", () => {
		// Some torrents are multi-file (e.g., a season pack). qBit's
		// savePath points at the torrent's folder, and the files live
		// inside. *arr's series-level row would point at the folder
		// too. Indexing the bare savePath catches that case.
		const seriesFolder = "/data/media/tv/Some Show/Season 01";
		const index = buildSearchIndex([
			makeQuiTorrent({
				hash: "seasonpackhash".padEnd(40, "0"),
				name: "Some.Show.S01",
				savePath: seriesFolder,
				size: 100_000_000_000,
			}),
		]);
		const folderMatch = findMatch(
			{ libraryPath: seriesFolder, filename: "any", size: 1, arrTitle: "Some Show", arrYear: 2020 },
			index,
		);
		expect(folderMatch).toEqual({
			hash: "seasonpackhash".padEnd(40, "0"),
			source: "path-exact",
		});
	});
});
