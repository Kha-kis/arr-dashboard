import { describe, expect, it } from "vitest";
import {
	deriveJellyfinMappedSeriesProgress,
	type JellyfinMappedSeriesObservation,
} from "../jellyfin-mapped-series-progress.js";

const bindingA = { libraryId: "library-a", seriesId: "series-a", tmdbId: 101 };
const bindingB = { libraryId: "library-a", seriesId: "series-b", tmdbId: 202 };
const bindingC = { libraryId: "library-c", seriesId: "series-c", tmdbId: 303 };

const a1 = {
	jellyfinId: "episode-a1",
	seriesId: bindingA.seriesId,
	seasonNumber: 1,
	episodeNumber: 1,
	played: true,
};
const a2 = { ...a1, jellyfinId: "episode-a2", episodeNumber: 2, played: false };
const b1 = { ...a1, jellyfinId: "episode-b1", seriesId: bindingB.seriesId };
const c1 = { ...a1, jellyfinId: "episode-c1", seriesId: bindingC.seriesId };

const aCoordinates = [
	{ seasonNumber: 1, episodeNumber: 1, watched: true },
	{ seasonNumber: 1, episodeNumber: 2, watched: false },
];

function scope(
	collect: readonly JellyfinMappedSeriesObservation[],
	verify = collect,
	userKeyDigest = "user-a",
	libraryId = "library-a",
) {
	return { libraryId, userKeyDigest, complete: true, collect, verify };
}

describe("deriveJellyfinMappedSeriesProgress", () => {
	it("keeps sorted watched and unwatched coordinates when B's play count and last-played time change", () => {
		const bCollect = { ...b1, playCount: 1, lastPlayedAt: new Date("2026-01-01") };
		const bVerify = { ...b1, playCount: 2, lastPlayedAt: new Date("2026-01-02") };

		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingB, bindingA],
			scopes: [scope([a2, bCollect, a1], [a1, a2, bVerify])],
		});

		expect([...result]).toEqual([
			[101, aCoordinates],
			[202, [{ seasonNumber: 1, episodeNumber: 1, watched: true }]],
		]);
	});

	it("drops B when its played state changes and retains A in the same library", () => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingB],
			scopes: [scope([a1, a2, b1], [a1, a2, { ...b1, played: false }])],
		});

		expect([...result]).toEqual([[101, aCoordinates]]);
	});

	it("ignores an unmapped neighbor with matching native membership", () => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA],
			scopes: [scope([a1, a2, b1])],
		});

		expect([...result]).toEqual([[101, aCoordinates]]);
	});

	it.each([
		["missing native ID", []],
		["changed native ID", [{ ...b1, jellyfinId: "other-native" }]],
		["changed series", [{ ...b1, seriesId: "other-series" }]],
		["changed coordinate", [{ ...b1, episodeNumber: 3 }]],
		["extra native ID", [b1, { ...b1, jellyfinId: "extra-native", episodeNumber: 3 }]],
		["duplicate native ID", [b1, b1]],
	] as const)("rejects the library for %s in an unmapped neighbor", (_reason, verify) => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingC],
			scopes: [scope([a1, a2, b1], [a1, a2, ...verify]), scope([c1], [c1], "user-a", "library-c")],
		});

		expect([...result]).toEqual([[303, [{ seasonNumber: 1, episodeNumber: 1, watched: true }]]]);
	});

	it("rejects a library with a missing or incomplete user scope", () => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingB, bindingC],
			scopes: [scope([a1, a2]), { ...scope([], [], "user-b"), complete: false }],
		});

		expect(result.size).toBe(0);
	});

	it("rejects a duplicate scope while keeping other libraries for that user", () => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingC],
			scopes: [scope([a1, a2]), scope([a1, a2]), scope([c1], [c1], "user-a", "library-c")],
		});

		expect([...result]).toEqual([[303, [{ seasonNumber: 1, episodeNumber: 1, watched: true }]]]);
	});

	it("merges the same native episodes across users with watched OR and preserves zero coordinates", () => {
		const special = { ...a2, jellyfinId: "special", seasonNumber: 0, episodeNumber: 0 };
		const watchedForB = { ...a2, played: true };
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA],
			scopes: [scope([a2, special]), scope([watchedForB, a1], [a1, watchedForB], "user-b")],
		});

		expect(result.get(101)).toEqual([
			{ seasonNumber: 0, episodeNumber: 0, watched: false },
			{ seasonNumber: 1, episodeNumber: 1, watched: true },
			{ seasonNumber: 1, episodeNumber: 2, watched: true },
		]);
	});

	it("rejects distinct native episode IDs at the same canonical coordinate across users", () => {
		const otherCopy = { ...b1, jellyfinId: "other-b1" };
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingB],
			scopes: [scope([a1, a2, b1]), scope([otherCopy], [otherCopy], "user-b")],
		});

		expect([...result]).toEqual([[101, aCoordinates]]);
	});

	it.each([
		["series", { ...b1, jellyfinId: a1.jellyfinId }],
		["coordinate", { ...a1, episodeNumber: 3 }],
	] as const)(
		"rejects a native ID reused at a conflicting %s across users",
		(_reason, conflict) => {
			const result = deriveJellyfinMappedSeriesProgress({
				bindings: [bindingA, bindingB, bindingC],
				scopes: [
					scope([a1, a2, b1]),
					scope([conflict], [conflict], "user-b"),
					scope([c1], [c1], "user-a", "library-c"),
				],
			});

			const retained = [{ seasonNumber: 1, episodeNumber: 1, watched: true }];
			expect([...result]).toEqual(
				conflict.seriesId === bindingA.seriesId
					? [
							[202, retained],
							[303, retained],
						]
					: [[303, retained]],
			);
		},
	);

	it("rejects a conflicting native ID from an incomplete library scope", () => {
		const conflicting = { ...c1, jellyfinId: a1.jellyfinId };
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingB, bindingC],
			scopes: [
				scope([a1, a2, b1]),
				{ ...scope([conflicting], [], "user-b", "library-c"), complete: false },
			],
		});

		expect([...result]).toEqual([[202, [{ seasonNumber: 1, episodeNumber: 1, watched: true }]]]);
	});

	it.each([
		["duplicate binding", bindingA],
		["one series with different TMDB IDs", { ...bindingA, tmdbId: 777 }],
		["multiple series with one TMDB ID", { ...bindingA, seriesId: "another-native-series" }],
	] as const)("drops ambiguous mappings for %s", (_reason, duplicate) => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingB, duplicate],
			scopes: [scope([a1, a2, b1])],
		});

		expect([...result]).toEqual([[202, [{ seasonNumber: 1, episodeNumber: 1, watched: true }]]]);
	});

	it.each([
		{ ...b1, jellyfinId: " " },
		{ ...b1, seasonNumber: -1 },
		{ ...b1, episodeNumber: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects a malformed observation even when both passes agree %#", (malformed) => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA],
			scopes: [scope([a1, a2, malformed])],
		});

		expect(result.size).toBe(0);
	});

	it("proves empty coordinates only for a verified binding with an explicit complete scope", () => {
		const result = deriveJellyfinMappedSeriesProgress({
			bindings: [bindingA, bindingC],
			scopes: [scope([])],
		});

		expect([...result]).toEqual([[101, []]]);
	});
});
