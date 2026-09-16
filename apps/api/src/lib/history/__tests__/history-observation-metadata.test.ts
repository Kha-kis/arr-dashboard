import type { ProviderCoverageReceiptV1 } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	decodeHistoryObservationMetadata,
	encodeHistoryObservationMetadata,
	type HistoryObservationPublicationMetadataV1,
} from "../history-observation-metadata.js";
import {
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_OBSERVATION_METADATA_MAX_BYTES,
} from "../history-source-contract.js";

const NOW = "2026-09-03T12:10:00.000Z";
const OBSERVED_AT = "2026-09-03T12:01:00.000Z";
const ATTEMPT_STARTED_AT = "2026-09-03T12:00:45.000Z";

function unit(overrides: Partial<ProviderCoverageReceiptV1["units"][number]> = {}) {
	return {
		scopeKey: "history",
		expectedRawCount: null,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
		...overrides,
	};
}

function receipt(
	service: HistoryObservationPublicationMetadataV1["service"] = "sonarr",
	overrides: Partial<ProviderCoverageReceiptV1> = {},
): ProviderCoverageReceiptV1 {
	const providers = {
		sonarr: "sonarr_history",
		radarr: "radarr_history",
		prowlarr: "prowlarr_history",
		lidarr: "lidarr_history",
		readarr: "readarr_history",
	} as const;
	return {
		version: 1,
		provider: providers[service],
		attemptStartedAt: ATTEMPT_STARTED_AT,
		observedAt: OBSERVED_AT,
		evidence: "positive-only",
		units: [unit()],
		publishedCanonicalEntities: 1,
		...overrides,
	};
}

function metadata(
	service: HistoryObservationPublicationMetadataV1["service"] = "sonarr",
	overrides: Partial<HistoryObservationPublicationMetadataV1> = {},
): HistoryObservationPublicationMetadataV1 {
	return {
		version: 1,
		service,
		connectionGeneration: 4,
		publicationLevel: "positive-only",
		completeness: "partial",
		observedAt: OBSERVED_AT,
		publishedObservationCount: 1,
		coverageReceipt: receipt(service),
		...overrides,
	};
}

function decode(value: unknown, now: unknown = NOW) {
	return decodeHistoryObservationMetadata(
		typeof value === "string" ? value : JSON.stringify(value),
		now,
	);
}

