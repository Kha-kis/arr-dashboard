import { describe, expect, it } from "vitest";
import {
	aggregateProviderObservationStatuses,
	type ProviderObservationSourceStatus,
	projectProviderObservationUi,
	providerCoverageReceiptSchema,
	providerObservationAcceptedResponseSchema,
	providerObservationStatusSchema,
} from "../provider-observation";

const NOW = "2026-09-02T12:00:00.000Z";

const coverageUnit = (overrides: Record<string, unknown> = {}) => ({
	scopeKey: "library:1",
	expectedRawCount: 2,
	pagesAttempted: 1,
	pagesCompleted: 1,
	rawObserved: 2,
	sourceBindings: 2,
	canonicalEntities: 2,
	acceptedSkips: [],
	fatalCount: 0,
	...overrides,
});

const status = (
	availability: ProviderObservationSourceStatus["status"]["availability"],
): ProviderObservationSourceStatus["status"] => ({
	availability,
	evidence: availability === "current" ? "complete" : "unknown",
	observedAt: availability === "unavailable" ? null : "2026-09-02T12:00:00.000Z",
	ageSeconds: availability === "unavailable" ? null : 60,
	latestAttempt: availability === "unavailable" ? "failed" : "successful",
	reasonCodes: availability === "unavailable" ? ["provider-unavailable"] : [],
});

const source = (
	instanceId: string,
	cacheType: ProviderObservationSourceStatus["cacheType"],
	service: ProviderObservationSourceStatus["service"],
	availability: ProviderObservationSourceStatus["status"]["availability"],
): ProviderObservationSourceStatus => ({
	instanceId,
	cacheType,
	service,
	status: status(availability),
});

describe("providerObservationStatusSchema", () => {
	it("accepts the stable hyphenated last-known and positive-only values", () => {
		expect(
			providerObservationStatusSchema.parse({
				availability: "last-known",
				evidence: "positive-only",
				observedAt: "2026-09-02T12:00:00.000Z",
				ageSeconds: 60,
				latestAttempt: "failed",
				reasonCodes: ["refresh-failed"],
			}),
		).toBeTruthy();
	});

	it("rejects arbitrary provider error text", () => {
		expect(() =>
			providerObservationStatusSchema.parse({
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				latestAttempt: "failed",
				reasonCodes: ["private upstream error"],
			}),
		).toThrow();
	});

	it("accepts only the bounded collection-deferred reason", () => {
		const valid = providerObservationStatusSchema.safeParse({
			availability: "unavailable",
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "failed",
			reasonCodes: ["collection-deferred"],
		});
		expect(valid.success).toBe(true);
		for (const reason of ["collection_deferred", "private provider error", "owner-secret"]) {
			expect(
				providerObservationStatusSchema.safeParse({
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "failed",
					reasonCodes: [reason],
				}).success,
			).toBe(false);
		}
	});
});

