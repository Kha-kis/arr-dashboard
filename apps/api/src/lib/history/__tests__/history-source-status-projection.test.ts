import {
	type ProviderCoverageReceiptV1,
	type ProviderObservationStatus,
	providerObservationStatusSchema,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	encodeHistoryObservationMetadata,
	type HistoryObservationPublicationMetadataV1,
} from "../history-observation-metadata.js";
import { decodeHistorySourceAttemptProjection } from "../history-source-attempt.js";
import {
	type HistorySourceStatusProjectionInput,
	projectHistorySourceStatus,
} from "../history-source-status-projection.js";

const NOW = new Date("2026-09-03T11:10:00.000Z");
const PUBLISHED_AT = new Date("2026-09-03T11:00:00.000Z");
const ATTEMPTED_AT = new Date("2026-09-03T10:59:00.000Z");
const SERVICES = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const;
const OPERATIONAL_REASONS = [
	"provider-unavailable",
	"provider-limit",
	"rows-inconsistent",
	"receipt-invalid",
	"unknown-failure",
] as const;

function marker(): string {
	return `in_progress:v1:${"a".repeat(64)}:123e4567-e89b-42d3-a456-426614174000`;
}

function stagedMarker(stage: "prepared" | "started"): string {
	return `in_progress:v2:${stage}:${"a".repeat(64)}:123e4567-e89b-42d3-a456-426614174000`;
}

