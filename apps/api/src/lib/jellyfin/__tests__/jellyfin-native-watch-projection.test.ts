import { describe, expect, it, vi } from "vitest";
import {
	deriveNativeWatchCandidates,
	type NativeWatchStageRow,
} from "../jellyfin-native-watch-projection.js";

const one: NativeWatchStageRow = {
	userKeyDigest: "user-a",
	libraryId: "library-a",
	jellyfinId: "episode-a",
	seriesId: "series-a",
	seasonNumber: 1,
	episodeNumber: 2,
	played: false,
	playCount: 0,
	lastPlayedAt: null,
};

describe("deriveNativeWatchCandidates", () => {
	it("reports three changed coordinates only in the affected scope and isolates callback failures", () => {
		const changed = Array.from({ length: 3 }, (_, i) => ({ ...one, jellyfinId: `changed-${i}` }));
		const sibling = { ...one, libraryId: "library-b" };
		const scoped = vi.fn();
		expect(
			deriveNativeWatchCandidates(
				[...changed, sibling],
				[...changed.map((row) => ({ ...row, played: true })), sibling],
				() => {
					throw new Error("aggregate observer");
				},
				scoped,
			),
		).toEqual([sibling]);
		expect(scoped.mock.calls[0]![0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					libraryId: "library-a",
					diagnostics: expect.objectContaining({ changedObservationCoordinates: 3 }),
				}),
				expect.objectContaining({
					libraryId: "library-b",
					diagnostics: expect.objectContaining({ changedObservationCoordinates: 0 }),
				}),
			]),
		);
		expect(
			deriveNativeWatchCandidates([one], [one], undefined, () => {
				throw new Error("scope observer");
			}),
		).toEqual([one]);
	});

	it("attributes cross-scope conflicts, invalid rows, duplicates, missing and verify-only coordinates locally", () => {
		const conflict = { ...one, libraryId: "library-b", seriesId: "conflict" };
		const duplicate = { ...one, jellyfinId: "duplicate" };
		const missing = { ...one, jellyfinId: "missing" };
		const invalid = { ...one, jellyfinId: "invalid", episodeNumber: -1 };
		const only = { ...one, libraryId: "library-c", jellyfinId: "verify-only" };
		const scoped = vi.fn();
		expect(
			deriveNativeWatchCandidates(
				[one, conflict, duplicate, duplicate, missing, invalid],
				[one, conflict, duplicate, only, invalid],
				undefined,
				scoped,
			),
		).toEqual([]);
		const scopes = scoped.mock.calls[0]![0];
		expect(scopes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					libraryId: "library-a",
					diagnostics: expect.objectContaining({
						conflictedCoordinates: 1,
						duplicateCollectCoordinates: 1,
						missingVerifyCoordinates: 1,
						invalidCollectRows: 1,
						invalidVerifyRows: 1,
					}),
				}),
				expect.objectContaining({
					libraryId: "library-b",
					diagnostics: expect.objectContaining({ conflictedCoordinates: 1 }),
				}),
				expect.objectContaining({
					libraryId: "library-c",
					diagnostics: expect.objectContaining({ verifyOnlyCoordinates: 1 }),
				}),
			]),
		);
	});
	it("admits matching false observations as an exact native negative", () => {
		expect(deriveNativeWatchCandidates([one], [{ ...one }])).toEqual([one]);
	});

	it("admits matching true observations without a TMDB mapping", () => {
		const watched = { ...one, played: true, playCount: 2, lastPlayedAt: new Date("2026-01-01") };
		expect(
			deriveNativeWatchCandidates(
				[watched],
				[{ ...watched, lastPlayedAt: new Date("2026-01-01") }],
			),
		).toEqual([watched]);
	});

	it("keeps both users distinct and sorts the stable coordinates", () => {
		const other = { ...one, userKeyDigest: "user-b", played: true, playCount: 1 };
		expect(deriveNativeWatchCandidates([other, one], [one, other])).toEqual([one, other]);
	});

	it("rejects a changed played value", () => {
		expect(deriveNativeWatchCandidates([one], [{ ...one, played: true }])).toEqual([]);
	});

	it("rejects a changed play count or last-played timestamp", () => {
		expect(deriveNativeWatchCandidates([one], [{ ...one, playCount: 1 }])).toEqual([]);
		expect(
			deriveNativeWatchCandidates([one], [{ ...one, lastPlayedAt: new Date("2026-01-01") }]),
		).toEqual([]);
	});

	it("does not infer an unwatched value from a missing verify row", () => {
		expect(deriveNativeWatchCandidates([one], [])).toEqual([]);
	});

	it("rejects a duplicate native ID in either pass", () => {
		expect(deriveNativeWatchCandidates([one, one], [one])).toEqual([]);
		expect(deriveNativeWatchCandidates([one], [one, one])).toEqual([]);
	});

	it.each([
		{
			pass: "collect",
			conflicting: false,
			conflicts: 0,
			collectDuplicates: 1,
			verifyDuplicates: 0,
		},
		{ pass: "verify", conflicting: false, conflicts: 0, collectDuplicates: 0, verifyDuplicates: 1 },
		{ pass: "collect", conflicting: true, conflicts: 1, collectDuplicates: 0, verifyDuplicates: 0 },
		{ pass: "verify", conflicting: true, conflicts: 1, collectDuplicates: 0, verifyDuplicates: 0 },
	])(
		"keeps three $pass duplicates rejected with conflict=$conflicting without losing unrelated evidence",
		({ pass, conflicting, conflicts, collectDuplicates, verifyDuplicates }) => {
			const unaffected = { ...one, jellyfinId: "episode-unaffected" };
			const third = { ...one, seriesId: conflicting ? "different-series" : one.seriesId };
			const repeated = [one, { ...one }, third, unaffected];
			const unique = [{ ...one }, unaffected];
			let diagnostics: unknown;
			const candidates = deriveNativeWatchCandidates(
				pass === "collect" ? repeated : unique,
				pass === "verify" ? repeated : unique,
				(value) => {
					diagnostics = value;
				},
			);
			expect(candidates).toEqual([unaffected]);
			expect(diagnostics).toEqual({
				invalidCollectRows: 0,
				invalidVerifyRows: 0,
				conflictedCoordinates: conflicts,
				duplicateCollectCoordinates: collectDuplicates,
				missingVerifyCoordinates: 0,
				duplicateVerifyCoordinates: verifyDuplicates,
				changedObservationCoordinates: 0,
				verifyOnlyCoordinates: 0,
			});
			expect(repeated).toEqual([one, { ...one }, third, unaffected]);
		},
	);

	it("rejects a cross-library native ID with conflicting parent coordinates", () => {
		const collision = { ...one, libraryId: "library-b", seriesId: "series-b" };
		expect(deriveNativeWatchCandidates([one, collision], [one, collision])).toEqual([]);
	});

	it("reports a global identity conflict in a scope where the coordinate is verify-only", () => {
		const stableA = { ...one, played: true, playCount: 1 };
		const stableB = {
			...stableA,
			libraryId: "library-b",
			jellyfinId: "episode-b",
			episodeNumber: 6,
		};
		const collectOnly = { ...one, jellyfinId: "episode-c", episodeNumber: 3 };
		const verifyOnly = { ...one, jellyfinId: "episode-d", episodeNumber: 4 };
		const collision = { ...verifyOnly, libraryId: "library-b", episodeNumber: 5 };
		const replacement = { ...collision, jellyfinId: "episode-e" };
		const report = vi.fn();
		const scoped = vi.fn();
		expect(
			deriveNativeWatchCandidates(
				[stableA, collectOnly, stableB, collision],
				[stableA, verifyOnly, stableB, replacement],
				report,
				scoped,
			),
		).toEqual([stableA, stableB]);
		expect(scoped).toHaveBeenCalledWith([
			expect.objectContaining({
				libraryId: "library-a",
				verifyOnlyConflictedCoordinates: 1,
				diagnostics: expect.objectContaining({
					conflictedCoordinates: 0,
					missingVerifyCoordinates: 1,
					verifyOnlyCoordinates: 1,
				}),
			}),
			expect.objectContaining({
				libraryId: "library-b",
				verifyOnlyConflictedCoordinates: 0,
				diagnostics: expect.objectContaining({
					conflictedCoordinates: 1,
					verifyOnlyCoordinates: 1,
				}),
			}),
		]);
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ conflictedCoordinates: 1, verifyOnlyCoordinates: 2 }),
		);
	});

	it("keeps matching native coordinates from two library scopes", () => {
		const shared = { ...one, libraryId: "library-b" };
		expect(deriveNativeWatchCandidates([one, shared], [one, shared])).toEqual([one, shared]);
	});

	it("rejects a changed native parent or episode coordinate", () => {
		expect(deriveNativeWatchCandidates([one], [{ ...one, seriesId: "series-b" }])).toEqual([]);
		expect(deriveNativeWatchCandidates([one], [{ ...one, episodeNumber: 3 }])).toEqual([]);
	});

	it("rejects blank or invalid native coordinates", () => {
		expect(
			deriveNativeWatchCandidates([{ ...one, jellyfinId: " " }], [{ ...one, jellyfinId: " " }]),
		).toEqual([]);
		expect(
			deriveNativeWatchCandidates([{ ...one, episodeNumber: -1 }], [{ ...one, episodeNumber: -1 }]),
		).toEqual([]);
	});

	it("reports aggregate disagreement categories without changing admitted candidates", () => {
		const report = vi.fn();
		const missing = { ...one, jellyfinId: "episode-missing" };
		const changed = { ...one, jellyfinId: "episode-changed" };
		const duplicate = { ...one, jellyfinId: "episode-duplicate" };
		const verifyOnly = { ...one, jellyfinId: "episode-verify-only" };
		const invalid = { ...one, jellyfinId: " " };
		const candidates = deriveNativeWatchCandidates(
			[one, missing, changed, duplicate, duplicate, invalid],
			[one, { ...changed, played: true }, duplicate, verifyOnly, invalid],
			report,
		);

		expect(candidates).toEqual([one]);
		expect(report).toHaveBeenCalledWith({
			invalidCollectRows: 1,
			invalidVerifyRows: 1,
			conflictedCoordinates: 0,
			duplicateCollectCoordinates: 1,
			missingVerifyCoordinates: 1,
			duplicateVerifyCoordinates: 0,
			changedObservationCoordinates: 1,
			verifyOnlyCoordinates: 1,
		});
	});

	it("counts conflicting identity and duplicate verify coordinates once each", () => {
		const report = vi.fn();
		const conflicting = { ...one, libraryId: "library-b", seriesId: "series-b" };
		const duplicate = { ...one, jellyfinId: "episode-b" };
		expect(
			deriveNativeWatchCandidates(
				[one, conflicting, duplicate],
				[one, conflicting, duplicate, duplicate],
				report,
			),
		).toEqual([]);
		expect(report).toHaveBeenCalledWith({
			invalidCollectRows: 0,
			invalidVerifyRows: 0,
			conflictedCoordinates: 2,
			duplicateCollectCoordinates: 0,
			missingVerifyCoordinates: 0,
			duplicateVerifyCoordinates: 1,
			changedObservationCoordinates: 0,
			verifyOnlyCoordinates: 0,
		});
	});
});
