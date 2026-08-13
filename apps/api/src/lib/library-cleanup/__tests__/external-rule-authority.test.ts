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

	it("rejects Seerr evidence when pagination reaches the safety cap", async () => {
		const rawRequest = vi.fn(async (_instance: unknown, path: string) => {
			const skip = Number(new URL(path, "http://seerr.invalid").searchParams.get("skip") ?? 0);
			return Response.json({
				pageInfo: { pages: 101, pageSize: 50, results: 5_050, page: skip / 50 + 1 },
				results: Array.from({ length: 50 }, (_, index) =>
					seerrRequest(skip + index + 1, skip + index + 1),
				),
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
		expect(rawRequest).toHaveBeenCalledTimes(100);
	});
});
