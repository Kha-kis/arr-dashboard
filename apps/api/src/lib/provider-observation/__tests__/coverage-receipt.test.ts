import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../coverage-receipt";

type ReceiptOverrides = Record<string, unknown>;

function unit(overrides: ReceiptOverrides = {}): Record<string, unknown> {
	return {
		scopeKey: "library:movies",
		expectedRawCount: 5,
		pagesAttempted: 2,
		pagesCompleted: 2,
		rawObserved: 5,
		sourceBindings: 3,
		canonicalEntities: 2,
		acceptedSkips: [{ reason: "unsupported-provider-object", count: 2 }],
		fatalCount: 0,
		...overrides,
	};
}

function receipt(overrides: ReceiptOverrides = {}): Record<string, unknown> {
	return {
		version: 1,
		provider: "plex",
		attemptStartedAt: "2026-09-02T12:00:00.000Z",
		observedAt: "2026-09-02T12:01:00.000Z",
		evidence: "complete",
		units: [unit()],
		...overrides,
	};
}

function withUnit(overrides: Record<string, unknown>): Record<string, unknown> {
	return receipt({
		units: [unit(overrides)],
	});
}

describe("evaluateProviderCoverageReceipt", () => {
	it("proves complete source coverage before canonical deduplication", () => {
		const result = evaluateProviderCoverageReceipt(receipt());

		expect(result).toMatchObject({
			valid: true,
			complete: true,
			rawObserved: 5,
			sourceBindings: 3,
			canonicalEntities: 2,
			publishedCanonicalEntities: null,
			acceptedSkipCount: 2,
			fatalCount: 0,
			pagesAttempted: 2,
			pagesCompleted: 2,
			reasonCodes: ["accepted-skips"],
		});
	});

	it("rejects canonical count equality as a substitute for conservation", () => {
		const result = evaluateProviderCoverageReceipt(
			withUnit({
				expectedRawCount: 5,
				rawObserved: 5,
				sourceBindings: 3,
				canonicalEntities: 5,
				acceptedSkips: [],
			}),
		);

		expect(result).toMatchObject({ valid: true, complete: false });
		expect(result.reasonCodes).toContain("coverage-incomplete");
	});

	it("rejects duplicate accepted skip reasons as an invalid receipt", () => {
		const result = evaluateProviderCoverageReceipt(
			withUnit({
				acceptedSkips: [
					{ reason: "known-container", count: 1 },
					{ reason: "known-container", count: 1 },
				],
				rawObserved: 5,
				sourceBindings: 3,
			}),
		);

		expect(result).toEqual({
			valid: false,
			complete: false,
			evidence: "unknown",
			rawObserved: 0,
			sourceBindings: 0,
			canonicalEntities: 0,
			publishedCanonicalEntities: null,
			acceptedSkipCount: 0,
			fatalCount: 0,
			pagesAttempted: 0,
			pagesCompleted: 0,
			reasonCodes: ["receipt-invalid"],
		});
	});

	it.each([
		["negative raw observations", { rawObserved: -1 }],
		["negative skip counts", { acceptedSkips: [{ reason: "known-container", count: -1 }] }],
		["unsafe fatal counts", { fatalCount: Number.MAX_SAFE_INTEGER + 1 }],
		["fractional page counts", { pagesAttempted: 1.5 }],
	])("rejects %s", (_name, overrides) => {
		const result = evaluateProviderCoverageReceipt(withUnit(overrides));

		expect(result.valid).toBe(false);
		expect(result.reasonCodes).toEqual(["receipt-invalid"]);
	});

	it("returns incomplete evidence when a page is missing", () => {
		const result = evaluateProviderCoverageReceipt(
			withUnit({ pagesAttempted: 2, pagesCompleted: 1 }),
		);

		expect(result).toMatchObject({
			valid: true,
			complete: false,
			pagesAttempted: 2,
			pagesCompleted: 1,
			reasonCodes: ["accepted-skips", "coverage-incomplete"],
		});
	});

	it("returns incomplete evidence when fatal records are present", () => {
		const result = evaluateProviderCoverageReceipt(withUnit({ fatalCount: 1 }));

		expect(result).toMatchObject({
			valid: true,
			complete: false,
			fatalCount: 1,
			acceptedSkipCount: 2,
			reasonCodes: ["accepted-skips", "coverage-incomplete"],
		});
	});

	it("aggregates conserved counts across independent source scopes", () => {
		const result = evaluateProviderCoverageReceipt(
			receipt({
				units: [
					unit(),
					unit({
						scopeKey: "library:shows",
						expectedRawCount: 4,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved: 4,
						sourceBindings: 4,
						canonicalEntities: 3,
						acceptedSkips: [],
					}),
				],
			}),
		);

		expect(result).toMatchObject({
			valid: true,
			complete: true,
			rawObserved: 9,
			sourceBindings: 7,
			canonicalEntities: 5,
			acceptedSkipCount: 2,
			pagesAttempted: 3,
			pagesCompleted: 3,
		});
	});

	it("keeps independent unit counts while accepting the exact global publication count", () => {
		const result = evaluateProviderCoverageReceipt(
			receipt({
				publishedCanonicalEntities: 2,
				units: [
					unit(),
					unit({
						scopeKey: "library:movies-copy",
						canonicalEntities: 2,
					}),
				],
			}),
		);

		expect(result).toMatchObject({
			valid: true,
			complete: true,
			canonicalEntities: 4,
			publishedCanonicalEntities: 2,
		});
	});

	it.each([
		["negative", -1],
		["fractional", 1.5],
		["unsafe", Number.MAX_SAFE_INTEGER + 1],
		["below the largest unit", 1],
		["above the unit sum", 5],
	])("rejects a %s explicit global publication count", (_name, publishedCanonicalEntities) => {
		const result = evaluateProviderCoverageReceipt(
			receipt({
				publishedCanonicalEntities,
				units: [unit(), unit({ scopeKey: "library:movies-copy", canonicalEntities: 2 })],
			}),
		);

		expect(result).toMatchObject({
			valid: false,
			complete: false,
			publishedCanonicalEntities: null,
			reasonCodes: ["receipt-invalid"],
		});
	});

	it("marks positive-only evidence with its bounded reason code", () => {
		const result = evaluateProviderCoverageReceipt(
			receipt({
				evidence: "positive-only",
				units: [unit({ acceptedSkips: [], sourceBindings: 5 })],
			}),
		);

		expect(result).toMatchObject({
			valid: true,
			complete: false,
			evidence: "positive-only",
			reasonCodes: ["positive-only", "coverage-incomplete"],
		});
	});

	it("rejects a provider total that disagrees with raw observations", () => {
		const result = evaluateProviderCoverageReceipt(
			withUnit({ expectedRawCount: 6, rawObserved: 5 }),
		);

		expect(result).toMatchObject({ valid: true, complete: false });
		expect(result.reasonCodes).toContain("coverage-incomplete");
	});

	it("treats bounded-window truncation as incomplete source coverage", () => {
		const result = evaluateProviderCoverageReceipt(
			withUnit({
				expectedRawCount: null,
				rawObserved: 5,
				sourceBindings: 3,
				acceptedSkips: [{ reason: "bounded-window-truncation", count: 2 }],
			}),
		);

		expect(result).toMatchObject({ valid: true, complete: false });
		expect(result.reasonCodes).toEqual(["provider-limit", "accepted-skips", "coverage-incomplete"]);
	});

	it("accepts every finite source skip reason", () => {
		const result = evaluateProviderCoverageReceipt(
			receipt({
				units: [
					unit({
						expectedRawCount: 6,
						rawObserved: 6,
						sourceBindings: 0,
						acceptedSkips: [
							{ reason: "known-container", count: 1 },
							{ reason: "unsupported-provider-object", count: 1 },
							{ reason: "unsupported-personal-media", count: 1 },
							{ reason: "missing-stable-key", count: 1 },
							{ reason: "missing-supported-mapping", count: 1 },
							{ reason: "bounded-window-truncation", count: 1 },
						],
					}),
				],
			}),
		);

		expect(result).toMatchObject({ valid: true, complete: false, acceptedSkipCount: 6 });
		expect(result.reasonCodes).toContain("provider-limit");
	});

	it.each([
		["empty scope keys", receipt({ units: [unit({ scopeKey: "" })] })],
		[
			"zero accepted skip count",
			receipt({
				units: [unit({ acceptedSkips: [{ reason: "known-container", count: 0 }] })],
			}),
		],
		["extra receipt keys", { ...receipt(), unexpected: true }],
		["extra unit keys", receipt({ units: [{ ...unit(), unexpected: true }] })],
		["duplicate scope keys", receipt({ units: [unit(), unit()] })],
	])("rejects %s with only bounded invalid evidence", (_name, input) => {
		const result = evaluateProviderCoverageReceipt(input);
		expect(result.valid).toBe(false);
		expect(result.reasonCodes).toEqual(["receipt-invalid"]);
		expect(result).not.toHaveProperty("scopeKey");
	});

	it.each([
		["unknown provider", receipt({ provider: "unknown" })],
		["malformed attempt timestamp", receipt({ attemptStartedAt: "not-a-date" })],
		[
			"observation before attempt",
			receipt({
				attemptStartedAt: "2026-09-02T12:02:00.000Z",
				observedAt: "2026-09-02T12:01:00.000Z",
			}),
		],
		["unknown skip reason", withUnit({ acceptedSkips: [{ reason: "provider-error", count: 1 }] })],
	])("rejects %s without exposing parser details", (_name, input) => {
		const result = evaluateProviderCoverageReceipt(input);

		expect(result.valid).toBe(false);
		expect(result.reasonCodes).toEqual(["receipt-invalid"]);
		expect(JSON.stringify(result)).not.toContain("Zod");
		expect(JSON.stringify(result)).not.toContain("provider-error");
	});

	it("accepts the finite Emby source provider discriminator", () => {
		const result = evaluateProviderCoverageReceipt(receipt({ provider: "emby_episode" }));

		expect(result).toMatchObject({ valid: true, provider: "emby_episode" });
	});
});