describe("providerCoverageReceiptSchema", () => {
	it("parses a V1 receipt without changing its JSON shape", () => {
		const receipt = {
			version: 1 as const,
			provider: "plex" as const,
			attemptStartedAt: NOW,
			observedAt: NOW,
			evidence: "complete" as const,
			units: [coverageUnit()],
			publishedCanonicalEntities: 2,
		};

		expect(providerCoverageReceiptSchema.parse(receipt)).toEqual(receipt);
	});

	it("parses a V2 receipt with domain-scoped evidence", () => {
		const inventoryDomain = {
			domain: "library-inventory" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			units: [coverageUnit({ scopeKey: "library:1" })],
			publishedCanonicalEntities: 2,
		};

		expect(
			providerCoverageReceiptSchema.parse({
				version: 2,
				provider: "plex",
				attemptStartedAt: NOW,
				observedAt: NOW,
				evidence: "partial",
				units: inventoryDomain.units,
				publishedCanonicalEntities: 2,
				domains: [inventoryDomain],
			}),
		).toMatchObject({ version: 2 });
	});

	it("rejects duplicate domains without exposing domain or scope values", () => {
		const inventoryDomain = {
			domain: "library-inventory" as const,
			evidence: "complete" as const,
			valueSemantics: "exact" as const,
			units: [coverageUnit({ scopeKey: "private:scope" })],
			publishedCanonicalEntities: 2,
		};
		const result = providerCoverageReceiptSchema.safeParse({
			version: 2,
			provider: "plex",
			attemptStartedAt: NOW,
			observedAt: NOW,
			evidence: "complete",
			units: inventoryDomain.units,
			domains: [inventoryDomain, inventoryDomain],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		const error = JSON.stringify(result.error);
		expect(error).toContain("duplicate domain");
		expect(error).not.toContain("private:scope");
	});

	it("rejects duplicate unit scope keys within a domain", () => {
		const result = providerCoverageReceiptSchema.safeParse({
			version: 2,
			provider: "plex",
			attemptStartedAt: NOW,
			observedAt: NOW,
			evidence: "complete",
			units: [coverageUnit({ scopeKey: "private:scope" })],
			domains: [
				{
					domain: "library-inventory",
					evidence: "complete",
					valueSemantics: "exact",
					units: [
						coverageUnit({ scopeKey: "private:scope" }),
						coverageUnit({ scopeKey: "private:scope" }),
					],
				},
			],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		const error = JSON.stringify(result.error);
		expect(error).toContain("duplicate scope key");
		expect(error).not.toContain("private:scope");
	});

	it("rejects an unknown domain", () => {
		expect(
			providerCoverageReceiptSchema.safeParse({
				version: 2,
				provider: "plex",
				attemptStartedAt: NOW,
				observedAt: NOW,
				evidence: "partial",
				units: [coverageUnit()],
				domains: [
					{
						domain: "library-unknown",
						evidence: "partial",
						valueSemantics: "unknown",
						units: [],
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects extra keys in V2 receipt and domain objects", () => {
		const validDomain = {
			domain: "library-inventory",
			evidence: "complete",
			valueSemantics: "exact",
			units: [coverageUnit()],
		};
		const receipt = {
			version: 2,
			provider: "plex",
			attemptStartedAt: NOW,
			observedAt: NOW,
			evidence: "complete",
			units: validDomain.units,
			domains: [validDomain],
			privateMarker: true,
		};

		expect(providerCoverageReceiptSchema.safeParse(receipt).success).toBe(false);
		expect(
			providerCoverageReceiptSchema.safeParse({
				...receipt,
				privateMarker: undefined,
				domains: [{ ...validDomain, privateMarker: true }],
			}).success,
		).toBe(false);
	});
});

describe("providerObservationAcceptedResponseSchema", () => {
	it("accepts only the durable accepted receipt fields", () => {
		expect(
			providerObservationAcceptedResponseSchema.parse({
				status: "accepted",
				cacheType: "plex",
			}),
		).toEqual({ status: "accepted", cacheType: "plex" });
	});

	it.each(["jellyfin", "tautulli"] as const)("accepts the %s cache type", (cacheType) => {
		expect(
			providerObservationAcceptedResponseSchema.parse({ status: "accepted", cacheType }),
		).toEqual({ status: "accepted", cacheType });
	});

	it.each([
		{ status: "complete", cacheType: "plex" },
		{ status: "accepted", cacheType: "emby" },
		{ status: "accepted", cacheType: "plex", upserted: 1 },
		{ status: "accepted", cacheType: "plex", marker: "private" },
	] as const)("rejects a non-contract response: %j", (value) => {
		expect(providerObservationAcceptedResponseSchema.safeParse(value).success).toBe(false);
	});
});

describe("projectProviderObservationUi", () => {
	const currentDomain = (domain: "library-inventory" | "mapping" | "watch-count") => ({
		domain,
		availability: "current" as const,
		evidence: "complete" as const,
		valueSemantics: "exact" as const,
		observedAt: NOW,
		reasonCodes: [],
	});

	it("requires every requested domain before current inventory and mapping can authorize watch use", () => {
		const projection = projectProviderObservationUi(
			{
				availability: "current",
				evidence: "complete",
				observedAt: NOW,
				ageSeconds: 1,
				latestAttempt: "successful",
				reasonCodes: [],
				domains: [
					currentDomain("library-inventory"),
					currentDomain("mapping"),
					{
						...currentDomain("watch-count"),
						availability: "unavailable",
						evidence: "unknown",
						valueSemantics: "unknown",
					},
				],
			},
			undefined,
			["library-inventory", "mapping", "watch-count"],
		);

		expect(projection.condition).toBe("unavailable");
	});

	it.each([
		["running", "collecting"],
		["failed", "retryable-failure"],
	] as const)("treats a current latest %s attempt as %s", (latestAttempt, condition) => {
		expect(
			projectProviderObservationUi({
				availability: "current",
				evidence: "complete",
				observedAt: NOW,
				ageSeconds: 1,
				latestAttempt,
				reasonCodes: [],
			}).condition,
		).toBe(condition);
	});

	it("keeps identity action priority above a failed current attempt", () => {
		expect(
			projectProviderObservationUi({
				availability: "current",
				evidence: "complete",
				observedAt: NOW,
				ageSeconds: 1,
				latestAttempt: "failed",
				reasonCodes: ["identity-changed"],
			}).condition,
		).toBe("identity-action-required");
	});
});

describe("aggregateProviderObservationStatuses", () => {
	it.each([
		["current", "current"],
		["last-known", "last-known"],
		["unavailable", "unavailable"],
		["partial", "partial"],
	] as const)(
		"returns %s when every source has that availability",
		(sourceAvailability, expected) => {
			const result = aggregateProviderObservationStatuses([
				source("instance-b", "jellyfin_episode", "emby", sourceAvailability),
				source("instance-a", "jellyfin", "jellyfin", sourceAvailability),
			]);

			expect(result?.availability).toBe(expected);
		},
	);

	it("returns partial for mixed current and last-known sources", () => {
		const result = aggregateProviderObservationStatuses([
			source("instance-a", "jellyfin", "jellyfin", "current"),
			source("instance-b", "jellyfin", "jellyfin", "last-known"),
		]);

		expect(result?.availability).toBe("partial");
	});

	it("returns partial for mixed usable and unavailable sources", () => {
		const result = aggregateProviderObservationStatuses([
			source("instance-a", "jellyfin", "jellyfin", "current"),
			source("instance-b", "jellyfin", "jellyfin", "unavailable"),
		]);

		expect(result?.availability).toBe("partial");
	});

	it("sorts sources by instance ID, cache type, and service", () => {
		const result = aggregateProviderObservationStatuses([
			source("instance-b", "jellyfin_episode", "jellyfin", "current"),
			source("instance-a", "jellyfin_episode", "emby", "current"),
			source("instance-a", "jellyfin", "emby", "current"),
			source("instance-a", "jellyfin", "jellyfin", "current"),
		]);

		expect(
			result?.sources.map(
				({ instanceId, cacheType, service }) => `${instanceId}:${cacheType}:${service}`,
			),
		).toEqual([
			"instance-a:jellyfin:emby",
			"instance-a:jellyfin:jellyfin",
			"instance-a:jellyfin_episode:emby",
			"instance-b:jellyfin_episode:jellyfin",
		]);
	});

	it("returns undefined for an empty source list", () => {
		expect(aggregateProviderObservationStatuses([])).toBeUndefined();
	});

	it.each([
		["service", { service: "plex" }],
		["cache type", { cacheType: "emby" }],
	] as const)("rejects an invalid %s wire value", (_label, invalidField) => {
		const invalidSource = {
			...source("instance-a", "jellyfin", "jellyfin", "current"),
			...invalidField,
		};

		expect(() => aggregateProviderObservationStatuses([invalidSource as never])).toThrow();
	});

	it("rejects arbitrary private error text in source status reason codes", () => {
		const invalidSource = {
			...source("instance-a", "jellyfin", "jellyfin", "unavailable"),
			status: {
				...status("unavailable"),
				reasonCodes: ["private upstream error"],
			},
		};

		expect(() => aggregateProviderObservationStatuses([invalidSource as never])).toThrow();
	});

	it("clones nested status and reason data", () => {
		const input = [source("instance-a", "jellyfin", "jellyfin", "current")];
		const result = aggregateProviderObservationStatuses(input);
		const [resultSource] = result?.sources ?? [];
		const [inputSource] = input;

		if (!resultSource || !inputSource) throw new Error("expected an aggregate result");
		resultSource.status.reasonCodes.push("coverage-incomplete");
		resultSource.status.availability = "partial";

		expect(inputSource.status.reasonCodes).toEqual([]);
		expect(inputSource.status.availability).toBe("current");
	});
});
