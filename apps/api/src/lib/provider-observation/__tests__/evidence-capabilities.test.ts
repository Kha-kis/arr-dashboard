import type { ProviderObservationStatus } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	authorizeProviderEvidenceUse,
	authorizeTargetScopedWatchCountMutation,
	type ProviderEvidenceCapabilityRequest,
} from "../evidence-capabilities";

const baseStatus: ProviderObservationStatus = {
	availability: "current",
	evidence: "partial",
	observedAt: "2026-09-06T12:01:00.000Z",
	ageSeconds: 0,
	latestAttempt: "successful",
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count",
			availability: "current",
			evidence: "partial",
			valueSemantics: "lower-bound",
			observedAt: "2026-09-06T12:01:00.000Z",
			reasonCodes: [],
		},
	],
};

function decide(
	status: ProviderObservationStatus,
	overrides: Partial<ProviderEvidenceCapabilityRequest> = {},
) {
	return authorizeProviderEvidenceUse(status, {
		domain: "watch-count",
		use: "positive-predicate",
		field: "watch-count",
		operator: "greater_than",
		threshold: 0,
		observedValue: 3,
		targetObserved: true,
		...overrides,
	});
}

describe("authorizeProviderEvidenceUse", () => {
	it("permits a target-scoped exact watch-count mutation despite aggregate partial evidence", () => {
		const exactTargetStatus: ProviderObservationStatus = {
			...baseStatus,
			availability: "partial",
			evidence: "positive-only",
			domains: [
				{
					...baseStatus.domains![0]!,
					evidence: "complete",
					valueSemantics: "exact",
				},
			],
		};

		expect(
			authorizeTargetScopedWatchCountMutation(exactTargetStatus, {
				domain: "watch-count",
				use: "mutation",
				field: "watch-count",
				operator: "greater_than",
				threshold: 0,
				observedValue: 3,
				targetObserved: true,
			}),
		).toEqual({ authorized: true, basis: "exact" });
	});

	it("denies target-scoped lower-bound and unsupported watch-count mutation predicates", () => {
		expect(
			authorizeTargetScopedWatchCountMutation(baseStatus, {
				domain: "watch-count",
				use: "mutation",
				field: "watch-count",
				operator: "greater_than",
				threshold: 0,
				observedValue: 3,
				targetObserved: true,
			}),
		).toMatchObject({ authorized: false, reason: "exact-evidence-required" });
	});

	it("authorizes an already-proven current lower-bound watch-count predicate", () => {
		expect(decide(baseStatus)).toEqual({ authorized: true, basis: "observed-lower-bound" });
	});

	it("denies a negative predicate without exact evidence and an observed target", () => {
		expect(
			decide(baseStatus, {
				use: "negative-predicate",
				operator: "less_than",
				threshold: 1,
				observedValue: undefined,
				targetObserved: false,
			}),
		).toMatchObject({ authorized: false, reason: "exact-evidence-required" });
	});

	it.each([
		["negative threshold", { threshold: -1 }],
		["missing target", { targetObserved: false }],
		["predicate false", { observedValue: 0 }],
		["less-than operator", { operator: "less_than" as const }],
		["equality operator", { operator: "equals" as const }],
		["non-finite threshold", { threshold: Number.NaN }],
	])("denies %s for lower-bound evidence", (_name, overrides) => {
		expect(decide(baseStatus, overrides)).toMatchObject({ authorized: false });
	});

	it("denies stale evidence for mutation even when the numeric predicate is positive", () => {
		const stale = {
			...baseStatus,
			availability: "last-known" as const,
			domains: baseStatus.domains?.map((domain) => ({
				...domain,
				availability: "last-known" as const,
			})),
		};

		expect(decide(stale, { use: "mutation" })).toMatchObject({
			authorized: false,
			reason: "current-evidence-required",
		});
	});

	it("denies legacy, unknown, and identity-mismatched domain status", () => {
		expect(decide({ ...baseStatus, domains: undefined })).toMatchObject({
			authorized: false,
			reason: "domain-unavailable",
		});
		expect(
			decide({
				...baseStatus,
				domains: [{ ...baseStatus.domains![0]!, valueSemantics: "unknown" }],
			}),
		).toMatchObject({ authorized: false, reason: "domain-unavailable" });
		expect(
			decide({ ...baseStatus, reasonCodes: ["identity-changed"], availability: "unavailable" }),
		).toMatchObject({ authorized: false, reason: "domain-unavailable" });
	});

	it("allows negative and arithmetic uses only with current exact evidence", () => {
		const exactStatus: ProviderObservationStatus = {
			...baseStatus,
			evidence: "complete",
			domains: [
				{
					...baseStatus.domains![0]!,
					evidence: "complete",
					valueSemantics: "exact",
				},
			],
		};

		expect(
			decide(exactStatus, {
				use: "negative-predicate",
				operator: "less_than",
				threshold: 1,
				observedValue: 0,
			}),
		).toEqual({ authorized: true, basis: "exact" });
		expect(
			decide(exactStatus, {
				use: "negative-predicate",
				operator: "equals",
				threshold: 0,
				observedValue: 0,
			}),
		).toEqual({ authorized: true, basis: "exact" });
		expect(
			authorizeProviderEvidenceUse(exactStatus, {
				domain: "watch-count",
				use: "arithmetic",
				field: "watch-count",
				targetObserved: true,
				observedValue: 3,
			}),
		).toEqual({ authorized: true, basis: "exact" });
		expect(
			authorizeProviderEvidenceUse(baseStatus, {
				domain: "watch-count",
				use: "arithmetic",
				field: "watch-count",
				targetObserved: true,
				observedValue: 3,
			}),
		).toMatchObject({ authorized: false, reason: "exact-evidence-required" });
	});

	it.each([
		["stale", { ...baseStatus, availability: "last-known" as const }],
		["unobserved", baseStatus],
	])("denies arithmetic without current observed exact evidence: %s", (_name, status) => {
		expect(
			authorizeProviderEvidenceUse(status, {
				domain: "watch-count",
				use: "arithmetic",
				field: "watch-count",
				targetObserved: _name !== "unobserved",
				observedValue: 3,
			}),
		).toMatchObject({ authorized: false });
	});

	it("denies arithmetic with a non-finite observed value", () => {
		const exactStatus: ProviderObservationStatus = {
			...baseStatus,
			evidence: "complete",
			domains: [{ ...baseStatus.domains![0]!, evidence: "complete", valueSemantics: "exact" }],
		};
		expect(
			authorizeProviderEvidenceUse(exactStatus, {
				domain: "watch-count",
				use: "arithmetic",
				field: "watch-count",
				targetObserved: true,
				observedValue: Number.NaN,
			}),
		).toMatchObject({ authorized: false, reason: "predicate-not-proven" });
	});

	it.each([
		["stale", { ...baseStatus, availability: "last-known" as const }, true],
		["unobserved", baseStatus, false],
	] as const)("denies exact arithmetic when it is %s", (_name, status, targetObserved) => {
		const exactStatus: ProviderObservationStatus = {
			...status,
			evidence: "complete",
			domains: [{ ...status.domains![0]!, evidence: "complete", valueSemantics: "exact" }],
		};
		expect(
			authorizeProviderEvidenceUse(exactStatus, {
				domain: "watch-count",
				use: "arithmetic",
				field: "watch-count",
				targetObserved,
				observedValue: 3,
			}),
		).toMatchObject({ authorized: false });
	});

	it("permits display of an observed current lower-bound row", () => {
		expect(
			decide(baseStatus, {
				use: "display",
				operator: undefined,
				threshold: undefined,
				observedValue: undefined,
			}),
		).toEqual({ authorized: true, basis: "observed-lower-bound" });
	});
});
