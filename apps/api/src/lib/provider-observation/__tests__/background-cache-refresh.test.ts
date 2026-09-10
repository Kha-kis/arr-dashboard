import { describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import {
	classifyProviderRefreshSettlement,
	ProviderCacheRefreshSupersededError,
	startProviderCacheRefreshInBackground,
} from "../background-cache-refresh.js";

const attempt = {
	attemptedAt: new Date("2026-09-05T01:00:00.000Z"),
	resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
};

function logger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
	};
}

describe.sequential("claim-first provider cache background refresh", () => {
	it("claims under an independent lease and holds it through the exact deferred producer", async () => {
		let resolveClaim!: (value: { status: "acquired"; attempt: typeof attempt }) => void;
		const claim = new Promise<{ status: "acquired"; attempt: typeof attempt }>((resolve) => {
			resolveClaim = resolve;
		});
		let finishProducer!: () => void;
		const producerFinished = new Promise<void>((resolve) => {
			finishProducer = resolve;
		});
		const producedAttempts: (typeof attempt)[] = [];
		const log = logger();

		const admissionPromise = startProviderCacheRefreshInBackground({
			cacheType: "jellyfin",
			claim: () => claim,
			produce: async (claimedAttempt) => {
				producedAttempts.push(claimedAttempt);
				await producerFinished;
				return { complete: true, completedAt: attempt.attemptedAt };
			},
			log,
		});

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);
		resolveClaim({ status: "acquired", attempt });
		const admission = await admissionPromise;
		expect(admission.accepted).toBe(true);
		expect(producedAttempts).toEqual([attempt]);
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finishProducer();
		await admission.backgroundTask;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
		expect(log.info).toHaveBeenCalledWith(
			{ cacheType: "jellyfin", settlement: "complete" },
			"Provider cache refresh settled",
		);
		expect(log.info.mock.calls[0]?.[0]).toEqual({
			cacheType: "jellyfin",
			settlement: "complete",
		});
	});

	it("accepts an already-running durable claim without starting a duplicate producer", async () => {
		const produce = vi.fn();
		const admission = await startProviderCacheRefreshInBackground({
			cacheType: "plex",
			claim: async () => ({ status: "already-running" as const, attempt }),
			produce,
			log: logger(),
		});

		expect(admission.accepted).toBe(true);
		expect(produce).not.toHaveBeenCalled();
		await admission.backgroundTask;
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
	});

	it.each(["acquired", "already-running"] as const)(
		"rejects a %s claim with a malformed durable marker",
		async (status) => {
			const produce = vi.fn();
			await expect(
				startProviderCacheRefreshInBackground({
					cacheType: "jellyfin",
					claim: async () =>
						({
							status,
							attempt: { ...attempt, resultMarker: "in_progress:not-a-uuid" },
						}) as never,
					produce,
					log: logger(),
				}),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(produce).not.toHaveBeenCalled();
			await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
		},
	);

	it("rejects superseded and claim failures without leaving a lease or invoking the producer", async () => {
		const supersededProduce = vi.fn();
		await expect(
			startProviderCacheRefreshInBackground({
				cacheType: "tautulli",
				claim: async () => ({ status: "superseded" as const }),
				produce: supersededProduce,
				log: logger(),
			}),
		).rejects.toBeInstanceOf(ProviderCacheRefreshSupersededError);
		expect(supersededProduce).not.toHaveBeenCalled();
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");

		const claimError = new Error("private provider detail");
		const failureLog = logger();
		const failedProduce = vi.fn();
		await expect(
			startProviderCacheRefreshInBackground({
				cacheType: "jellyfin",
				claim: async () => {
					throw claimError;
				},
				produce: failedProduce,
				log: failureLog,
			}),
		).rejects.toMatchObject({
			name: "ProviderCacheRefreshClaimError",
			statusCode: 503,
		});
		expect(failedProduce).not.toHaveBeenCalled();
		expect(failureLog.warn).toHaveBeenCalledWith(
			{ cacheType: "jellyfin", settlement: "failed" },
			"Provider cache refresh was not accepted",
		);
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");

		const malformedProduce = vi.fn();
		await expect(
			startProviderCacheRefreshInBackground({
				cacheType: "plex",
				claim: async () => ({ status: "acquired" }) as never,
				produce: malformedProduce,
				log: logger(),
			}),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(malformedProduce).not.toHaveBeenCalled();
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
	});

	it("catches producer failures, releases the lease, and emits only bounded settlement telemetry", async () => {
		const log = logger();
		const admission = await startProviderCacheRefreshInBackground({
			cacheType: "jellyfin",
			claim: async () => ({ status: "acquired" as const, attempt }),
			produce: async () => {
				throw new Error("private provider payload");
			},
			log,
		});

		await expect(admission.backgroundTask).resolves.toBeUndefined();
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
		expect(log.warn).toHaveBeenCalledWith(
			{ cacheType: "jellyfin", settlement: "failed" },
			"Provider cache refresh settled",
		);
		expect(log.warn.mock.calls.flat()).not.toContain("private provider payload");
	});

	it("propagates an active maintenance conflict before invoking the claim", async () => {
		let releaseMaintenance!: () => void;
		const maintenance = withCleanupMaintenanceGuard(
			() =>
				new Promise<void>((resolve) => {
					releaseMaintenance = resolve;
				}),
		);
		const claim = vi.fn();

		const admission = startProviderCacheRefreshInBackground({
			cacheType: "plex",
			claim,
			produce: async () => ({ complete: true, completedAt: new Date() }),
			log: logger(),
		});
		await expect(admission).rejects.toBeInstanceOf(CleanupMaintenanceConflictError);
		expect(claim).not.toHaveBeenCalled();

		releaseMaintenance();
		await maintenance;
		await expect(withCleanupMaintenanceGuard(async () => "available")).resolves.toBe("available");
	});
});

describe("provider cache result settlement classification", () => {
	it.each([
		[{ complete: true, completedAt: new Date() }, "complete"],
		[{ complete: false, completedAt: new Date() }, "partial"],
		[{ complete: false }, "unpublished"],
		[{ complete: true }, "unpublished"],
		[{ superseded: true }, "superseded"],
		[null, "unpublished"],
	])("classifies %j as %s without inventing completion", (result, expected) => {
		expect(classifyProviderRefreshSettlement(result)).toBe(expected);
	});
});
