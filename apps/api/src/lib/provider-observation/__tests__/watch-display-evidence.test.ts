import type { ProviderObservationStatus } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { authorizeProviderEvidenceUse } from "../evidence-capabilities.js";
import { projectWatchDisplayEvidence } from "../watch-display-evidence.js";

const observedAt = "2026-09-06T12:00:00.000Z";

const exactStatus: ProviderObservationStatus = {
	availability: "current",
	evidence: "complete",
	observedAt,
	ageSeconds: 0,
	latestAttempt: "successful",
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count",
			availability: "current",
			evidence: "complete",
			valueSemantics: "exact",
			observedAt,
			reasonCodes: [],
		},
		{
			domain: "watch-attribution",
			availability: "current",
			evidence: "complete",
			valueSemantics: "exact",
			observedAt,
			reasonCodes: [],
		},
	],
};

const lowerBoundStatus: ProviderObservationStatus = {
	availability: "partial",
	evidence: "positive-only",
	observedAt,
	ageSeconds: 0,
	latestAttempt: "successful",
	reasonCodes: ["positive-only", "coverage-incomplete"],
	domains: [
		{
			domain: "watch-count",
			availability: "current",
			evidence: "positive-only",
			valueSemantics: "lower-bound",
			observedAt,
			reasonCodes: ["positive-only", "coverage-incomplete"],
		},
	],
};

const row = {
	watchCount: 3,
	lastWatchedAt: new Date("2026-09-06T11:00:00.000Z"),
	watchedByUsers: '["alice"]',
};

describe("projectWatchDisplayEvidence", () => {
	it("preserves an authorized exact count and exact attribution", () => {
		expect(projectWatchDisplayEvidence({ status: exactStatus, row })).toEqual({
			watchCount: 3,
			watchCountSemantics: "exact",
			lastWatchedAt: "2026-09-06T11:00:00.000Z",
			watchedByUsers: ["alice"],
		});
	});

	it("keeps a current lower-bound count while quarantining attribution", () => {
		expect(projectWatchDisplayEvidence({ status: lowerBoundStatus, row })).toEqual({
			watchCount: 3,
			watchCountSemantics: "lower-bound",
			lastWatchedAt: null,
			watchedByUsers: [],
		});
	});

	it("treats a selected zero row as unknown when only lower-bound evidence is available", () => {
		expect(
			projectWatchDisplayEvidence({
				status: lowerBoundStatus,
				row: { ...row, watchCount: 0 },
			}),
		).toEqual({
			watchCount: null,
			watchCountSemantics: "unknown",
			lastWatchedAt: null,
			watchedByUsers: [],
		});
	});

	it("returns unknown rather than inventing zero for unavailable or malformed values", () => {
		expect(
			projectWatchDisplayEvidence({
				status: { ...lowerBoundStatus, availability: "unavailable", evidence: "unknown" },
				row: { ...row, watchCount: Number.NaN },
			}),
		).toEqual({
			watchCount: null,
			watchCountSemantics: "unknown",
			lastWatchedAt: null,
			watchedByUsers: [],
		});
	});

	it("keeps the partial lower-bound display-only and denies its mutation use", () => {
		expect(
			authorizeProviderEvidenceUse(lowerBoundStatus, {
				domain: "watch-count",
				use: "mutation",
				field: "watch-count",
				operator: "greater_than",
				threshold: 0,
				observedValue: 3,
				targetObserved: true,
			}),
		).toEqual({ authorized: false, reason: "current-evidence-required" });
	});
});
