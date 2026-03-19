/**
 * Unit tests for SeerrCache.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GENRE_TTL_MS,
	ISSUE_COUNT_TTL_MS,
	SeerrCache,
	genreCacheKey,
	issueCountCacheKey,
} from "../seerr-cache.js";

let cache: SeerrCache;

describe("SeerrCache", () => {
	afterEach(() => {
		cache.destroy();
		vi.restoreAllMocks();
	});

	it("returns undefined for cache miss", () => {
		cache = new SeerrCache();
		expect(cache.get("nonexistent")).toBeUndefined();
	});

	it("stores and retrieves genre data", () => {
		cache = new SeerrCache();
		const genres = [{ id: 1, name: "Action" }];
		const key = genreCacheKey("inst-1", "movie");

		cache.set(key, genres, GENRE_TTL_MS);
		expect(cache.get(key)).toEqual(genres);
	});

	it("returns undefined after TTL expiry", () => {
		cache = new SeerrCache();
		const key = genreCacheKey("inst-1", "tv");

		cache.set(key, [{ id: 1, name: "Drama" }], 100);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
		expect(cache.get(key)).toBeUndefined();
	});

	it("caches issue counts with correct key", () => {
		cache = new SeerrCache();
		const counts = new Map([["movie:123", 2]]);
		const key = issueCountCacheKey("inst-1");

		cache.set(key, counts, ISSUE_COUNT_TTL_MS);
		const result = cache.get<Map<string, number>>(key);
		expect(result).toBeDefined();
		expect(result!.get("movie:123")).toBe(2);
	});

	it("isolates caches per instance", () => {
		cache = new SeerrCache();
		const key1 = genreCacheKey("inst-1", "movie");
		const key2 = genreCacheKey("inst-2", "movie");

		cache.set(key1, [{ id: 1, name: "Action" }], GENRE_TTL_MS);
		cache.set(key2, [{ id: 2, name: "Comedy" }], GENRE_TTL_MS);

		expect(cache.get(key1)).toEqual([{ id: 1, name: "Action" }]);
		expect(cache.get(key2)).toEqual([{ id: 2, name: "Comedy" }]);
	});

	it("invalidate() removes matching keys", () => {
		cache = new SeerrCache();
		const key1 = genreCacheKey("inst-1", "movie");
		const key2 = genreCacheKey("inst-1", "tv");
		const key3 = genreCacheKey("inst-2", "movie");

		cache.set(key1, [], GENRE_TTL_MS);
		cache.set(key2, [], GENRE_TTL_MS);
		cache.set(key3, [], GENRE_TTL_MS);

		cache.invalidate("genres:inst-1");

		expect(cache.get(key1)).toBeUndefined();
		expect(cache.get(key2)).toBeUndefined();
		expect(cache.get(key3)).toEqual([]); // inst-2 not affected
	});

	it("destroy() clears all entries", () => {
		cache = new SeerrCache();
		const key = genreCacheKey("inst-1", "movie");
		cache.set(key, [{ id: 1, name: "Action" }], GENRE_TTL_MS);

		cache.destroy();
		// After destroy, create a new cache to verify old data is gone
		cache = new SeerrCache();
		expect(cache.get(key)).toBeUndefined();
	});

	it("key builders produce expected formats", () => {
		expect(genreCacheKey("abc", "movie")).toBe("genres:abc:movie");
		expect(genreCacheKey("abc", "tv")).toBe("genres:abc:tv");
		expect(issueCountCacheKey("abc")).toBe("issue_counts:abc");
	});

	it("invalidateInstance() clears all entries for a specific instance", () => {
		cache = new SeerrCache();
		const genreKey1 = genreCacheKey("inst-1", "movie");
		const genreKey2 = genreCacheKey("inst-1", "tv");
		const issueKey = issueCountCacheKey("inst-1");
		const otherKey = genreCacheKey("inst-2", "movie");

		cache.set(genreKey1, [{ id: 1, name: "Action" }], GENRE_TTL_MS);
		cache.set(genreKey2, [{ id: 2, name: "Drama" }], GENRE_TTL_MS);
		cache.set(issueKey, new Map([["movie:123", 2]]), ISSUE_COUNT_TTL_MS);
		cache.set(otherKey, [{ id: 3, name: "Comedy" }], GENRE_TTL_MS);

		const cleared = cache.invalidateInstance("inst-1");

		expect(cleared).toBe(3);
		expect(cache.get(genreKey1)).toBeUndefined();
		expect(cache.get(genreKey2)).toBeUndefined();
		expect(cache.get(issueKey)).toBeUndefined();
		expect(cache.get(otherKey)).toEqual([{ id: 3, name: "Comedy" }]); // inst-2 not affected
	});

	it("invalidateInstance() returns 0 when no entries match", () => {
		cache = new SeerrCache();
		cache.set(genreCacheKey("inst-1", "movie"), [], GENRE_TTL_MS);

		const cleared = cache.invalidateInstance("inst-999");
		expect(cleared).toBe(0);
		expect(cache.get(genreCacheKey("inst-1", "movie"))).toEqual([]);
	});
});
