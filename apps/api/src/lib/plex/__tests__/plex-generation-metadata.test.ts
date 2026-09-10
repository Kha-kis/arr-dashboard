import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	decodePlexGenerationMetadata,
	encodeAuthoritativePlexGenerationMetadata,
	evaluatePlexMutationAuthority,
	evaluatePublishedPlexGeneration,
} from "../plex-generation-metadata.js";

const sections = [{ key: "movies", title: "Movies", type: "movie" as const }];
const v3Sections = [
	{
		key: "movies",
		uuid: "section-uuid-movies",
		title: "Movies",
		type: "movie" as const,
		refreshing: false as const,
		scannedAt: 1_777_000_000,
		updatedAt: 1_777_000_100,
	},
];
const v3Roots = [
	{
		sectionKey: "movies",
		domain: "membership" as const,
		digest: "a".repeat(64),
	},
];
const showSection = {
	key: "shows",
	uuid: "section-uuid-shows",
	title: "Shows",
	type: "show" as const,
	refreshing: false as const,
	scannedAt: 1_777_000_000,
	updatedAt: 1_777_000_100,
};
const validV4Metadata = {
	version: 4,
	publicationLevel: "positive-only",
	completeness: "partial",
	itemCount: 1,
	canonicalizationVersion: 1,
	sections: [...v3Sections, showSection],
	observedRoots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
	capabilities: [
		{
			domain: "episode-parents",
			field: "membership",
			semantics: "observed-targets-only",
			operators: [],
		},
	],
	targetLedgerVersion: 1,
	targetCount: 1,
	targetDigest: "b".repeat(64),
	partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
} as const;
const v3Metadata = JSON.stringify({
	version: 3,
	publicationLevel: "authoritative",
	completeness: "complete",
	itemCount: 1,
	canonicalizationVersion: 1,
	sections: v3Sections,
	roots: v3Roots,
});

const completeCoverageReceipt = {
	version: 1,
	provider: "plex",
	attemptStartedAt: "2026-09-02T12:00:00.000Z",
	observedAt: "2026-09-02T12:00:01.000Z",
	evidence: "complete",
	units: [
		{
			scopeKey: "section:movies",
			expectedRawCount: 1,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: 1,
			sourceBindings: 1,
			canonicalEntities: 1,
			acceptedSkips: [],
			fatalCount: 0,
		},
	],
} as const;

const validV5AuthoritativeMetadata = JSON.stringify({
	version: 5,
	publicationLevel: "authoritative",
	completeness: "complete",
	itemCount: 1,
	canonicalizationVersion: 1,
	sections: v3Sections,
	roots: v3Roots,
	targetLedgerVersion: 1,
	targetCount: 1,
	targetDigest: "b".repeat(64),
	partialReasons: [],
	coverageReceipt: completeCoverageReceipt,
});

const validV5PositiveMetadata = JSON.stringify({
	...validV4Metadata,
	version: 5,
	coverageReceipt: { ...completeCoverageReceipt, evidence: "positive-only" },
});

function status(overrides: Record<string, unknown> = {}) {
	return {
		lastResult: "success",
		lastErrorMessage: null,
		lastRefreshedAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		generationId: "generation-1",
		generationMetadata: v3Metadata,
		itemCount: 1,
		...overrides,
	};
}

