import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildEvalContext, prefetchSeerrRequests } from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

function verifiedProviderInstance(id: string, service: "PLEX" | "JELLYFIN" | "EMBY" = "JELLYFIN") {
	return {
		id,
		service,
		enabled: true,
		expectedIdentity: `${id}-identity`,
		identityStatus: "VERIFIED",
		connectionGeneration: 3,
		identityGeneration: 7,
		updatedAt: new Date(0),
	};
}

function successfulGeneration(instanceId: string, cacheType = "jellyfin", itemCount = 0) {
	return {
		instanceId,
		cacheType,
		lastRefreshedAt: new Date(),
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		itemCount,
		generationId: `${cacheType}-generation-1`,
		generationMetadata: null,
		connectionGeneration: 3,
		identityGeneration: 7,
	};
}

function seerrInstance(id: string) {
	return {
		id,
		baseUrl: `http://${id}.internal`,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		service: "SEERR",
		label: id,
	};
}

function seerrRequest(id: number, tmdbId: number) {
	const timestamp = "2026-08-13T12:00:00.000Z";
	return {
		id,
		status: 2,
		type: "tv",
		media: {
			id,
			tmdbId,
			status: 5,
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		createdAt: timestamp,
		updatedAt: timestamp,
		requestedBy: {
			id: 1,
			displayName: "Owner",
			createdAt: timestamp,
			updatedAt: timestamp,
			permissions: 0,
			requestCount: 1,
			userType: 1,
		},
		is4k: false,
	};
}

describe("external parent-rule authority", () => {
	it("fails closed when Jellyfin negative rules have no proven cache generation", async () => {
		const instance = { id: "jellyfin-1", updatedAt: new Date(0) };
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
			jellyfinCache: { findMany: vi.fn() },
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			buildEvalContext(
				{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
				"user-1",
				[{ enabled: true, ruleType: "jellyfin_user_rating", conditions: null }],
				{ requireAvailableEvidence: true },
			),
		).rejects.toThrow(/required evaluation evidence is unavailable: jellyfin\/emby/i);
		expect(prisma.jellyfinCache.findMany).not.toHaveBeenCalled();
	});

	it("accepts a status-proven empty Jellyfin generation as authoritative evidence", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const status = successfulGeneration(instance.id);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			jellyfinCache: { findMany: vi.fn().mockResolvedValue([]) },
		} as unknown as CleanupExecutorDeps["prisma"];

		const context = await buildEvalContext(
			{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
			"user-1",
			[{ enabled: true, ruleType: "jellyfin_user_rating", conditions: null }],
			{ requireAvailableEvidence: true },
		);

		expect(context.jellyfinMap).toEqual(new Map());
		expect(prisma.cacheRefreshStatus.findMany).toHaveBeenCalledTimes(2);
	});

	it("rejects legacy provider generations with null authority provenance", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const status = {
			...successfulGeneration(instance.id),
			connectionGeneration: null,
			identityGeneration: null,
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			jellyfinCache: { findMany: vi.fn() },
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			buildEvalContext(
				{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
				"user-1",
				[{ enabled: true, ruleType: "jellyfin_user_rating", conditions: null }],
				{ requireAvailableEvidence: true },
			),
		).rejects.toThrow(/required evaluation evidence is unavailable: jellyfin\/emby/i);
		expect(prisma.jellyfinCache.findMany).not.toHaveBeenCalled();
	});

	it("rejects malformed Jellyfin user evidence before negative rules can match", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const status = successfulGeneration(instance.id, "jellyfin", 1);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			jellyfinCache: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "row-1",
						tmdbId: 42,
						mediaType: "series",
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: "null",
						onDeck: false,
						userRating: null,
						addedAt: null,
					},
				]),
			},
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			buildEvalContext(
				{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
				"user-1",
				[{ enabled: true, ruleType: "jellyfin_watched_by", conditions: null }],
				{ requireAvailableEvidence: true },
			),
		).rejects.toThrow(/required evaluation evidence is unavailable: jellyfin\/emby/i);
	});

	it("passes the active cleanup lease through destructive provider refreshes", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const status = successfulGeneration(instance.id);
		const externalRuleCacheRefresher = vi.fn().mockResolvedValue(undefined);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status]) },
			jellyfinCache: { findMany: vi.fn().mockResolvedValue([]) },
		} as unknown as CleanupExecutorDeps["prisma"];

		await buildEvalContext(
			{ prisma, arrClientFactory: {} as never, externalRuleCacheRefresher, log },
			"user-1",
			[{ enabled: true, ruleType: "jellyfin_user_rating", conditions: null }],
			{
				destructiveAuthority: true,
				requireAvailableEvidence: true,
				cleanupRunClaimToken: "cleanup-run-token",
			},
		);

		expect(externalRuleCacheRefresher).toHaveBeenCalledWith("jellyfin", instance, {
			cleanupRunClaimToken: "cleanup-run-token",
		});
	});

	it("accepts only a stable Jellyfin episode generation bound to its parent cache", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const parent = successfulGeneration(instance.id);
		const episode = {
			...successfulGeneration(instance.id, "jellyfin_episode", 1),
			generationMetadata: JSON.stringify({ parentGenerationId: parent.generationId }),
		};
		const findMany = vi
			.fn()
			.mockResolvedValueOnce([episode])
			.mockResolvedValueOnce([parent])
			.mockResolvedValueOnce([episode])
			.mockResolvedValueOnce([parent]);
		const groupBy = vi
			.fn()
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }])
			.mockResolvedValueOnce([{ showTmdbId: 42, seasonNumber: 1, _count: { id: 1 } }]);
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: { findMany },
			jellyfinEpisodeCache: { groupBy },
		} as unknown as CleanupExecutorDeps["prisma"];

		const context = await buildEvalContext(
			{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
			"user-1",
			[{ enabled: true, ruleType: "jellyfin_episode_completion", conditions: null }],
			{ requireAvailableEvidence: true },
		);

		expect(context.jellyfinEpisodeMap?.get(42)).toEqual({
			total: 1,
			watched: 1,
			seasons: new Map([[1, { total: 1, watched: 1 }]]),
		});
		expect(groupBy).toHaveBeenCalledTimes(4);
	});

	it("rejects a Jellyfin episode snapshot whose parent generation changed", async () => {
		const instance = verifiedProviderInstance("jellyfin-1");
		const parent = successfulGeneration(instance.id);
		const episode = {
			...successfulGeneration(instance.id, "jellyfin_episode", 0),
			generationMetadata: JSON.stringify({ parentGenerationId: "older-parent" }),
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValueOnce([episode]).mockResolvedValueOnce([parent]),
			},
			jellyfinEpisodeCache: { groupBy: vi.fn() },
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			buildEvalContext(
				{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
				"user-1",
				[{ enabled: true, ruleType: "jellyfin_episode_completion", conditions: null }],
				{ requireAvailableEvidence: true },
			),
		).rejects.toThrow(/required evaluation evidence is unavailable: jellyfin\/emby episode/i);
		expect(prisma.jellyfinEpisodeCache.groupBy).not.toHaveBeenCalled();
	});

	it.each(["plex_episode_completion", "jellyfin_episode_completion"])(
		"does not treat an unconfigured %s provider as complete evidence",
		async (ruleType) => {
			const prisma = {
				serviceInstance: { findMany: vi.fn().mockResolvedValue([]) },
				plexEpisodeCache: { groupBy: vi.fn() },
				jellyfinEpisodeCache: { groupBy: vi.fn() },
				plexCache: { findMany: vi.fn() },
			} as unknown as CleanupExecutorDeps["prisma"];

			const context = await buildEvalContext(
				{ prisma, arrClientFactory: {} as never, log } as CleanupExecutorDeps,
				"user-1",
				[{ enabled: true, ruleType, conditions: null }],
				{ destructiveAuthority: true },
			);

			expect(context.plexEpisodeMap).toBeUndefined();
			expect(context.jellyfinEpisodeMap).toBeUndefined();
			expect(prisma.plexEpisodeCache.groupBy).not.toHaveBeenCalled();
			expect(prisma.jellyfinEpisodeCache.groupBy).not.toHaveBeenCalled();
		},
	);

	it("combines complete request evidence from every enabled Seerr instance", async () => {
		const instances = [seerrInstance("seerr-a"), seerrInstance("seerr-b")];
		const rawRequest = vi.fn(async (instance: { id: string }) => {
			const tmdbId = instance.id === "seerr-a" ? 101 : 202;
			return Response.json({
				pageInfo: { pages: 1, pageSize: 50, results: 1, page: 1 },
				results: [seerrRequest(tmdbId, tmdbId)],
			});
		});
		const deps = {
			prisma: {
				serviceInstance: { findMany: vi.fn().mockResolvedValue(instances) },
			},
			arrClientFactory: { rawRequest },
			log,
		} as unknown as CleanupExecutorDeps;

		const result = await prefetchSeerrRequests(deps, "user-1");

		expect(result?.has("tv:101")).toBe(true);
		expect(result?.has("tv:202")).toBe(true);
		expect(rawRequest).toHaveBeenCalledTimes(2);
	});

	it("rejects Seerr evidence above the bounded snapshot limit", async () => {
		const rawRequest = vi.fn(async () => {
			return Response.json({
				pageInfo: { pages: 2, pageSize: 5_001, results: 5_050, page: 1 },
				results: Array.from({ length: 5_001 }, (_, index) => seerrRequest(index + 1, index + 1)),
			});
		});
		const deps = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([seerrInstance("seerr-a")]),
				},
			},
			arrClientFactory: { rawRequest },
			log,
		} as unknown as CleanupExecutorDeps;

		await expect(prefetchSeerrRequests(deps, "user-1")).resolves.toBeUndefined();
		expect(rawRequest).toHaveBeenCalledOnce();
	});

	it("accepts complete Seerr evidence with exactly 5,000 requests", async () => {
		const rawRequest = vi.fn(async () => {
			return Response.json({
				pageInfo: { pages: 1, pageSize: 5_001, results: 5_000, page: 1 },
				results: Array.from({ length: 5_000 }, (_, index) => seerrRequest(index + 1, index + 1)),
			});
		});
		const deps = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([seerrInstance("seerr-a")]),
				},
			},
			arrClientFactory: { rawRequest },
			log,
		} as unknown as CleanupExecutorDeps;

		const result = await prefetchSeerrRequests(deps, "user-1");

		expect(result).toHaveLength(5_000);
		expect(result?.has("tv:1")).toBe(true);
		expect(result?.has("tv:5000")).toBe(true);
		expect(rawRequest).toHaveBeenCalledOnce();
	});

	it("rejects an incomplete Seerr snapshot", async () => {
		const rawRequest = vi.fn(async () => {
			return Response.json({
				pageInfo: { pages: 1, pageSize: 5_001, results: 5_000, page: 1 },
				results: Array.from({ length: 4_999 }, (_, index) => seerrRequest(index + 1, index + 1)),
			});
		});
		const deps = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([seerrInstance("seerr-a")]),
				},
			},
			arrClientFactory: { rawRequest },
			log,
		} as unknown as CleanupExecutorDeps;

		await expect(prefetchSeerrRequests(deps, "user-1")).resolves.toBeUndefined();
		expect(rawRequest).toHaveBeenCalledOnce();
	});
});
