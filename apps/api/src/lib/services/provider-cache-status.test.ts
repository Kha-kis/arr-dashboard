import { afterEach, describe, expect, it, vi } from "vitest";
import {
	recordPlexCacheRefreshFailure,
	recordProviderCacheRefreshFailure,
} from "./provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "./provider-identity-guard.js";

const log = { warn: vi.fn() };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

function fixture(current: {
	service: "PLEX" | "TAUTULLI" | "JELLYFIN";
	enabled: boolean;
	connectionGeneration: number;
}) {
	const order: string[] = [];
	const tx = {
		$queryRawUnsafe: vi.fn(async () => {
			order.push("lock");
			return [];
		}),
		serviceInstance: {
			findUnique: vi.fn(async () => {
				order.push("identity");
				return current;
			}),
		},
		cacheRefreshStatus: {
			upsert: vi.fn(async () => {
				order.push("failure");
				return {};
			}),
		},
	};
	const prisma = {
		$transaction: vi.fn(
			async (callback: (transaction: typeof tx) => Promise<unknown>, _options?: unknown) =>
				callback(tx),
		),
	};
	return { prisma, tx, order };
}

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

describe("recordProviderCacheRefreshFailure", () => {
	it("discards a failure from an outgoing provider generation", async () => {
		const state = fixture({ service: "JELLYFIN", enabled: true, connectionGeneration: 8 });

		const result = await recordProviderCacheRefreshFailure(
			state.prisma as never,
			"instance-1",
			"plex",
			"old Plex failed",
			{ service: "PLEX", connectionGeneration: 7 },
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("locks and revalidates the current PostgreSQL generation before recording failure", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://database.example.com/arr");
		const state = fixture({ service: "TAUTULLI", enabled: true, connectionGeneration: 4 });

		const result = await recordProviderCacheRefreshFailure(
			state.prisma as never,
			"instance-1",
			"tautulli",
			"request failed",
			{ service: "TAUTULLI", connectionGeneration: 4 },
			log,
		);

		expect(result).toBe("recorded");
		expect(state.order).toEqual(["lock", "identity", "failure"]);
		expect(state.tx.$queryRawUnsafe).toHaveBeenCalledWith(
			'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
			"instance-1",
		);
		expect(state.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), undefined);
	});
});

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
