import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../prisma.js";
import type { JellyfinClient } from "./jellyfin-client.js";
import {
	JELLYFIN_EPISODE_MAX_SERIES,
	refreshJellyfinEpisodeCache as refreshGuardedJellyfinEpisodeCache,
} from "./jellyfin-episode-cache-refresher.js";

const publication = vi.hoisted(() => ({ client: undefined as JellyfinClient | undefined }));

vi.mock("./jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.client) throw new Error("Episode test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

vi.mock("../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: vi.fn(
			async (
				prisma: { $transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
			) => {
				const snapshot = await collect();
				if ((snapshot as { complete?: boolean }).complete !== true) return snapshot;
				return await prisma.$transaction(async (tx) => await publish(tx, snapshot));
			},
		),
		withCurrentProviderPublicationAuthority: vi.fn(
			async (
				prisma: { $transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
				_instance: unknown,
				action: (tx: unknown) => Promise<unknown>,
			) => ({ matched: true, value: await prisma.$transaction(action) }),
		),
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
} as unknown as FastifyBaseLogger;

type TestConnection = {
	service: "JELLYFIN" | "EMBY";
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: string | null;
	httpAuthEncryptionIv: string | null;
	enabled: boolean;
	connectionGeneration: number;
};

const connectionOne: TestConnection = {
	service: "JELLYFIN",
	baseUrl: "https://jellyfin-one.example.com",
	encryptedApiKey: "key-one",
	encryptionIv: "iv-one",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
	connectionGeneration: 7,
};
async function refreshJellyfinEpisodeCache(
	client: JellyfinClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: string,
) {
	publication.client = client;
	return await refreshGuardedJellyfinEpisodeCache({
		prisma,
		instance: {
			id: instanceId,
			userId: "user-1",
			service: "JELLYFIN",
			label: "Jellyfin",
			baseUrl: connectionOne.baseUrl,
			apiKey: "key",
			httpAuthHeaders: {},
			enabled: true,
			encryptedApiKey: connectionOne.encryptedApiKey,
			encryptionIv: connectionOne.encryptionIv,
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "jellyfin-a",
			identityStatus: "VERIFIED",
			connectionGeneration: connectionOne.connectionGeneration,
			identityGeneration: 2,
		},
		log,
	});
}

function fixture(
	series: unknown[] = [{ tmdbId: 42, jellyfinId: "series-1", title: "Show" }],
	currentConnection = connectionOne,
) {
	const published: unknown[] = [];
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
		jellyfinEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				published.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue(null),
			findFirst: vi.fn().mockResolvedValue({ generationId: "jellyfin-parent-generation" }),
			upsert: vi.fn().mockResolvedValue({}),
		},
	};
	const prisma = {
		jellyfinCache: { findMany: vi.fn().mockResolvedValue(series) },
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue({
				lastResult: "success",
				generationId: "jellyfin-parent-generation",
				connectionGeneration: connectionOne.connectionGeneration,
				identityGeneration: 2,
			}),
		},
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	} as unknown as PrismaClient;
	const client = {
		getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
		getEpisodes: vi.fn().mockResolvedValue([
			{
				id: "episode-1",
				name: "Pilot",
				seasonNumber: 1,
				episodeNumber: 1,
				played: true,
				lastPlayedDate: "2026-01-01T00:00:00Z",
			},
		]),
	} as unknown as JellyfinClient;
	return { prisma, client, tx, published };
}

describe("refreshJellyfinEpisodeCache authoritative publication", () => {
	it("atomically replaces stale rows only after a complete cross-user scan", async () => {
		const state = fixture();
		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toMatchObject({ upserted: 1, errors: 0, complete: true });
		expect(result.generationId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(state.tx.jellyfinEpisodeCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "jellyfin-1" },
		});
		expect(state.published).toEqual([
			expect.objectContaining({
				instanceId: "jellyfin-1",
				showTmdbId: 42,
				watched: true,
				watchedByUsers: JSON.stringify(["Alice"]),
				connectionGeneration: 7,
				identityGeneration: 2,
			}),
		]);
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					connectionGeneration: 7,
					identityGeneration: 2,
					generationId: result.generationId,
					generationMetadata: JSON.stringify({
						parentGenerationId: "jellyfin-parent-generation",
					}),
				}),
				update: expect.objectContaining({
					connectionGeneration: 7,
					identityGeneration: 2,
					generationId: result.generationId,
				}),
			}),
		);
	});

	it("does not publish when the parent Jellyfin generation changes during collection", async () => {
		const state = fixture();
		state.tx.cacheRefreshStatus.findFirst.mockResolvedValueOnce(null);

		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "Jellyfin episode refresh did not produce a complete generation",
				}),
			}),
		);
	});

	it("does not publish when one user's episode inventory fails", async () => {
		const state = fixture();
		(state.client.getUsers as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		]);
		(state.client.getEpisodes as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error("partial"));

		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});

	it("does not evict prior evidence when user discovery is empty", async () => {
		const state = fixture();
		(state.client.getUsers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});

	it("rejects a truncated series inventory without publishing any rows", async () => {
		const series = Array.from({ length: JELLYFIN_EPISODE_MAX_SERIES + 1 }, (_, index) => ({
			tmdbId: index + 1,
			jellyfinId: `series-${index + 1}`,
			title: `Show ${index + 1}`,
		}));
		const state = fixture(series);

		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});

	it("publishes an empty complete inventory to evict stale rows", async () => {
		const state = fixture([]);
		const result = await refreshJellyfinEpisodeCache(
			state.client,
			state.prisma,
			"jellyfin-1",
			log,
			"ignored",
		);

		expect(result).toMatchObject({ upserted: 0, errors: 0, complete: true });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).toHaveBeenCalledOnce();
		expect(state.tx.jellyfinEpisodeCache.createMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});
});
