import { describe, expect, it } from "vitest";
import {
	decodePlexGenerationMetadata,
	encodeAuthoritativePlexGenerationMetadata,
	evaluatePlexMutationAuthority,
	evaluatePublishedPlexGeneration,
} from "../plex-generation-metadata.js";

const sections = [{ key: "movies", title: "Movies", type: "movie" as const }];

function status(overrides: Record<string, unknown> = {}) {
	return {
		lastResult: "success",
		lastErrorMessage: null,
		lastRefreshedAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		generationId: "generation-1",
		generationMetadata: JSON.stringify({ sections }),
		itemCount: 1,
		...overrides,
	};
}

describe("Plex generation metadata", () => {
	it("normalizes legacy sections-only metadata as authoritative", () => {
		expect(decodePlexGenerationMetadata(JSON.stringify({ sections }))).toEqual({
			ok: true,
			metadata: {
				version: 1,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: null,
				sections,
			},
		});
	});

	it("decodes a valid V2 authoritative envelope", () => {
		const encoded = JSON.stringify({
			version: 2,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
			sections,
		});

		expect(decodePlexGenerationMetadata(encoded)).toEqual({
			ok: true,
			metadata: {
				version: 2,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				sections,
			},
		});
	});

	it.each([
		["unknown version", JSON.stringify({ version: 3, sections }), "unknown_metadata_version"],
		["null", null, "missing_metadata"],
		["missing", undefined, "missing_metadata"],
		["invalid JSON", "{", "malformed_metadata"],
	])("fails closed for %s metadata", (_name, input, reasonCode) => {
		expect(decodePlexGenerationMetadata(input)).toEqual({ ok: false, reasonCode });
	});

	it.each([
		[{ key: 4, title: "Movies", type: "movie" }],
		[{ key: "movies", title: "Movies", type: "artist" }],
		[{ key: "", title: "Movies", type: "movie" }],
	])("rejects invalid section metadata", (invalidSections) => {
		expect(decodePlexGenerationMetadata(JSON.stringify({ sections: invalidSections }))).toEqual({
			ok: false,
			reasonCode: "invalid_sections",
		});
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects an invalid item count %s",
		(itemCount) => {
			expect(
				decodePlexGenerationMetadata(
					JSON.stringify({
						version: 2,
						publicationLevel: "authoritative",
						completeness: "complete",
						itemCount,
						sections,
					}),
				),
			).toEqual({ ok: false, reasonCode: "invalid_item_count" });
		},
	);

	it("rejects duplicate or contradictory section keys", () => {
		const duplicated = [...sections, { key: "movies", title: "Films", type: "movie" as const }];
		expect(decodePlexGenerationMetadata(JSON.stringify({ sections: duplicated }))).toEqual({
			ok: false,
			reasonCode: "duplicate_sections",
		});
	});

	it("keeps top-level sections and excludes target identities in new metadata", () => {
		const parsed = JSON.parse(
			encodeAuthoritativePlexGenerationMetadata({ sections, itemCount: 1 }),
		) as Record<string, unknown>;

		expect(parsed).toEqual({
			version: 2,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
			sections,
		});
		expect(parsed).not.toHaveProperty("targets");
		expect(parsed).not.toHaveProperty("ratingKeys");
	});

	it("keeps immutable authoritative publication facts but withholds current trust after failure", () => {
		const result = evaluatePublishedPlexGeneration(
			status({
				lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "upstream unavailable",
			}),
			{ now: new Date("2026-08-20T14:00:00.000Z"), maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toMatchObject({
			available: true,
			generationId: "generation-1",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: {
					generationId: "generation-1",
					publicationLevel: "authoritative",
					publishedAt: "2026-08-20T12:00:00.000Z",
					itemCount: 1,
				},
			},
		});
	});

	it("normalizes an opaque in-progress token without exposing it", () => {
		const token = "in_progress:secret-attempt-token";
		const result = evaluatePublishedPlexGeneration(status({ lastAttemptResult: token }), {
			now: new Date("2026-08-20T14:00:00.000Z"),
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				publicationLevel: "unavailable",
				reasonCodes: ["latest_attempt_in_progress"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("reports a future-dated attempt explicitly even when it also carries an error", () => {
		const result = evaluatePublishedPlexGeneration(
			status({
				lastAttemptAt: new Date("2026-08-20T14:00:01.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "clock skew",
			}),
			{ now: new Date("2026-08-20T14:00:00.000Z"), maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_future_dated"],
			},
		});
	});

	it("recognizes a future positive-only publication without granting mutation authority", () => {
		const partialMetadata = JSON.stringify({
			version: 2,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: 1,
			sections,
		});
		const partialStatus = status({
			generationMetadata: partialMetadata,
			lastAttemptResult: "partial",
		});
		const options = {
			now: new Date("2026-08-20T14:00:00.000Z"),
			maxAgeMs: 3 * 60 * 60 * 1000,
		};

		expect(evaluatePublishedPlexGeneration(partialStatus, options)).toMatchObject({
			available: true,
			evidence: {
				availability: "current",
				authority: "positive-only",
				attemptState: "partial",
				publicationLevel: "positive-only",
				completeness: "partial",
				reasonCodes: ["latest_attempt_partial"],
				publishedGeneration: { publicationLevel: "positive-only" },
			},
		});
		expect(evaluatePlexMutationAuthority(partialStatus, options).available).toBe(false);
	});

	it("bases freshness on the published generation timestamp", () => {
		const result = evaluatePublishedPlexGeneration(
			status({
				lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z"),
				lastAttemptAt: new Date("2026-08-20T13:59:00.000Z"),
				lastAttemptResult: "error",
			}),
			{ now: new Date("2026-08-20T14:00:00.000Z"), maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toEqual({
			available: false,
			evidence: {
				availability: "unavailable",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["published_generation_stale"],
			},
		});
	});

	it("rejects a published generation timestamp in the future", () => {
		const result = evaluatePublishedPlexGeneration(
			status({ lastRefreshedAt: new Date("2026-08-20T14:00:01.000Z") }),
			{ now: new Date("2026-08-20T14:00:00.000Z"), maxAgeMs: 3 * 60 * 60 * 1000 },
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["published_timestamp_changed"] },
		});
	});

	it("rejects success without a usable generation id", () => {
		expect(
			evaluatePublishedPlexGeneration(status({ generationId: null }), {
				now: new Date("2026-08-20T14:00:00.000Z"),
				maxAgeMs: 3 * 60 * 60 * 1000,
			}),
		).toMatchObject({
			available: false,
			evidence: {
				availability: "unavailable",
				authority: "unavailable",
				attemptState: "success",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["missing_generation_id"],
			},
		});
	});

	it.each([
		["successful latest attempt", {}, true, "current", "authoritative", "success", true],
		[
			"missing latest-attempt result",
			{ lastAttemptResult: null },
			true,
			"last-known",
			"unavailable",
			"unknown",
			false,
		],
		[
			"missing latest-attempt timestamp",
			{ lastAttemptAt: null },
			true,
			"last-known",
			"unavailable",
			"success",
			false,
		],
		[
			"future-dated latest-attempt timestamp",
			{ lastAttemptAt: new Date("2026-08-20T14:00:01.000Z") },
			true,
			"last-known",
			"unavailable",
			"success",
			false,
		],
		[
			"failed latest attempt",
			{ lastAttemptResult: "error", lastAttemptErrorMessage: "inventory changed" },
			true,
			"last-known",
			"unavailable",
			"error",
			false,
		],
		[
			"in-progress latest attempt",
			{ lastAttemptResult: "in_progress:opaque" },
			true,
			"last-known",
			"unavailable",
			"in_progress",
			false,
		],
		[
			"unknown latest-attempt result",
			{ lastAttemptResult: "mystery" },
			true,
			"last-known",
			"unavailable",
			"unknown",
			false,
		],
		[
			"authoritative publication with partial latest attempt",
			{ lastAttemptResult: "partial", lastAttemptErrorMessage: "inventory incomplete" },
			true,
			"last-known",
			"unavailable",
			"partial",
			false,
		],
		[
			"stale publication",
			{ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") },
			false,
			"unavailable",
			"unavailable",
			"success",
			false,
		],
		[
			"future-dated publication",
			{ lastRefreshedAt: new Date("2026-08-20T14:00:01.000Z") },
			false,
			"unavailable",
			"unavailable",
			"success",
			false,
		],
		[
			"missing generation",
			{ generationId: null },
			false,
			"unavailable",
			"unavailable",
			"success",
			false,
		],
		[
			"malformed metadata",
			{ generationMetadata: "{" },
			false,
			"unavailable",
			"unavailable",
			"success",
			false,
		],
		["subsequent successful refresh", {}, true, "current", "authoritative", "success", true],
	] as const)(
		"separates published observation from mutation authority for %s",
		(_caseName, overrides, observationAvailable, availability, authority, attemptState, mutationAvailable) => {
			const options = {
				now: new Date("2026-08-20T14:00:00.000Z"),
				maxAgeMs: 3 * 60 * 60 * 1000,
			};
			const observation = evaluatePublishedPlexGeneration(status(overrides), options);
			const mutation = evaluatePlexMutationAuthority(status(overrides), options);

			expect(observation.available).toBe(observationAvailable);
			expect(observation.evidence).toMatchObject({ availability, authority, attemptState });
			expect(mutation.available).toBe(mutationAvailable);
		},
	);
});
