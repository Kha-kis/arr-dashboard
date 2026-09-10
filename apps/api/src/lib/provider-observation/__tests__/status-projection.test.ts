import { describe, expect, it } from "vitest";
import type { ProviderCoverageEvaluation } from "../coverage-receipt";
import type { ProviderStatusProjectionInput } from "../status-projection";
import { projectProviderObservationStatus } from "../status-projection";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const PUBLISHED_AT = new Date("2026-09-02T11:00:00.000Z");

function evaluation(
	overrides: Partial<ProviderCoverageEvaluation> = {},
): ProviderCoverageEvaluation {
	return {
		valid: true,
		complete: true,
		evidence: "complete",
		provider: "plex",
		rawObserved: 5,
		sourceBindings: 5,
		canonicalEntities: 4,
		publishedCanonicalEntities: null,
		acceptedSkipCount: 0,
		fatalCount: 0,
		pagesAttempted: 1,
		pagesCompleted: 1,
		reasonCodes: [],
		...overrides,
	};
}

function input(
	overrides: Partial<ProviderStatusProjectionInput> = {},
): ProviderStatusProjectionInput {
	return {
		identity: "current",
		publication: { observedAt: PUBLISHED_AT, evaluation: evaluation() },
		latestAttempt: { state: "successful", attemptedAt: PUBLISHED_AT },
		now: NOW,
		maxAgeMs: 2 * 60 * 60 * 1000,
		...overrides,
	};
}

function attempt(state: "running" | "failed" | "successful", attemptedAt: Date) {
	return { state, attemptedAt };
}

