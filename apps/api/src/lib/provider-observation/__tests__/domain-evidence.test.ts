import type {
	ProviderCoverageReceipt,
	ProviderCoverageReceiptV1,
	ProviderCoverageUnitV1,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../coverage-receipt";
import {
	type EvaluatedProviderDomainCoverage,
	evaluateProviderDomainCoverage,
} from "../domain-evidence";
import { projectProviderObservationStatus } from "../status-projection";

const ATTEMPTED_AT = "2026-09-06T12:00:00.000Z";
const OBSERVED_AT = "2026-09-06T12:01:00.000Z";

function unit(overrides: Partial<ProviderCoverageUnitV1> = {}): ProviderCoverageUnitV1 {
	return {
		scopeKey: "library:all",
		expectedRawCount: 5,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 5,
		sourceBindings: 5,
		canonicalEntities: 3,
		acceptedSkips: [],
		fatalCount: 0,
		...overrides,
	};
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 2,
		provider: "plex",
		attemptStartedAt: ATTEMPTED_AT,
		observedAt: OBSERVED_AT,
		evidence: "partial",
		units: [
			unit({
				sourceBindings: 3,
				acceptedSkips: [{ reason: "missing-supported-mapping", count: 2 }],
			}),
		],
		domains: [
			{
				domain: "library-inventory",
				evidence: "complete",
				valueSemantics: "exact",
				units: [unit()],
			},
			{
				domain: "mapping",
				evidence: "partial",
				valueSemantics: "lower-bound",
				units: [
					unit({
						scopeKey: "library:mapping",
						sourceBindings: 3,
						acceptedSkips: [{ reason: "missing-supported-mapping", count: 2 }],
					}),
				],
			},
			{
				domain: "watch-attribution",
				evidence: "partial",
				valueSemantics: "lower-bound",
				units: [
					unit({
						scopeKey: "history:all",
						expectedRawCount: 2,
						rawObserved: 2,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [{ reason: "missing-stable-key", count: 1 }],
					}),
				],
				publishedCanonicalEntities: 1,
			},
		],
		...overrides,
	};
}

function domain(
	result: ReadonlyMap<string, EvaluatedProviderDomainCoverage>,
	name: string,
): EvaluatedProviderDomainCoverage {
	const value = result.get(name);
	if (!value) throw new Error(`Missing domain ${name}`);
	return value;
}

describe("evaluateProviderDomainCoverage", () => {
	it("isolates domain evidence while retaining conservative aggregate coverage", () => {
		const value = receipt();
		const domains = evaluateProviderDomainCoverage(value as ProviderCoverageReceipt);
		const aggregate = evaluateProviderCoverageReceipt(value);

		expect(domain(domains, "library-inventory")).toMatchObject({
			evidence: "complete",
			valueSemantics: "exact",
			availability: "current",
		});
		expect(domain(domains, "mapping")).toMatchObject({
			evidence: "partial",
			valueSemantics: "lower-bound",
			availability: "current",
		});
		expect(domain(domains, "watch-attribution")).toMatchObject({
			evidence: "partial",
			valueSemantics: "lower-bound",
			availability: "current",
		});
		expect(aggregate.evidence).toBe("partial");
	});

	it("isolates a malformed domain without making valid domains stronger", () => {
		const value = receipt({
			domains: [
				(receipt().domains as Array<Record<string, unknown>>)[0],
				{
					domain: "mapping",
					evidence: "partial",
					valueSemantics: "lower-bound",
					units: [{ ...unit({ scopeKey: "library:mapping" }), rawObserved: -1 }],
				},
			],
		});
		const domains = evaluateProviderDomainCoverage(value as ProviderCoverageReceipt);
		const aggregate = evaluateProviderCoverageReceipt(value);

		expect(domain(domains, "library-inventory")).toMatchObject({ evidence: "complete" });
		expect(domain(domains, "mapping")).toMatchObject({
			availability: "unavailable",
			evidence: "unknown",
			valueSemantics: "unknown",
			reasonCodes: ["receipt-invalid"],
		});
		expect(aggregate.evidence).toBe("partial");
	});

	it.each([
		[
			"nonconserved rows",
			{
				...unit({ scopeKey: "library:mapping", sourceBindings: 2 }),
				acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 2 }],
			},
		],
		[
			"mismatched expected count",
			{
				...unit({ scopeKey: "library:mapping", expectedRawCount: 6, sourceBindings: 3 }),
				acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 2 }],
			},
		],
	] as const)("does not grant a lower bound for %s", (_name, malformedUnit) => {
		const value = receipt({
			domains: [
				(receipt().domains as Array<Record<string, unknown>>)[0],
				{
					domain: "mapping",
					evidence: "partial",
					valueSemantics: "lower-bound",
					units: [malformedUnit],
				},
			],
		});
		const domains = evaluateProviderDomainCoverage(value as ProviderCoverageReceipt);
		const aggregate = evaluateProviderCoverageReceipt(value);

		expect(domain(domains, "library-inventory")).toMatchObject({ evidence: "complete" });
		expect(domain(domains, "mapping")).toMatchObject({
			availability: "unavailable",
			evidence: "unknown",
			valueSemantics: "unknown",
		});
		expect(aggregate.evidence).toBe("partial");
	});

	it("does not derive domain grants from a legacy V1 receipt", () => {
		const v1: ProviderCoverageReceiptV1 = {
			version: 1,
			provider: "plex",
			attemptStartedAt: ATTEMPTED_AT,
			observedAt: OBSERVED_AT,
			evidence: "complete",
			units: [unit()],
		};

		expect(evaluateProviderDomainCoverage(v1)).toEqual(new Map());
		expect(evaluateProviderCoverageReceipt(v1)).toMatchObject({ valid: true, complete: true });
	});

	it("projects V2 domains in the stable enum order", () => {
		const value = receipt({ domains: [...(receipt().domains as unknown[]).reverse()] });
		const evaluation = evaluateProviderCoverageReceipt(value);
		const projected = projectProviderObservationStatus({
			identity: "current",
			publication: {
				observedAt: new Date(OBSERVED_AT),
				evaluation,
			},
			latestAttempt: { state: "successful", attemptedAt: new Date(OBSERVED_AT) },
			now: new Date("2026-09-06T12:02:00.000Z"),
			maxAgeMs: 60_000,
		});

		expect(projected.domains?.map((domain) => domain.domain)).toEqual([
			"library-inventory",
			"mapping",
			"watch-attribution",
		]);
	});
});