describe("Plex generation metadata", () => {
	it("rejects a partial V4 envelope that does not explain why it is partial", () => {
		expect(
			decodePlexGenerationMetadata(JSON.stringify({ ...validV4Metadata, partialReasons: [] })),
		).toEqual({ ok: false, reasonCode: "metadata_invalid" });
	});

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

	it("decodes a bounded V3 authoritative envelope", () => {
		expect(decodePlexGenerationMetadata(v3Metadata)).toEqual({
			ok: true,
			metadata: {
				version: 3,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				canonicalizationVersion: 1,
				sections: v3Sections,
				roots: v3Roots,
			},
		});
	});

	it("round-trips the source coverage receipt in authoritative metadata", () => {
		const encoded = encodeAuthoritativePlexGenerationMetadata({
			sections: v3Sections,
			itemCount: 1,
			canonicalizationVersion: 1,
			roots: v3Roots,
			targetLedger: {
				targetLedgerVersion: 1,
				targetCount: 1,
				targetDigest: "b".repeat(64),
			},
			partialReasons: [],
			coverageReceipt: completeCoverageReceipt,
		} as never);
		const parsed = JSON.parse(encoded) as Record<string, unknown>;

		expect(parsed).toMatchObject({
			version: 5,
			coverageReceipt: completeCoverageReceipt,
			targetLedgerVersion: 1,
			targetCount: 1,
			targetDigest: "b".repeat(64),
			partialReasons: [],
		});
		expect(decodePlexGenerationMetadata(encoded)).toMatchObject({
			ok: true,
			metadata: {
				version: 5,
				coverageReceipt: completeCoverageReceipt,
				targetLedgerVersion: 1,
				targetCount: 1,
				targetDigest: "b".repeat(64),
				partialReasons: [],
			},
		});
	});

	it("keeps authoritative and positive-only V5 envelopes as distinct exact variants", () => {
		const authoritative = JSON.parse(validV5AuthoritativeMetadata) as Record<string, unknown>;
		const positiveOnly = JSON.parse(validV5PositiveMetadata) as Record<string, unknown>;

		expect(authoritative).toEqual({
			version: 5,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
			canonicalizationVersion: 1,
			sections: v3Sections,
			roots: v3Roots,
			targetLedgerVersion: 1,
			targetCount: 1,
			targetDigest: "b".repeat(64),
			partialReasons: [],
			coverageReceipt: completeCoverageReceipt,
		});
		expect(authoritative).not.toHaveProperty("observedRoots");
		expect(authoritative).not.toHaveProperty("capabilities");

		expect(positiveOnly).toEqual({
			version: 5,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: 1,
			canonicalizationVersion: 1,
			sections: validV4Metadata.sections,
			observedRoots: validV4Metadata.observedRoots,
			capabilities: validV4Metadata.capabilities,
			targetLedgerVersion: 1,
			targetCount: 1,
			targetDigest: "b".repeat(64),
			partialReasons: validV4Metadata.partialReasons,
			coverageReceipt: { ...completeCoverageReceipt, evidence: "positive-only" },
		});
		expect(positiveOnly).not.toHaveProperty("roots");

		expect(decodePlexGenerationMetadata(validV5AuthoritativeMetadata)).toMatchObject({
			ok: true,
			metadata: authoritative,
		});
		expect(decodePlexGenerationMetadata(validV5PositiveMetadata)).toMatchObject({
			ok: true,
			metadata: positiveOnly,
		});
	});

	it.each([
		[
			"authoritative V5 with positive-only fields",
			{
				...JSON.parse(validV5AuthoritativeMetadata),
				observedRoots: validV4Metadata.observedRoots,
				capabilities: validV4Metadata.capabilities,
			},
		],
		[
			"positive-only V5 with authoritative roots",
			{ ...JSON.parse(validV5PositiveMetadata), roots: v3Roots },
		],
		[
			"authoritative V5 with a non-empty partial reason list",
			{
				...JSON.parse(validV5AuthoritativeMetadata),
				partialReasons: validV4Metadata.partialReasons,
			},
		],
		[
			"positive-only V5 with empty partial reasons",
			{ ...JSON.parse(validV5PositiveMetadata), partialReasons: [] },
		],
		[
			"authoritative V5 with an unknown field",
			{ ...JSON.parse(validV5AuthoritativeMetadata), debug: true },
		],
		[
			"positive-only V5 with an unknown field",
			{ ...JSON.parse(validV5PositiveMetadata), debug: true },
		],
	])("fails closed for %s", (_description, metadata) => {
		expect(decodePlexGenerationMetadata(JSON.stringify(metadata))).toMatchObject({ ok: false });
	});

	it.each([
		["a non-Plex provider", { ...completeCoverageReceipt, provider: "jellyfin" }],
		[
			"a canonical-entity count that disagrees with metadata",
			{
				...completeCoverageReceipt,
				units: [{ ...completeCoverageReceipt.units[0], canonicalEntities: 2 }],
			},
		],
		[
			"completed pages beyond attempted pages",
			{
				...completeCoverageReceipt,
				units: [{ ...completeCoverageReceipt.units[0], pagesCompleted: 2 }],
			},
		],
		[
			"an expected-total shortfall",
			{
				...completeCoverageReceipt,
				units: [{ ...completeCoverageReceipt.units[0], expectedRawCount: 2 }],
			},
		],
		[
			"a fatal source unit",
			{
				...completeCoverageReceipt,
				units: [{ ...completeCoverageReceipt.units[0], fatalCount: 1 }],
			},
		],
		[
			"a source-conservation mismatch",
			{
				...completeCoverageReceipt,
				units: [{ ...completeCoverageReceipt.units[0], rawObserved: 2 }],
			},
		],
	])("rejects V5 metadata with %s", (_description, coverageReceipt) => {
		expect(
			decodePlexGenerationMetadata(
				JSON.stringify({ ...JSON.parse(validV5AuthoritativeMetadata), coverageReceipt }),
			),
		).toEqual({ ok: false, reasonCode: "metadata_invalid" });
	});

	it("rejects authoritative receipt evidence on a positive-only V5 envelope", () => {
		expect(
			decodePlexGenerationMetadata(
				JSON.stringify({
					...JSON.parse(validV5PositiveMetadata),
					coverageReceipt: { ...completeCoverageReceipt, evidence: "complete" },
				}),
			),
		).toEqual({ ok: false, reasonCode: "metadata_invalid" });
	});

	it("rejects positive-only V5 metadata unless source accounting is complete", () => {
		const coverageReceipt = {
			...completeCoverageReceipt,
			evidence: "positive-only",
			units: [{ ...completeCoverageReceipt.units[0], pagesCompleted: 0 }],
		};
		expect(
			decodePlexGenerationMetadata(
				JSON.stringify({ ...JSON.parse(validV5PositiveMetadata), coverageReceipt }),
			),
		).toEqual({ ok: false, reasonCode: "metadata_invalid" });
	});

	it("fails closed when a raw source row is unaccounted", () => {
		const result = evaluateProviderCoverageReceipt({
			...completeCoverageReceipt,
			units: [
				{
					...completeCoverageReceipt.units[0],
					rawObserved: 2,
				},
			],
		});

		expect(result).toMatchObject({
			valid: true,
			complete: false,
			rawObserved: 2,
			sourceBindings: 1,
			reasonCodes: expect.arrayContaining(["coverage-incomplete"]),
		});
	});

	it.each([
		["bare V4", JSON.stringify({ version: 4, sections }), "metadata_invalid"],
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

	it("keeps bounded section/domain roots and excludes target identities in V3 metadata", () => {
		const parsed = JSON.parse(v3Metadata) as Record<string, unknown>;

		expect(parsed).toEqual({
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
			canonicalizationVersion: 1,
			sections: v3Sections,
			roots: v3Roots,
		});
		expect(parsed).not.toHaveProperty("targets");
		expect(parsed).not.toHaveProperty("ratingKeys");
	});

	it("round-trips a complete bounded target-ledger binding without target rows", () => {
		const parsed = {
			...JSON.parse(v3Metadata),
			targetLedgerVersion: 1,
			targetCount: 2,
			targetDigest: "b".repeat(64),
		} as Record<string, unknown>;

		expect(parsed).toMatchObject({
			targetLedgerVersion: 1,
			targetCount: 2,
			targetDigest: "b".repeat(64),
		});
		expect(decodePlexGenerationMetadata(JSON.stringify(parsed))).toMatchObject({
			ok: true,
			metadata: { targetLedgerVersion: 1, targetCount: 2, targetDigest: "b".repeat(64) },
		});
		expect(parsed).not.toHaveProperty("targets");
	});

	it.each([
		{ targetLedgerVersion: 1 },
		{ targetLedgerVersion: 2, targetCount: 1, targetDigest: "a".repeat(64) },
		{ targetLedgerVersion: 1, targetCount: -1, targetDigest: "a".repeat(64) },
		{ targetLedgerVersion: 1, targetCount: 1, targetDigest: "not-a-digest" },
	])("rejects malformed V3 target-ledger bindings", (binding) => {
		expect(
			decodePlexGenerationMetadata(
				JSON.stringify({
					...JSON.parse(v3Metadata),
					...binding,
				}),
			),
		).toEqual({ ok: false, reasonCode: "metadata_invalid" });
	});

	it.each([
		["V1", JSON.stringify({ sections })],
		[
			"V2",
			JSON.stringify({
				version: 2,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				sections,
			}),
		],
	])(
		"retains %s as historical observation without exact or mutation authority",
		(_name, metadata) => {
			const options = {
				now: new Date("2026-08-20T14:00:00.000Z"),
				maxAgeMs: 3 * 60 * 60 * 1000,
			};
			const historicalStatus = status({ generationMetadata: metadata });

			expect(evaluatePublishedPlexGeneration(historicalStatus, options)).toMatchObject({
				available: true,
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["plex_settlement_metadata_missing"],
				},
			});
			expect(evaluatePlexMutationAuthority(historicalStatus, options).available).toBe(false);
		},
	);

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

	it("retains a well-formed V4 positive-only publication as historical-only", () => {
		const partialMetadata = JSON.stringify(validV4Metadata);
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
			metadata: { version: 4, publicationLevel: "positive-only" },
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "partial",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_partial"],
				publishedGeneration: { publicationLevel: "positive-only" },
			},
		});
		expect(evaluatePlexMutationAuthority(partialStatus, options).available).toBe(false);
	});

	it("grants mutation authority only to a complete authoritative V5 receipt", () => {
		const options = {
			now: new Date("2026-09-02T12:00:02.000Z"),
			maxAgeMs: 3 * 60 * 60 * 1000,
		};
		const authoritativeV5 = status({
			generationMetadata: validV5AuthoritativeMetadata,
			lastRefreshedAt: new Date("2026-09-02T12:00:01.000Z"),
			lastAttemptAt: new Date("2026-09-02T12:00:01.000Z"),
		});
		const positiveV5 = status({
			generationMetadata: validV5PositiveMetadata,
			lastRefreshedAt: new Date("2026-09-02T12:00:01.000Z"),
			lastAttemptAt: new Date("2026-09-02T12:00:01.000Z"),
			lastAttemptResult: "partial",
		});
		const preReceipt = status({ generationMetadata: v3Metadata });

		expect(evaluatePlexMutationAuthority(authoritativeV5, options)).toMatchObject({
			available: true,
			evidence: {
				availability: "current",
				authority: "authoritative",
				publicationLevel: "authoritative",
				completeness: "complete",
			},
		});
		expect(evaluatePlexMutationAuthority(positiveV5, options).available).toBe(false);
		expect(evaluatePlexMutationAuthority(preReceipt, options).available).toBe(false);
	});

	it("withholds V5 current trust when the receipt observed time differs from publication", () => {
		const result = evaluatePublishedPlexGeneration(
			status({ generationMetadata: validV5AuthoritativeMetadata }),
			{ now: new Date("2026-09-02T12:00:02.000Z") },
		);
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["metadata_invalid"] },
		});
	});

	it.each([
		["an unknown envelope field", { ...validV4Metadata, labelsComplete: true }],
		[
			"an unknown capability field",
			{
				...validV4Metadata,
				capabilities: [{ ...validV4Metadata.capabilities[0], grantsAbsence: true }],
			},
		],
		[
			"an unknown reason field",
			{
				...validV4Metadata,
				partialReasons: [
					{ ...validV4Metadata.partialReasons[0], detail: "sensitive upstream material" },
				],
			},
		],
		[
			"an episode-parent root on a Movie section",
			{
				...validV4Metadata,
				observedRoots: [
					{ sectionKey: "movies", domain: "episode-parents", digest: "a".repeat(64) },
				],
			},
		],
		["a missing Show section root", { ...validV4Metadata, observedRoots: [] }],
	])("rejects V4 with %s", (_description, metadata) => {
		expect(decodePlexGenerationMetadata(JSON.stringify(metadata))).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});
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

		expect(result).toMatchObject({
			available: true,
			publishedAt: new Date("2026-08-20T08:00:00.000Z"),
			providerStatus: {
				availability: "last-known",
				observedAt: "2026-08-20T08:00:00.000Z",
				ageSeconds: 21_600,
				reasonCodes: ["coverage-incomplete", "refresh-failed"],
			},
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_failed"],
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
		[
			"successful latest pre-receipt attempt",
			{},
			true,
			"last-known",
			"unavailable",
			"success",
			false,
		],
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
			true,
			"last-known",
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
		[
			"subsequent successful pre-receipt refresh",
			{},
			true,
			"last-known",
			"unavailable",
			"success",
			false,
		],
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
