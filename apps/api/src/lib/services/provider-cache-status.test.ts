import { afterEach, describe, expect, it, vi } from "vitest";
import {
	recordPlexCacheRefreshFailure,
	recordWatchProviderCacheRefreshFailure,
} from "./provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "./provider-identity-guard.js";

const log = { warn: vi.fn() };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

function plexSnapshot(
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): OwnedProviderPublicationSnapshot {
	return {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Primary Plex",
		baseUrl: "https://plex.invalid",
		apiKey: "decrypted-token",
		httpAuthHeaders: { Authorization: "Basic proxy" },
		enabled: true,
		encryptedApiKey: "encrypted-token",
		encryptionIv: "token-iv",
		encryptedHttpAuthCredentials: "encrypted-proxy",
		httpAuthEncryptionIv: "proxy-iv",
		expectedIdentity: "plex-machine-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function publicationFixture(
	current: OwnedProviderPublicationSnapshot,
	status: { connectionGeneration: number | null; identityGeneration: number | null } | null,
) {
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-user-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-user-1", runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				Object.entries(where).every(
					([key, value]) => current[key as keyof OwnedProviderPublicationSnapshot] === value,
				)
					? { id: current.id }
					: null,
			),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue(status),
			upsert: vi.fn().mockResolvedValue({}),
		},
	};
	const prisma = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	};
	return { prisma, tx };
}

describe("recordPlexCacheRefreshFailure", () => {
	it.each(["plex", "plex_episode"] as const)(
		"does not create a %s failure after an identity-only replacement",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const state = publicationFixture(plexSnapshot({ identityGeneration: 10 }), null);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"outgoing identity failed",
				attempt,
				log,
			);

			expect(result).toBe("superseded");
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		},
	);

	it.each(["plex", "plex_episode"] as const)(
		"does not degrade a newer %s success after an identity-only replacement",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const newerStatus = { connectionGeneration: 4, identityGeneration: 10 };
			const state = publicationFixture(plexSnapshot({ identityGeneration: 10 }), newerStatus);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"outgoing identity failed",
				attempt,
				log,
			);

			expect(result).toBe("superseded");
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		},
	);

	it.each(["plex", "plex_episode"] as const)(
		"creates a %s failure with both publication generations",
		async (cacheType) => {
			const attempt = plexSnapshot();
			const state = publicationFixture(attempt, null);

			const result = await recordPlexCacheRefreshFailure(
				state.prisma as never,
				cacheType,
				"current identity failed",
				attempt,
				log,
			);

			expect(result).toBe("recorded");
			expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({
						connectionGeneration: 4,
						identityGeneration: 9,
					}),
				}),
			);
		},
	);

	it("does not update an existing status from another generation", async () => {
		const attempt = plexSnapshot();
		const state = publicationFixture(attempt, {
			connectionGeneration: 4,
			identityGeneration: 10,
		});

		const result = await recordPlexCacheRefreshFailure(
			state.prisma as never,
			"plex",
			"stale attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});
});

describe("recordWatchProviderCacheRefreshFailure", () => {
	it.each([
		["JELLYFIN", "jellyfin"],
		["EMBY", "jellyfin_episode"],
		["TAUTULLI", "tautulli"],
	] as const)("fences %s %s failure status by identity generation", async (service, cacheType) => {
		const attempt = plexSnapshot({ id: `${service}-1`, service, identityGeneration: 4 });
		const current = plexSnapshot({ id: `${service}-1`, service, identityGeneration: 5 });
		const state = publicationFixture(current, {
			connectionGeneration: attempt.connectionGeneration,
			identityGeneration: current.identityGeneration,
		});

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			cacheType,
			"outgoing attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it.each([
		["JELLYFIN", "jellyfin"],
		["EMBY", "jellyfin_episode"],
		["TAUTULLI", "tautulli"],
	] as const)("creates %s %s failure status with both generations", async (service, cacheType) => {
		const attempt = plexSnapshot({ id: `${service}-1`, service });
		const state = publicationFixture(attempt, null);

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			cacheType,
			"current attempt failed",
			attempt,
			log,
		);

		expect(result).toBe("recorded");
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			}),
		);
	});

	it("records a current failed attempt without replacing prior success fields", async () => {
		const attempt = plexSnapshot({ id: "JELLYFIN-1", service: "JELLYFIN" });
		const state = publicationFixture(attempt, {
			connectionGeneration: attempt.connectionGeneration,
			identityGeneration: attempt.identityGeneration,
		});

		const result = await recordWatchProviderCacheRefreshFailure(
			state.prisma as never,
			"jellyfin",
			"credential decrypt failed",
			attempt,
			log,
		);

		expect(result).toBe("recorded");
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.not.objectContaining({
					lastRefreshedAt: expect.anything(),
					lastResult: expect.anything(),
					lastErrorMessage: expect.anything(),
					itemCount: expect.anything(),
				}),
			}),
		);
	});
});
