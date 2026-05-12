/**
 * Tests for hunt-executor's slim projection functions (issue #427).
 *
 * The six projectX functions normalize raw *arr API resources into compact
 * "slim" shapes that drop everything the hunt code doesn't read. Each one
 * is pure (no IO) but is the first line of defense against:
 *
 * 1. **Wrong-type fields from upstream** — a schema rename or producer bug
 *    can return `tags: "oops"` (string) where we expect `number[]`. The
 *    projection must coerce or reject, not crash downstream filters.
 *
 * 2. **Missing required fields** — id and parent FK (artistId/authorId)
 *    are load-bearing for Map joins. A record missing either is orphaned;
 *    we reject it at the projection boundary so the orphan count is
 *    measurable as "filtered before consideration" rather than vanishing
 *    silently into a `.get(undefined)` miss.
 *
 * 3. **`null` vs `undefined` for optional strings** — Lidarr returns
 *    `releaseDate: null` for un-released albums; the slim type promises
 *    `string | undefined`. Coercion keeps the type contract honest.
 *
 * 4. **Flattened nested fields** — `statistics.episodeFileCount` etc.
 *    are hoisted to the slim shape. A response with `statistics: null`
 *    or missing must default to 0, not throw.
 *
 * These are the most concentrated correctness risks in the slim-Map
 * refactor — pure-function tests cover them cheaply.
 */

import { describe, expect, it } from "vitest";
import {
	projectAlbum,
	projectArtist,
	projectAuthor,
	projectBook,
	projectMovie,
	projectSeries,
} from "../hunt-executor.js";

// ============================================================================
// SlimSeries
// ============================================================================

describe("projectSeries", () => {
	it("returns the full slim shape for a well-formed input", () => {
		const result = projectSeries({
			id: 42,
			title: "Severance",
			monitored: true,
			tags: [1, 2, 3],
			qualityProfileId: 5,
			status: "continuing",
			year: 2022,
			statistics: { episodeFileCount: 18 },
		});
		expect(result).toEqual({
			id: 42,
			title: "Severance",
			monitored: true,
			tags: [1, 2, 3],
			qualityProfileId: 5,
			status: "continuing",
			year: 2022,
			episodeFileCount: 18,
		});
	});

	it("returns null when id is missing", () => {
		expect(projectSeries({ title: "Orphan" })).toBeNull();
	});

	it("returns null when id is zero or negative", () => {
		expect(projectSeries({ id: 0, title: "Bad" })).toBeNull();
		expect(projectSeries({ id: -1, title: "Worse" })).toBeNull();
	});

	it("defaults missing optional fields to empty / zero / false", () => {
		const result = projectSeries({ id: 1 });
		expect(result).toEqual({
			id: 1,
			title: "",
			monitored: false,
			tags: [],
			qualityProfileId: 0,
			status: "",
			year: 0,
			episodeFileCount: 0,
		});
	});

	it("flattens statistics.episodeFileCount; defaults to 0 when statistics is missing", () => {
		expect(projectSeries({ id: 1, statistics: { episodeFileCount: 7 } })?.episodeFileCount).toBe(7);
		expect(projectSeries({ id: 1 })?.episodeFileCount).toBe(0);
		// Documents current behavior: a non-object `statistics` would crash at
		// downstream access. We rely on upstream Sonarr never returning that
		// shape — but the projection isn't defensive here.
	});

	it("preserves tags array as-is (does NOT validate element types)", () => {
		// Documents current behavior: a wrong-type `tags` is passed through.
		// Downstream `passesFilters` may not handle this gracefully — worth
		// noting but not blocking for the projection layer itself.
		const wrongType = projectSeries({ id: 1, tags: "oops" as unknown as number[] });
		expect(wrongType?.tags).toBe("oops");
	});
});

// ============================================================================
// SlimArtist
// ============================================================================

describe("projectArtist", () => {
	it("returns the full slim shape for a well-formed input", () => {
		const result = projectArtist({
			id: 100,
			artistName: "Radiohead",
			monitored: true,
			tags: [7],
			qualityProfileId: 3,
			status: "continuing",
		});
		expect(result).toEqual({
			id: 100,
			artistName: "Radiohead",
			monitored: true,
			tags: [7],
			qualityProfileId: 3,
			status: "continuing",
		});
	});

	it("returns null when id is missing or non-positive", () => {
		expect(projectArtist({ artistName: "No ID" })).toBeNull();
		expect(projectArtist({ id: 0, artistName: "Bad" })).toBeNull();
	});

	it("defaults missing fields", () => {
		expect(projectArtist({ id: 1 })).toEqual({
			id: 1,
			monitored: false,
			tags: [],
			qualityProfileId: 0,
			status: "",
			artistName: "",
		});
	});
});

// ============================================================================
// SlimAuthor
// ============================================================================

describe("projectAuthor", () => {
	it("returns the full slim shape for a well-formed input", () => {
		const result = projectAuthor({
			id: 200,
			authorName: "Brandon Sanderson",
			monitored: true,
			tags: [],
			qualityProfileId: 1,
			status: "continuing",
		});
		expect(result).toEqual({
			id: 200,
			authorName: "Brandon Sanderson",
			monitored: true,
			tags: [],
			qualityProfileId: 1,
			status: "continuing",
		});
	});

	it("returns null when id is missing", () => {
		expect(projectAuthor({ authorName: "No ID" })).toBeNull();
	});

	it("defaults missing fields", () => {
		expect(projectAuthor({ id: 5 })?.authorName).toBe("");
	});
});