function receipt(
	service: (typeof SERVICES)[number],
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
		attemptStartedAt: ATTEMPTED_AT.toISOString(),
		observedAt: PUBLISHED_AT.toISOString(),
		evidence: "positive-only",
		units: [
			{
				scopeKey: "history",
				expectedRawCount: null,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: 1,
		...overrides,
	};
}

function metadata(
	service: (typeof SERVICES)[number] = "sonarr",
	overrides: Partial<HistoryObservationPublicationMetadataV1> = {},
): HistoryObservationPublicationMetadataV1 {
	return {
		version: 1,
		service,
		connectionGeneration: 4,
		publicationLevel: "positive-only",
		completeness: "partial",
		observedAt: PUBLISHED_AT.toISOString(),
		publishedObservationCount: 1,
		coverageReceipt: receipt(service),
		...overrides,
	};
}

function status(
	overrides: Partial<NonNullable<HistorySourceStatusProjectionInput["status"]>> = {},
) {
	return {
		connectionGeneration: 4,
		publishedAt: PUBLISHED_AT,
		publicationMetadata: encodeHistoryObservationMetadata(metadata(), NOW),
		lastAttemptAt: ATTEMPTED_AT,
		lastAttemptResult: "success",
		lastAttemptReason: null,
		...overrides,
	};
}

function input(
	overrides: Partial<HistorySourceStatusProjectionInput> = {},
): HistorySourceStatusProjectionInput {
	return {
		service: "sonarr",
		connectionGeneration: 4,
		status: status(),
		now: NOW,
		...overrides,
	};
}

function project(
	overrides: Partial<HistorySourceStatusProjectionInput> = {},
): ProviderObservationStatus {
	return projectHistorySourceStatus(input(overrides));
}

function expectSanitized(result: ProviderObservationStatus): void {
	expect(providerObservationStatusSchema.safeParse(result).success).toBe(true);
	expect(Object.keys(result).sort()).toEqual([
		"ageSeconds",
		"availability",
		"evidence",
		"latestAttempt",
		"observedAt",
		"reasonCodes",
	]);
}

describe("History source-status projection", () => {
	it.each(SERVICES)("projects a fresh %s publication as positive-only partial", (service) => {
		const result = project({
			service,
			status: status({
				publicationMetadata: encodeHistoryObservationMetadata(metadata(service), NOW),
			}),
		});
		expect(result).toMatchObject({
			availability: "partial",
			evidence: "positive-only",
			observedAt: PUBLISHED_AT.toISOString(),
			ageSeconds: 600,
			latestAttempt: "successful",
			reasonCodes: ["positive-only", "coverage-incomplete"],
		});
		expectSanitized(result);
	});

	it.each([
		["exactly fresh", new Date(PUBLISHED_AT.getTime() + 15 * 60 * 1000), "partial", false],
		[
			"one millisecond stale",
			new Date(PUBLISHED_AT.getTime() + 15 * 60 * 1000 + 1),
			"last-known",
			true,
		],
	] as const)("applies the strict 15-minute boundary for %s", (_name, now, availability, stale) => {
		const result = project({ now });
		expect(result).toMatchObject({ availability, evidence: "positive-only" });
		if (stale) expect(result.reasonCodes).toContain("publication-stale");
		else expect(result.reasonCodes).not.toContain("publication-stale");
	});

	it.each(OPERATIONAL_REASONS)(
		"projects a newer %s attempt without exposing persisted values",
		(reason) => {
			const result = project({
				status: status({
					lastAttemptAt: new Date(PUBLISHED_AT.getTime() + 1),
					lastAttemptResult: "error",
					lastAttemptReason: reason,
				}),
			});
			expect(result).toMatchObject({ availability: "last-known", latestAttempt: "failed" });
			expect(result.reasonCodes).toEqual([
				"positive-only",
				"coverage-incomplete",
				reason,
				"refresh-failed",
			]);
		},
	);

	it("deduplicates publication and newer-attempt reasons", () => {
		const publication = metadata("sonarr", {
			coverageReceipt: receipt("sonarr", {
				units: [
					{
						scopeKey: "history",
						expectedRawCount: null,
						pagesAttempted: 2,
						pagesCompleted: 1,
						rawObserved: 2,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [{ reason: "bounded-window-truncation", count: 1 }],
						fatalCount: 1,
					},
				],
			}),
		});
		const result = project({
			status: status({
				publicationMetadata: encodeHistoryObservationMetadata(publication, NOW),
				lastAttemptAt: new Date(PUBLISHED_AT.getTime() + 1),
				lastAttemptResult: "error",
				lastAttemptReason: "provider-limit",
			}),
		});
		expect(result.reasonCodes).toEqual([
			"positive-only",
			"provider-limit",
			"accepted-skips",
			"coverage-incomplete",
			"refresh-failed",
		]);
	});

	it.each([
		["equal", PUBLISHED_AT],
		["older", new Date(PUBLISHED_AT.getTime() - 1)],
	] as const)("does not add refresh-failed for an %s failed attempt", (_name, attemptedAt) => {
		const result = project({
			status: status({
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptReason: "provider-unavailable",
			}),
		});
		expect(result).toMatchObject({ availability: "partial", latestAttempt: "failed" });
		expect(result.reasonCodes).toContain("provider-unavailable");
		expect(result.reasonCodes).not.toContain("refresh-failed");
	});

	it("projects a newer running marker and a successful attempt exactly", () => {
		for (const lastAttemptResult of [marker(), stagedMarker("prepared"), stagedMarker("started")]) {
			const running = project({
				status: status({
					lastAttemptAt: new Date(PUBLISHED_AT.getTime() + 1),
					lastAttemptResult,
					lastAttemptReason: null,
				}),
			});
			expect(running).toMatchObject({ availability: "last-known", latestAttempt: "running" });
			expect(running.reasonCodes).toContain("refresh-running");
		}
		const successful = project({
			status: status({ lastAttemptAt: PUBLISHED_AT, lastAttemptResult: "success" }),
		});
		expect(successful).toMatchObject({ latestAttempt: "successful" });
		expect(successful.reasonCodes).not.toContain("refresh-failed");
	});

	it("projects collection deferral in the bounded reason order without changing availability", () => {
		const noPublication = project({
			status: {
				connectionGeneration: 4,
				publishedAt: null,
				publicationMetadata: null,
				lastAttemptAt: ATTEMPTED_AT,
				lastAttemptResult: "error",
				lastAttemptReason: "collection-deferred",
			},
		});
		expect(noPublication).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "failed",
			reasonCodes: ["no-publication", "collection-deferred"],
		});
		const prior = project({
			status: status({
				lastAttemptAt: new Date(PUBLISHED_AT.getTime() + 1),
				lastAttemptResult: "error",
				lastAttemptReason: "collection-deferred",
			}),
		});
		expect(prior).toMatchObject({ availability: "last-known", latestAttempt: "failed" });
		expect(prior.reasonCodes).toContain("collection-deferred");
	});

	it("applies the exact no-publication matrix", () => {
		const cases: Array<[string, unknown, unknown, unknown, ProviderObservationStatus]> = [
			[
				"idle",
				null,
				null,
				null,
				{
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "idle",
					reasonCodes: ["no-publication"],
				},
			],
			[
				"running",
				ATTEMPTED_AT,
				marker(),
				null,
				{
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "running",
					reasonCodes: ["no-publication", "refresh-running"],
				},
			],
			[
				"failure",
				ATTEMPTED_AT,
				"error",
				"provider-limit",
				{
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "failed",
					reasonCodes: ["no-publication", "provider-limit"],
				},
			],
			[
				"impossible success",
				ATTEMPTED_AT,
				"success",
				null,
				{
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "successful",
					reasonCodes: ["unknown-failure"],
				},
			],
		];
		for (const [_name, lastAttemptAt, lastAttemptResult, lastAttemptReason, expected] of cases) {
			const result = project({
				status: {
					connectionGeneration: 4,
					publishedAt: null,
					publicationMetadata: null,
					lastAttemptAt,
					lastAttemptResult,
					lastAttemptReason,
				},
			});
			expect(result).toEqual(expected);
		}
	});

	it.each([
		["invalid service", { service: "PLEX" }, "identity-unverified"],
		["invalid live generation", { connectionGeneration: -1 }, "unknown-failure"],
		["invalid now", { now: "not-a-date" }, "unknown-failure"],
		["malformed outer status", { status: {} }, "unknown-failure"],
		[
			"status generation mismatch",
			{ status: status({ connectionGeneration: 3 }) },
			"identity-changed",
		],
		[
			"generation mismatch before malformed marker",
			{ status: status({ connectionGeneration: 3, lastAttemptResult: "bad" }) },
			"identity-changed",
		],
		[
			"future attempt before malformed publication",
			{
				status: status({ lastAttemptAt: new Date(NOW.getTime() + 1), publicationMetadata: "bad" }),
			},
			"unknown-failure",
		],
		[
			"future publication",
			{ status: status({ publishedAt: new Date(NOW.getTime() + 1) }) },
			"unknown-failure",
		],
		["one-sided publication", { status: status({ publishedAt: null }) }, "receipt-invalid"],
		["malformed metadata", { status: status({ publicationMetadata: "bad" }) }, "receipt-invalid"],
		[
			"metadata service mismatch",
			{
				status: status({
					publicationMetadata: encodeHistoryObservationMetadata(metadata("radarr"), NOW),
				}),
			},
			"identity-changed",
		],
		[
			"metadata generation mismatch",
			{
				status: status({
					publicationMetadata: encodeHistoryObservationMetadata(
						metadata("sonarr", { connectionGeneration: 3 }),
						NOW,
					),
				}),
			},
			"identity-changed",
		],
		[
			"publication time mismatch",
			{
				status: status({
					publicationMetadata: encodeHistoryObservationMetadata(
						metadata("sonarr", {
							observedAt: "2026-09-03T11:00:00.001Z",
							coverageReceipt: receipt("sonarr", {
								observedAt: "2026-09-03T11:00:00.001Z",
							}),
						}),
						NOW,
					),
				}),
			},
			"receipt-invalid",
		],
	] as const)("fails closed with the correct precedence for %s", (_name, overrides, reason) => {
		const result = project(overrides as Partial<HistorySourceStatusProjectionInput>);
		expect(result).toMatchObject({
			availability: "unavailable",
			evidence: "unknown",
			reasonCodes: [reason],
		});
	});

	it("retains a valid failed attempt while rejecting malformed publication", () => {
		const result = project({
			status: status({
				publicationMetadata: "not-json",
				lastAttemptAt: new Date(PUBLISHED_AT.getTime() + 1),
				lastAttemptResult: "error",
				lastAttemptReason: "rows-inconsistent",
			}),
		});
		expect(result).toMatchObject({
			latestAttempt: "failed",
			reasonCodes: ["receipt-invalid", "rows-inconsistent"],
		});
		expect(result.reasonCodes).not.toContain("refresh-failed");
	});

	it("handles null status and rejects malformed attempts without echoing private inputs", () => {
		const nullStatus = project({ status: null });
		expect(nullStatus).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["no-publication"],
		});
		const privateValue = "owner-secret instance-secret https://secret.invalid opaque-token";
		const malformed = project(
			Object.assign(
				input({
					status: status({
						lastAttemptAt: "not-a-date",
						lastAttemptResult: privateValue,
						lastAttemptReason: privateValue,
					}),
				}),
				{ ownerId: privateValue, metadata: privateValue, receipt: privateValue },
			) as HistorySourceStatusProjectionInput,
		);
		expect(malformed).toEqual({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle",
			reasonCodes: ["unknown-failure"],
		});
		expect(JSON.stringify(malformed)).not.toContain(privateValue);
	});

	it("uses only the supplied current service and generation", () => {
		const result = project({
			service: "radarr",
			status: status({
				publicationMetadata: encodeHistoryObservationMetadata(metadata("radarr"), NOW),
			}),
		});
		expect(result.availability).toBe("partial");
		expectSanitized(result);
	});
});

describe("History source-status decoder integration", () => {
	it("keeps decoded attempt dates independent from persisted Date references", () => {
		const persisted = new Date(ATTEMPTED_AT);
		const result = decodeHistorySourceAttemptProjection(persisted, "success", null);
		expect(result).toMatchObject({ valid: true, state: "successful" });
		if (result.valid && result.attemptedAt) expect(result.attemptedAt).not.toBe(persisted);
	});
});