describe("projectProviderObservationStatus", () => {
	it.each([
		["fresh success", input(), "current", "complete", "successful"],
		[
			"positive observation",
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						complete: false,
						evidence: "positive-only",
						reasonCodes: ["positive-only", "coverage-incomplete"],
					}),
				},
			}),
			"partial",
			"positive-only",
			"successful",
		],
		[
			"newer failure",
			input({ latestAttempt: attempt("failed", new Date("2026-09-02T11:30:00.000Z")) }),
			"last-known",
			"complete",
			"failed",
		],
		[
			"running after success",
			input({ latestAttempt: attempt("running", new Date("2026-09-02T11:30:00.000Z")) }),
			"last-known",
			"complete",
			"running",
		],
		[
			"stale success",
			input({ now: new Date("2026-09-02T13:01:00.000Z"), maxAgeMs: 2 * 60 * 60 * 1000 }),
			"last-known",
			"complete",
			"successful",
		],
		[
			"identity change",
			input({ identity: "changed", latestAttempt: attempt("running", NOW) }),
			"unavailable",
			"unknown",
			"idle",
		],
		[
			"unverified identity",
			input({ identity: "unverified", latestAttempt: attempt("failed", NOW) }),
			"unavailable",
			"unknown",
			"idle",
		],
		[
			"no publication",
			input({ publication: null, latestAttempt: null }),
			"unavailable",
			"unknown",
			"idle",
		],
	] as const)("projects %s", (_name, projectionInput, availability, evidence, latestAttempt) => {
		expect(projectProviderObservationStatus(projectionInput)).toMatchObject({
			availability,
			evidence,
			latestAttempt,
		});
	});

	it("does not let an older or equal failed attempt supersede a publication", () => {
		for (const attemptedAt of [new Date("2026-09-02T10:59:59.999Z"), PUBLISHED_AT]) {
			const result = projectProviderObservationStatus(
				input({ latestAttempt: attempt("failed", attemptedAt) }),
			);

			expect(result).toMatchObject({
				availability: "current",
				latestAttempt: "failed",
				reasonCodes: [],
			});
		}
	});

	it.each([
		["failed", "failed", "refresh-failed"],
		["running", "running", "refresh-running"],
	] as const)("exposes a first %s attempt without publication", (state, latestAttempt, reason) => {
		const result = projectProviderObservationStatus(
			input({
				publication: null,
				latestAttempt: attempt(state, NOW),
			}),
		);

		expect(result).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt,
			reasonCodes: ["no-publication", reason],
		});
	});

	it("projects partial evidence without claiming current coverage", () => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						complete: false,
						evidence: "partial",
						reasonCodes: ["coverage-incomplete"],
					}),
				},
			}),
		);

		expect(result).toMatchObject({
			availability: "partial",
			evidence: "partial",
			observedAt: PUBLISHED_AT.toISOString(),
			ageSeconds: 3600,
			reasonCodes: ["coverage-incomplete"],
		});
	});

	it.each([
		["positive-only", ["positive-only", "coverage-incomplete"]],
		["partial", ["coverage-incomplete"]],
	] as const)("ages stale %s evidence into last-known", (evidence, reasonCodes) => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						complete: false,
						evidence,
						reasonCodes: [...reasonCodes],
					}),
				},
				now: new Date("2026-09-02T13:01:00.000Z"),
				maxAgeMs: 2 * 60 * 60 * 1000,
			}),
		);

		expect(result).toMatchObject({
			availability: "last-known",
			evidence,
			observedAt: PUBLISHED_AT.toISOString(),
			ageSeconds: 7260,
			latestAttempt: "successful",
			reasonCodes: expect.arrayContaining([...reasonCodes, "publication-stale"]),
		});
	});

	it("keeps positive-only evidence partial at the exact freshness boundary", () => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						complete: false,
						evidence: "positive-only",
						reasonCodes: ["positive-only", "coverage-incomplete"],
					}),
				},
				maxAgeMs: 60 * 60 * 1000,
			}),
		);

		expect(result).toMatchObject({
			availability: "partial",
			evidence: "positive-only",
			ageSeconds: 3600,
		});
		expect(result.reasonCodes).not.toContain("publication-stale");
	});

	it("projects a valid but incomplete complete-evidence receipt as partial", () => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						complete: false,
						reasonCodes: ["provider-limit", "coverage-incomplete"],
					}),
				},
			}),
		);

		expect(result).toMatchObject({
			availability: "partial",
			evidence: "partial",
			observedAt: PUBLISHED_AT.toISOString(),
			ageSeconds: 3600,
			reasonCodes: ["provider-limit", "coverage-incomplete"],
		});
	});

	it("fails closed for an invalid receipt evaluation", () => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({
						valid: false,
						complete: false,
						evidence: "unknown",
						reasonCodes: ["receipt-invalid"],
					}),
				},
			}),
		);

		expect(result).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["receipt-invalid"],
		});
	});

	it("fails closed for a falsely complete but unconserved evaluation", () => {
		const result = projectProviderObservationStatus(
			input({
				publication: {
					observedAt: PUBLISHED_AT,
					evaluation: evaluation({ sourceBindings: 4 }),
				},
			}),
		);

		expect(result).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["coverage-incomplete"],
		});
	});

	it("fails closed for a future publication time", () => {
		const futurePublication = new Date("2026-09-02T13:00:00.000Z");
		const result = projectProviderObservationStatus(
			input({
				publication: { observedAt: futurePublication, evaluation: evaluation() },
				now: NOW,
			}),
		);

		expect(result).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["unknown-failure"],
		});
	});

	it("treats the exact freshness boundary as current", () => {
		const result = projectProviderObservationStatus(input({ maxAgeMs: 60 * 60 * 1000 }));

		expect(result).toMatchObject({ availability: "current", ageSeconds: 3600 });
	});

	it("uses only the publication timestamp and emits no raw provider data", () => {
		const result = projectProviderObservationStatus(
			input({ latestAttempt: attempt("failed", new Date("2026-09-02T11:30:00.000Z")) }),
		);

		expect(result.observedAt).toBe(PUBLISHED_AT.toISOString());
		expect(result.ageSeconds).toBe(3600);
		expect(Object.keys(result).sort()).toEqual([
			"ageSeconds",
			"availability",
			"evidence",
			"latestAttempt",
			"observedAt",
			"reasonCodes",
		]);
	});
});
