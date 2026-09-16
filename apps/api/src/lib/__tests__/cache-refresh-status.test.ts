import { describe, expect, it, vi } from "vitest";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import { finishProviderCacheRefreshAttemptSuccess } from "../services/provider-cache-status.js";

describe("recordCacheRefreshFailure", () => {
	it("preserves an existing successful generation pointer on an incomplete attempt", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const attemptedAt = new Date("2026-08-03T12:00:00.000Z");

		await recordCacheRefreshFailure(
			{ cacheRefreshStatus: { upsert } } as never,
			"plex-1",
			"plex_episode",
			"truncated pagination",
			attemptedAt,
		);

		expect(upsert).toHaveBeenCalledWith({
			where: {
				instanceId_cacheType: { instanceId: "plex-1", cacheType: "plex_episode" },
			},
			create: {
				instanceId: "plex-1",
				cacheType: "plex_episode",
				lastRefreshedAt: attemptedAt,
				lastResult: "error",
				lastErrorMessage: "truncated pagination",
				itemCount: 0,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "truncated pagination",
			},
			update: {
				lastErrorMessage: "truncated pagination",
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "truncated pagination",
			},
		});
	});
});

describe("finishProviderCacheRefreshAttemptSuccess", () => {
	it("CASes the exact attempt and writes only bounded successful publication fields", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = { cacheRefreshStatus: { updateMany } };
		const observedAt = new Date("2026-09-02T12:01:00.000Z");
		const authority = {
			id: "plex-1",
			service: "PLEX" as const,
			connectionGeneration: 4,
			identityGeneration: 9,
		};
		const attempt = {
			attemptedAt: new Date("2026-09-02T12:00:00.000Z"),
			resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
		};

		await expect(
			finishProviderCacheRefreshAttemptSuccess(tx as never, "plex", authority as never, attempt, {
				observedAt,
				itemCount: 2,
				generationId: "generation-1",
				generationMetadata: "metadata",
			}),
		).resolves.toBe("recorded");
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				instanceId: "plex-1",
				cacheType: "plex",
				lastAttemptAt: attempt.attemptedAt,
				lastAttemptResult: attempt.resultMarker,
				connectionGeneration: 4,
				identityGeneration: 9,
			},
			data: {
				lastRefreshedAt: observedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: 2,
				generationId: "generation-1",
				generationMetadata: "metadata",
				lastAttemptAt: observedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: 4,
				identityGeneration: 9,
			},
		});
	});

	it("returns superseded without swallowing a CAS miss", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const tx = { cacheRefreshStatus: { updateMany } };
		await expect(
			finishProviderCacheRefreshAttemptSuccess(
				tx as never,
				"plex",
				{ id: "plex-1", service: "PLEX", connectionGeneration: 4, identityGeneration: 9 } as never,
				{
					attemptedAt: new Date("2026-09-02T12:00:00.000Z"),
					resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
				},
				{
					observedAt: new Date("2026-09-02T12:01:00.000Z"),
					itemCount: 2,
					generationId: null,
					generationMetadata: null,
				},
			),
		).resolves.toBe("superseded");
	});

	it("does not swallow a success CAS database error", async () => {
		const secret = "transaction detail";
		const tx = { cacheRefreshStatus: { updateMany: vi.fn().mockRejectedValue(new Error(secret)) } };

		await expect(
			finishProviderCacheRefreshAttemptSuccess(
				tx as never,
				"plex",
				{ id: "plex-1", service: "PLEX", connectionGeneration: 4, identityGeneration: 9 } as never,
				{
					attemptedAt: new Date("2026-09-02T12:00:00.000Z"),
					resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
				},
				{
					observedAt: new Date("2026-09-02T12:01:00.000Z"),
					itemCount: 2,
					generationId: null,
					generationMetadata: null,
				},
			),
		).rejects.toThrow(secret);
	});

	it.each(["success", "error", "in_progress:one"])(
		"rejects a non-live attempt marker (%s) without issuing a status write",
		async (resultMarker) => {
			const updateMany = vi.fn().mockResolvedValue({ count: 1 });
			const tx = { cacheRefreshStatus: { updateMany } };

			await expect(
				finishProviderCacheRefreshAttemptSuccess(
					tx as never,
					"plex",
					{
						id: "plex-1",
						service: "PLEX",
						connectionGeneration: 4,
						identityGeneration: 9,
					} as never,
					{
						attemptedAt: new Date("2026-09-02T12:00:00.000Z"),
						resultMarker,
					},
					{
						observedAt: new Date("2026-09-02T12:01:00.000Z"),
						itemCount: 2,
						generationId: null,
						generationMetadata: null,
					},
				),
			).rejects.toThrow("Provider cache refresh attempt is invalid");
			expect(updateMany).not.toHaveBeenCalled();
		},
	);

	it("rejects a non-string marker even when it coerces to a valid UUID", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = { cacheRefreshStatus: { updateMany } };
		const coercibleMarker = {
			toString: () => "in_progress:00000000-0000-4000-8000-000000000001",
		};

		await expect(
			finishProviderCacheRefreshAttemptSuccess(
				tx as never,
				"plex",
				{
					id: "plex-1",
					service: "PLEX",
					connectionGeneration: 4,
					identityGeneration: 9,
				} as never,
				{
					attemptedAt: new Date("2026-09-02T12:00:00.000Z"),
					resultMarker: coercibleMarker,
				} as never,
				{
					observedAt: new Date("2026-09-02T12:01:00.000Z"),
					itemCount: 2,
					generationId: null,
					generationMetadata: null,
				},
			),
		).rejects.toThrow("Provider cache refresh attempt is invalid");
		expect(updateMany).not.toHaveBeenCalled();
	});
});