describe("History observation publication metadata", () => {
	it.each(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const)(
		"round-trips a canonical positive-only publication for %s",
		(service) => {
			const input = metadata(service);
			expect(decode(encodeHistoryObservationMetadata(input))).toEqual({
				ok: true,
				metadata: input,
			});
		},
	);

	it("accepts a valid zero-row positive-only publication", () => {
		const input = metadata("radarr", {
			publishedObservationCount: 0,
			coverageReceipt: receipt("radarr", {
				units: [
					unit({
						rawObserved: 0,
						sourceBindings: 0,
						canonicalEntities: 0,
					}),
				],
				publishedCanonicalEntities: 0,
			}),
		});

		expect(decode(encodeHistoryObservationMetadata(input))).toEqual({ ok: true, metadata: input });
	});

	it("accepts positive rows from a later-page partial failure", () => {
		const input = metadata("prowlarr", {
			coverageReceipt: receipt("prowlarr", {
				units: [unit({ pagesAttempted: 2, pagesCompleted: 1, fatalCount: 1 })],
			}),
		});

		expect(decode(encodeHistoryObservationMetadata(input))).toEqual({ ok: true, metadata: input });
		const evaluation = evaluateProviderCoverageReceipt(input.coverageReceipt);
		expect(evaluation).toMatchObject({
			valid: true,
			evidence: "positive-only",
			complete: false,
			publishedCanonicalEntities: 1,
		});
		expect(evaluation.reasonCodes).toEqual(["positive-only", "coverage-incomplete"]);
	});

	it("requires exactly the eight top-level keys and rejects reasonCodes", () => {
		const input = metadata();
		const missing = { ...input } as Record<string, unknown>;
		delete missing.coverageReceipt;
		expect(decode(missing)).toEqual({ ok: false });
		expect(decode({ ...input, reasonCodes: ["positive-only"] })).toEqual({ ok: false });
		expect(decode({ ...input, token: "opaque-token" })).toEqual({ ok: false });
	});

	it.each([
		["non-string", 42],
		["empty", ""],
		["whitespace", "   "],
		["malformed JSON", "{"],
		["array JSON", "[]"],
	])("rejects %s input", (_label, input) => {
		expect(decodeHistoryObservationMetadata(input, NOW)).toEqual({ ok: false });
	});

	it("rejects a JSON document over the 8 KiB UTF-8 preparse bound", () => {
		const oversized = `${"x".repeat(HISTORY_OBSERVATION_METADATA_MAX_BYTES)}"}`;
		expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(
			HISTORY_OBSERVATION_METADATA_MAX_BYTES,
		);
		expect(decodeHistoryObservationMetadata(oversized, NOW)).toEqual({ ok: false });
	});

	it.each([
		["version", { version: 2 }],
		["service", { service: "PLEX" }],
		["publication level", { publicationLevel: "authoritative" }],
		["completeness", { completeness: "complete" }],
		["negative generation", { connectionGeneration: -1 }],
		["fractional generation", { connectionGeneration: 1.5 }],
		["unsafe generation", { connectionGeneration: Number.MAX_SAFE_INTEGER + 1 }],
		["negative publication count", { publishedObservationCount: -1 }],
		["fractional publication count", { publishedObservationCount: 1.5 }],
		["unsafe publication count", { publishedObservationCount: Number.MAX_SAFE_INTEGER + 1 }],
		[
			"over-limit publication count",
			{ publishedObservationCount: HISTORY_COLLECTION_MAX_RAW_ROWS + 1 },
		],
	])("rejects invalid %s", (_label, override) => {
		expect(decode({ ...metadata(), ...override })).toEqual({ ok: false });
	});

	it.each([
		["invalid observed time", { observedAt: "not-a-date" }],
		["noncanonical observed time", { observedAt: "2026-09-03T12:01:00Z" }],
		[
			"future observed time",
			{
				observedAt: "2026-09-03T12:10:00.001Z",
				coverageReceipt: receipt("sonarr", {
					observedAt: "2026-09-03T12:10:00.001Z",
					attemptStartedAt: "2026-09-03T12:10:00.000Z",
				}),
			},
		],
	])("rejects %s", (_label, override) => {
		expect(decode({ ...metadata(), ...override })).toEqual({ ok: false });
	});

	it.each([null, "not-a-date", new Date("invalid")])("rejects an invalid now value: %p", (now) => {
		expect(decodeHistoryObservationMetadata(JSON.stringify(metadata()), now)).toEqual({
			ok: false,
		});
	});

	const invalidReceiptOverrides: Array<[string, Partial<ProviderCoverageReceiptV1>]> = [
		["wrong provider", { provider: "radarr_history" }],
		["wrong evidence", { evidence: "complete" }],
		["wrong receipt observation time", { observedAt: "2026-09-03T12:00:59.000Z" }],
		["missing published count", { publishedCanonicalEntities: undefined }],
		["mismatched published count", { publishedCanonicalEntities: 1 }],
		["noncanonical attempt time", { attemptStartedAt: "2026-09-03T12:00:45Z" }],
		["attempt after observation", { attemptStartedAt: "2026-09-03T12:01:01.000Z" }],
	];

	it.each(invalidReceiptOverrides)("rejects a receipt with %s", (_label, override) => {
		const input = metadata("sonarr", { coverageReceipt: receipt("sonarr", override) });
		if (_label === "mismatched published count") input.publishedObservationCount = 0;
		expect(decode(input)).toEqual({ ok: false });
	});

	it.each([
		["zero units", []],
		[
			"multiple units",
			[
				unit(),
				unit({ scopeKey: "history-copy", rawObserved: 0, sourceBindings: 0, canonicalEntities: 0 }),
			],
		],
	])("rejects a receipt with %s", (_label, units) => {
		const input = metadata("sonarr", {
			publishedObservationCount: 1,
			coverageReceipt: receipt("sonarr", { units }),
		});
		expect(decode(input)).toEqual({ ok: false });
	});

	const invalidUnitOverrides: Array<[string, Partial<ProviderCoverageReceiptV1["units"][number]>]> =
		[
			["non-generic scope", { scopeKey: "library:movies" }],
			["provider total", { expectedRawCount: 1 }],
			["requests over limit", { pagesAttempted: HISTORY_COLLECTION_MAX_REQUESTS + 1 }],
			["completed pages over limit", { pagesCompleted: HISTORY_COLLECTION_MAX_REQUESTS + 1 }],
			["raw rows over limit", { rawObserved: HISTORY_COLLECTION_MAX_RAW_ROWS + 1 }],
			["source bindings over limit", { sourceBindings: HISTORY_COLLECTION_MAX_RAW_ROWS + 1 }],
			["canonical rows over limit", { canonicalEntities: HISTORY_COLLECTION_MAX_RAW_ROWS + 1 }],
			["fatal rows over limit", { fatalCount: HISTORY_COLLECTION_MAX_REQUESTS + 1 }],
			[
				"accepted skips over limit",
				{
					rawObserved: HISTORY_COLLECTION_MAX_RAW_ROWS + 1,
					sourceBindings: 0,
					acceptedSkips: [
						{ reason: "known-container", count: HISTORY_COLLECTION_MAX_RAW_ROWS + 1 },
					],
				},
			],
			["non-conserved rows", { rawObserved: 2 }],
			["canonical rows greater than source", { canonicalEntities: 2, sourceBindings: 1 }],
			[
				"duplicate skip reasons",
				{
					rawObserved: 2,
					sourceBindings: 0,
					acceptedSkips: [
						{ reason: "known-container", count: 1 },
						{ reason: "known-container", count: 1 },
					],
				},
			],
		];

	it.each(invalidUnitOverrides)("rejects a unit with %s", (_label, override) => {
		const input = metadata("sonarr", {
			publishedObservationCount: 1,
			coverageReceipt: receipt("sonarr", { units: [unit(override)] }),
		});
		expect(decode(input)).toEqual({ ok: false });
	});

	it("does not retain private or provider payload fields in a decoded result", () => {
		const input = metadata();
		const encoded = encodeHistoryObservationMetadata(input);
		const decoded = decodeHistoryObservationMetadata(encoded, NOW);
		expect(decoded).toEqual({ ok: true, metadata: input });
		for (const forbidden of [
			"token",
			"url",
			"title",
			"cursor",
			"credential",
			"rawError",
			"providerTotal",
			"instance",
			"payload",
			"reasonCodes",
		]) {
			expect(decode({ ...input, [forbidden]: "private-value" })).toEqual({ ok: false });
		}
		expect(
			decode({
				...input,
				coverageReceipt: receipt("sonarr", {
					units: [unit({ scopeKey: "https://private.example/token" })],
				}),
			}),
		).toEqual({ ok: false });
	});

	it("uses one generic encoder failure and never echoes input details", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const input of [cyclic, { ...metadata(), reasonCodes: ["token-secret"] }]) {
			expect(() => encodeHistoryObservationMetadata(input)).toThrowError(
				"Invalid History observation metadata",
			);
			try {
				encodeHistoryObservationMetadata(input);
			} catch (error) {
				expect((error as Error).message).not.toContain("token-secret");
				expect((error as Error).message).not.toContain("self");
			}
		}
	});
});