// ============================================================================
// SlimMovie
// ============================================================================

describe("projectMovie", () => {
	it("returns the full slim shape with the release-date precedence rule applied", () => {
		const result = projectMovie({
			id: 10,
			title: "Inception",
			year: 2010,
			monitored: true,
			hasFile: true,
			tags: [1],
			qualityProfileId: 2,
			status: "released",
			digitalRelease: "2010-12-07T00:00:00Z",
			physicalRelease: "2011-12-07T00:00:00Z",
			inCinemas: "2010-07-16T00:00:00Z",
		});
		// digitalRelease wins under the digital || physical || cinemas precedence
		expect(result?.releaseDate).toBe("2010-12-07T00:00:00Z");
	});

	it("falls through to physicalRelease when digitalRelease is missing", () => {
		const result = projectMovie({
			id: 10,
			title: "X",
			physicalRelease: "2011-01-01",
			inCinemas: "2010-01-01",
		});
		expect(result?.releaseDate).toBe("2011-01-01");
	});

	it("falls through to inCinemas when both digital and physical are missing", () => {
		const result = projectMovie({ id: 10, title: "X", inCinemas: "2010-01-01" });
		expect(result?.releaseDate).toBe("2010-01-01");
	});

	it("returns undefined releaseDate when all three date fields are missing", () => {
		expect(projectMovie({ id: 10, title: "X" })?.releaseDate).toBeUndefined();
	});

	it("returns null when id is missing", () => {
		expect(projectMovie({ title: "Orphan" })).toBeNull();
	});

	it("defaults monitored/hasFile to false (not undefined)", () => {
		const result = projectMovie({ id: 1, title: "X" });
		expect(result?.monitored).toBe(false);
		expect(result?.hasFile).toBe(false);
	});
});

// ============================================================================
// SlimAlbum — the FK-required invariant fix
// ============================================================================

describe("projectAlbum", () => {
	it("returns the full slim shape for a well-formed input", () => {
		const result = projectAlbum({
			id: 50,
			title: "OK Computer",
			monitored: true,
			releaseDate: "1997-06-16",
			artistId: 100,
			statistics: { trackFileCount: 12 },
		});
		expect(result).toEqual({
			id: 50,
			title: "OK Computer",
			monitored: true,
			releaseDate: "1997-06-16",
			artistId: 100,
			trackFileCount: 12,
		});
	});

	it("returns null when id is missing", () => {
		expect(projectAlbum({ title: "No ID", artistId: 100 })).toBeNull();
	});

	it("returns null when artistId is missing — orphan record (FK invariant)", () => {
		// Pre-fix behavior would have allowed this through with artistId=0,
		// then artistMap.get(0) → undefined → silently filtered. The
		// reject-at-projection fix makes the orphan count measurable.
		expect(projectAlbum({ id: 50, title: "Orphan", artistId: 0 })).toBeNull();
		expect(projectAlbum({ id: 50, title: "Orphan" })).toBeNull();
	});

	it("normalizes releaseDate: null → undefined (matches slim type contract)", () => {
		// Lidarr returns `releaseDate: null` for un-released albums.
		// The slim type says `string | undefined`, so the projection
		// must coerce. Without this, downstream code that calls
		// `.startsWith()` on releaseDate would crash on null.
		const result = projectAlbum({
			id: 50,
			title: "Future",
			artistId: 100,
			releaseDate: null,
		});
		expect(result?.releaseDate).toBeUndefined();
	});

	it("flattens statistics.trackFileCount; defaults to 0 when missing", () => {
		expect(
			projectAlbum({ id: 50, title: "X", artistId: 100, statistics: { trackFileCount: 5 } })
				?.trackFileCount,
		).toBe(5);
		expect(projectAlbum({ id: 50, title: "X", artistId: 100 })?.trackFileCount).toBe(0);
	});
});

// ============================================================================
// SlimBook — the FK-required invariant fix (mirror of SlimAlbum)
// ============================================================================

describe("projectBook", () => {
	it("returns the full slim shape for a well-formed input", () => {
		const result = projectBook({
			id: 75,
			title: "The Way of Kings",
			monitored: true,
			releaseDate: "2010-08-31",
			authorId: 200,
			statistics: { bookFileCount: 1 },
		});
		expect(result).toEqual({
			id: 75,
			title: "The Way of Kings",
			monitored: true,
			releaseDate: "2010-08-31",
			authorId: 200,
			bookFileCount: 1,
		});
	});

	it("returns null when id is missing", () => {
		expect(projectBook({ title: "No ID", authorId: 200 })).toBeNull();
	});

	it("returns null when authorId is missing — orphan record (FK invariant)", () => {
		expect(projectBook({ id: 75, title: "Orphan", authorId: 0 })).toBeNull();
		expect(projectBook({ id: 75, title: "Orphan" })).toBeNull();
	});

	it("normalizes releaseDate: null → undefined", () => {
		const result = projectBook({
			id: 75,
			title: "Future",
			authorId: 200,
			releaseDate: null,
		});
		expect(result?.releaseDate).toBeUndefined();
	});

	it("flattens statistics.bookFileCount; defaults to 0 when missing", () => {
		expect(
			projectBook({ id: 75, title: "X", authorId: 200, statistics: { bookFileCount: 3 } })
				?.bookFileCount,
		).toBe(3);
		expect(projectBook({ id: 75, title: "X", authorId: 200 })?.bookFileCount).toBe(0);
	});
});
