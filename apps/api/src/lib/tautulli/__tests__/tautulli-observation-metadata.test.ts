import type { ProviderCoverageReceiptV1, ProviderCoverageReceiptV2 } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	decodeTautulliObservationMetadata,
	encodeTautulliObservationMetadata,
	type TautulliObservationMetadataV1,
} from "../tautulli-observation-metadata.js";

const ATTEMPT_STARTED_AT = "2026-09-03T12:00:45.000Z";
const WINDOW_STARTED_AT = "2026-09-03T12:00:30.000Z";
const WINDOW_ENDED_AT = "2026-09-03T12:01:00.000Z";

function unit(overrides: Partial<ProviderCoverageReceiptV1["units"][number]> = {}) {
	return {
		scopeKey: "library:synthetic-library",
		expectedRawCount: 1,
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

function receipt(overrides: Partial<ProviderCoverageReceiptV1> = {}): ProviderCoverageReceiptV1 {
	return {
		version: 1,
		provider: "tautulli",
		attemptStartedAt: ATTEMPT_STARTED_AT,
		observedAt: WINDOW_ENDED_AT,
		evidence: "positive-only",
		units: [unit()],
		publishedCanonicalEntities: 1,
		...overrides,
	};
}

function v2PositiveReceipt(): ProviderCoverageReceiptV2 {
	const baseUnit = unit();
	return {
		version: 2,
		provider: "tautulli",
		attemptStartedAt: ATTEMPT_STARTED_AT,
		observedAt: WINDOW_ENDED_AT,
		evidence: "positive-only",
		units: [baseUnit],
		publishedCanonicalEntities: 1,
		domains: [
			{
				domain: "watch-count",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				units: [baseUnit],
			},
		],
	};
}

function metadata(
	overrides: Partial<TautulliObservationMetadataV1> = {},
): TautulliObservationMetadataV1 {
	return {
		version: 1,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: 1,
		windowStartedAt: WINDOW_STARTED_AT,
		windowEndedAt: WINDOW_ENDED_AT,
		coverageReceipt: receipt(),
		...overrides,
	};
}

function decode(value: unknown) {
	return decodeTautulliObservationMetadata(
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

describe("Tautulli observation metadata", () => {
	it("round-trips a conserved positive-only receipt with one published row", () => {
		const input = metadata();
		const encoded = encodeTautulliObservationMetadata(input);

		expect(decodeTautulliObservationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it("round-trips only a current lower-bound watch-count V2 receipt", () => {
		const input = metadata({ coverageReceipt: v2PositiveReceipt() as never });

		expect(decode(encodeTautulliObservationMetadata(input))).toEqual({
			ok: true,
			metadata: input,
		});
	});

	it.each([
		["watched-by", "watch-attribution", "lower-bound"],
		["exact watch-count", "watch-count", "exact"],
		["unknown watch-count", "watch-count", "unknown"],
	] as const)("rejects a V2 receipt with %s domain semantics", (_label, domain, valueSemantics) => {
		const receiptInput = v2PositiveReceipt();
		receiptInput.domains = [
			{
				...receiptInput.domains[0]!,
				domain,
				valueSemantics,
			},
		];

		expect(decode(metadata({ coverageReceipt: receiptInput as never }))).toEqual({ ok: false });
	});

	it("rejects a V2 receipt without an explicitly current watch-count domain", () => {
		const input = v2PositiveReceipt();
		input.domains = [];

		expect(decode(metadata({ coverageReceipt: input as never }))).toEqual({ ok: false });
	});

	it("round-trips zero published rows with a real zero-observation unit", () => {
		const zeroUnit = unit({
			expectedRawCount: 0,
			rawObserved: 0,
			sourceBindings: 0,
			canonicalEntities: 0,
		});
		const input = metadata({
			itemCount: 0,
			coverageReceipt: receipt({ units: [zeroUnit], publishedCanonicalEntities: 0 }),
		});

		expect(decode(encodeTautulliObservationMetadata(input))).toEqual({
			ok: true,
			metadata: input,
		});
	});

	it("accepts supported skips and bounded-window truncation as partial evidence", () => {
		const observation = receipt({
			units: [
				unit({
					expectedRawCount: null,
					rawObserved: 4,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [
						{ reason: "known-container", count: 1 },
						{ reason: "missing-supported-mapping", count: 1 },
						{ reason: "bounded-window-truncation", count: 1 },
					],
				}),
			],
		});
		const input = metadata({ coverageReceipt: observation });

		expect(decode(encodeTautulliObservationMetadata(input))).toEqual({
			ok: true,
			metadata: input,
		});
		expect(evaluateProviderCoverageReceipt(observation)).toMatchObject({
			valid: true,
			complete: false,
			evidence: "positive-only",
		});
	});

	it.each([
		["non-string", 42],
		["blank", "   "],
		["malformed JSON", "{"],
		["array", "[]"],
	])("rejects %s metadata input", (_label, value) => {
		expect(decodeTautulliObservationMetadata(value)).toEqual({ ok: false });
	});

	it("rejects missing keys and every extra top-level key", () => {
		const input = metadata();
		const missing = { ...input } as Record<string, unknown>;
		delete missing.coverageReceipt;
		const extra = { ...input, unexpected: true };

		expect(decode(missing)).toEqual({ ok: false });
		expect(decode(extra)).toEqual({ ok: false });
	});

	it.each([
		["version", { version: 2 }],
		["publication level", { publicationLevel: "authoritative" }],
		["completeness", { completeness: "complete" }],
		["negative item count", { itemCount: -1 }],
		["fractional item count", { itemCount: 1.5 }],
		["unsafe item count", { itemCount: Number.MAX_SAFE_INTEGER + 1 }],
	])("rejects invalid %s", (_label, override) => {
		expect(decode({ ...metadata(), ...override })).toEqual({ ok: false });
	});

	it.each([
		["invalid start", { windowStartedAt: "not-a-date" }],
		["noncanonical start", { windowStartedAt: "2026-09-03T12:00:30Z" }],
		["noncanonical end", { windowEndedAt: "2026-09-03T12:01:00+00:00" }],
		["reversed window", { windowStartedAt: WINDOW_ENDED_AT, windowEndedAt: WINDOW_STARTED_AT }],
		[
			"window longer than fifteen minutes",
			{ windowStartedAt: "2026-09-03T12:00:00.000Z", windowEndedAt: "2026-09-03T12:15:01.000Z" },
		],
	])("rejects %s", (_label, override) => {
		expect(decode({ ...metadata(), ...override })).toEqual({ ok: false });
	});

	it("accepts a window exactly at the fifteen-minute bound", () => {
		const input = metadata({
			windowStartedAt: "2026-09-03T12:00:00.000Z",
			windowEndedAt: "2026-09-03T12:15:00.000Z",
			coverageReceipt: receipt({ observedAt: "2026-09-03T12:15:00.000Z" }),
		});

		expect(decode(encodeTautulliObservationMetadata(input))).toEqual({
			ok: true,
			metadata: input,
		});
	});

	it.each([
		["wrong provider", { provider: "plex" as const }],
		["wrong evidence", { evidence: "complete" as const }],
	] as const)("rejects a receipt with %s", (_label, override) => {
		const input = metadata({ coverageReceipt: receipt(override) });
		expect(decode(input)).toEqual({ ok: false });
	});

	it.each([
		["attempt after window end", { attemptStartedAt: "2026-09-03T12:01:01.000Z" }],
		["noncanonical attempt timestamp", { attemptStartedAt: "2026-09-03T12:00:45Z" }],
		["observed time before window end", { observedAt: "2026-09-03T12:00:59.000Z" }],
		["missing published count", { publishedCanonicalEntities: undefined }],
		["mismatched published count", { publishedCanonicalEntities: 0 }],
	])("rejects a receipt with %s", (_label, override) => {
		const input = metadata({ coverageReceipt: receipt(override) });
		expect(decode(input)).toEqual({ ok: false });
	});

	it("rejects a receipt with no units", () => {
		expect(
			decode(metadata({ coverageReceipt: receipt({ units: [], publishedCanonicalEntities: 0 }) })),
		).toEqual({ ok: false });
	});

	it.each([
		["unfinished pages", { pagesCompleted: 0 }],
		["fatal rows", { fatalCount: 1 }],
		["non-conserved rows", { rawObserved: 2 }],
		["canonical rows greater than source bindings", { canonicalEntities: 2, sourceBindings: 1 }],
	])("rejects units with %s", (_label, override) => {
		const input = metadata({ coverageReceipt: receipt({ units: [unit(override)] }) });
		expect(decode(input)).toEqual({ ok: false });
	});

	it("rejects a published count greater than all canonical unit counts", () => {
		const input = metadata({
			itemCount: 2,
			coverageReceipt: receipt({ publishedCanonicalEntities: 2 }),
		});
		expect(decode(input)).toEqual({ ok: false });
	});

	it.each([
		["an extra receipt key", { unexpected: true }],
		["an extra unit key", { unexpected: true }],
		["an extra accepted-skip key", { unexpected: true }],
	])("rejects nested receipt with %s", (_label, extra) => {
		const input = metadata();
		const baseUnit = input.coverageReceipt.units[0];
		if (!baseUnit) throw new Error("test fixture is missing its unit");
		let malformed: unknown;
		if (_label === "an extra receipt key") {
			malformed = { ...input, coverageReceipt: { ...input.coverageReceipt, ...extra } };
		} else if (_label === "an extra unit key") {
			malformed = {
				...input,
				coverageReceipt: {
					...input.coverageReceipt,
					units: [{ ...baseUnit, ...extra }],
				},
			};
		} else {
			malformed = {
				...input,
				coverageReceipt: {
					...input.coverageReceipt,
					units: [
						{
							...baseUnit,
							acceptedSkips: [{ reason: "known-container", count: 1, ...extra }],
						},
					],
				},
			};
		}
		expect(decode(malformed)).toEqual({ ok: false });
	});

	it("rejects duplicate scope keys across receipt units", () => {
		const first = unit();
		const second = unit({
			canonicalEntities: 0,
			sourceBindings: 0,
			rawObserved: 0,
			expectedRawCount: 0,
		});
		expect(
			decode(
				metadata({
					itemCount: 1,
					coverageReceipt: receipt({ units: [first, second], publishedCanonicalEntities: 1 }),
				}),
			),
		).toEqual({ ok: false });
	});

	it("throws one fixed generic message for every encoder failure", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const invalidInputs: unknown[] = [undefined, metadata({ itemCount: -1 }), cyclic];

		for (const input of invalidInputs) {
			try {
				encodeTautulliObservationMetadata(input);
				expect.fail("expected encoder to reject input");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Invalid Tautulli observation metadata");
				expect((error as Error).message).not.toContain("self");
			}
		}
	});
});
