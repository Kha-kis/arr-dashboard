import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClientInstance } from "../prisma.js";
import type { PlexClient } from "./plex-client.js";
import { refreshPlexEpisodeCache as refreshGuardedPlexEpisodeCache } from "./plex-episode-cache-refresher.js";

const publication = vi.hoisted(() => ({ client: undefined as PlexClient | undefined }));

vi.mock("./plex-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plex-client.js")>();
	return {
		...actual,
		PlexClient: class {
			constructor() {
				if (!publication.client) throw new Error("Plex episode test client was not configured");
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
				prisma: PrismaClientInstance,
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
			) => {
				const snapshot = await collect();
				return await prisma.$transaction(async (tx) => await publish(tx, snapshot));
			},
		),
	};
});

vi.mock("../services/provider-cache-status.js", () => ({
	beginPlexCacheRefreshAttempt: vi.fn().mockResolvedValue({
		attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
		resultMarker: "in_progress:test-attempt",
	}),
	finishPlexCacheRefreshAttemptFailure: vi.fn().mockResolvedValue("recorded"),
}));

vi.mock("./service-instance-fingerprint.js", () => ({
	plexConnectionFingerprint: vi.fn(() => "fingerprint-1"),
}));

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;

function episode(ratingKey = "episode-1", viewCount = 1) {
	return {
		ratingKey,
		title: "Pilot",
		seasonNumber: 1,
		episodeNumber: 1,
		viewCount,
		lastViewedAt: 1_700_000_000,
	};
}

function client(overrides: Partial<PlexClient> = {}): PlexClient {
	return {
		getHistory: vi.fn().mockResolvedValue([
			{
				type: "episode",
				ratingKey: "episode-1",
				accountID: 1,
				viewedAt: 1_700_000_000,
			},
		]),
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
		getEpisodes: vi.fn().mockResolvedValue([episode()]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as PlexClient;
}

async function refreshPlexEpisodeCache(
	plexClient: PlexClient,
	db: PrismaClientInstance,
	instanceId: string,
	refreshLog: FastifyBaseLogger,
	_sourceFingerprint: string,
	_expectedConnection: unknown,
) {
	publication.client = plexClient;
	return await refreshGuardedPlexEpisodeCache({
		prisma: db,
		instance: {
			id: instanceId,
			userId: "user-1",
			service: "PLEX",
			label: "Plex",
			baseUrl: "https://plex.invalid",
			apiKey: "token",
			httpAuthHeaders: {},
			enabled: true,
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "plex-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 7,
			identityGeneration: 11,
		},
		log: refreshLog,
	});
}

function prisma(
	shows = [{ tmdbId: 42, ratingKey: "show-1" }],
	currentConnection = { service: "PLEX", enabled: true, connectionGeneration: 7 },
	parentStatuses: Array<Record<string, unknown> | null> = [],
) {
	const fixtureNow = Date.now();
	const publishedAt = new Date(fixtureNow - 60_000);
	const attemptedAt = new Date(fixtureNow - 30_000);
	const baseParentStatus = {
		id: "plex-status-1",
		instanceId: "plex-1",
		cacheType: "plex",
		lastRefreshedAt: publishedAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: shows.length,
		generationId: "parent-generation-1",
		generationMetadata: JSON.stringify({
			sections: [{ key: "shows", title: "Shows", type: "show" }],
		}),
		lastAttemptAt: attemptedAt,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 7,
		identityGeneration: 11,
	};
	const parentStatus = (overrides: Record<string, unknown> = {}) => ({
		...baseParentStatus,
		...overrides,
	});
	const statuses =
		parentStatuses.length > 0
			? [...parentStatuses]
			: [parentStatus(), parentStatus(), parentStatus(), parentStatus()];
	const fullShows = shows.map((show, index) => ({
		id: `plex-row-${index + 1}`,
		instanceId: "plex-1",
		mediaType: "series",
		sectionId: "shows",
		sectionTitle: "Shows",
		title: `Show ${index + 1}`,
		lastWatchedAt: new Date(),
		watchCount: 1,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		labels: "[]",
		addedAt: null,
		thumb: null,
		connectionGeneration: 7,
		identityGeneration: 11,
		...show,
	}));
	const published: unknown[] = [];
	const tx = {
		serviceInstance: { findUnique: vi.fn().mockResolvedValue(currentConnection) },
		plexEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				published.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: {
			upsert: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	const db = {
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue({
				id: "plex-1",
				userId: "user-1",
				service: "PLEX",
				enabled: true,
				label: "Plex",
				connectionGeneration: 7,
				identityGeneration: 11,
				identityStatus: "VERIFIED",
				expectedIdentity: "plex-a",
				identityKind: "plex-machine-identifier",
				identityVerifiedAt: new Date(0),
				updatedAt: new Date(0),
			}),
		},
		cacheRefreshStatus: {
			findMany: vi.fn(async () => [statuses.shift() ?? parentStatus()]),
		},
		plexCache: {
			count: vi.fn().mockResolvedValue(fullShows.length),
			findMany: vi.fn().mockResolvedValue(fullShows),
		},
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	} as unknown as PrismaClientInstance;
	return { db, tx, published, parentStatus };
}

describe("refreshPlexEpisodeCache authoritative publication", () => {
	it("uses stable parent authority timestamps within one fixture", () => {
		vi.useFakeTimers();
		try {
			const initialTime = new Date("2026-08-20T12:00:00.000Z");
			vi.setSystemTime(initialTime);
			const statusFactory = prisma();
			const firstStatus = statusFactory.parentStatus();
			vi.setSystemTime(new Date(initialTime.getTime() + 1));
			const laterStatus = statusFactory.parentStatus();

			expect((firstStatus.lastRefreshedAt as Date).getTime()).toBe(
				(laterStatus.lastRefreshedAt as Date).getTime(),
			);
			expect((firstStatus.lastAttemptAt as Date).getTime()).toBe(
				(laterStatus.lastAttemptAt as Date).getTime(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects publication when the parent timestamp changes across authority reads", async () => {
		const statusFactory = prisma();
		const firstStatus = statusFactory.parentStatus();
		const changedStatus = {
			...firstStatus,
			lastRefreshedAt: new Date((firstStatus.lastRefreshedAt as Date).getTime() + 1),
		};
		const fixture = prisma(undefined, undefined, [firstStatus, changedStatus]);

		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/parent Plex generation is unavailable/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it("atomically replaces one instance and binds every row to the published generation", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "plex-1" },
		});
		expect(fixture.published).toEqual([
			expect.objectContaining({
				instanceId: "plex-1",
				showTmdbId: 42,
				watchCount: 1,
				watchedByUsers: JSON.stringify(["Alice"]),
				sourceFingerprint: "fingerprint-1",
				refreshedAt: result.completedAt,
			}),
		]);
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastRefreshedAt: result.completedAt,
					itemCount: 1,
					generationId: expect.any(String),
					generationMetadata: expect.any(String),
				}),
			}),
		);
		const metadata = JSON.parse(
			fixture.tx.cacheRefreshStatus.updateMany.mock.calls[0]![0].data.generationMetadata,
		);
		expect(metadata).toEqual({
			version: 1,
			parentPlexGenerationId: "parent-generation-1",
			parentPublicationLevel: "authoritative",
			connectionGeneration: 7,
			identityGeneration: 11,
		});
	});

	it("keeps prior episode rows when the authoritative parent metadata is unavailable", async () => {
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			{
				...prisma().parentStatus(),
				generationMetadata: null,
			},
		]);
		const plexClient = client();

		const result = await refreshPlexEpisodeCache(
			plexClient,
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(plexClient.getHistory).not.toHaveBeenCalled();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps prior episode rows when the parent latest attempt failed", async () => {
		const failedParent = prisma().parentStatus({
			lastAttemptAt: new Date(Date.now() - 1_000),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "parent inventory changed",
			lastErrorMessage: "parent inventory changed",
		});
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			failedParent,
			{ ...failedParent },
		]);
		const plexClient = client();

		const result = await refreshPlexEpisodeCache(
			plexClient,
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(plexClient.getHistory).not.toHaveBeenCalled();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps prior episode rows when the parent generation changes during collection", async () => {
		const base = prisma().parentStatus();
		const changed = { ...base, generationId: "parent-generation-2" };
		const fixture = prisma([{ tmdbId: 42, ratingKey: "show-1" }], undefined, [
			base,
			{ ...base },
			changed,
			{ ...changed },
		]);

		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0, coverageIncomplete: true });
		expect(result.errorMessages.join(" ")).toMatch(/parent Plex generation changed/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("publishes a complete eligible-empty inventory and evicts stale rows", async () => {
		const fixture = prisma([]);
		const result = await refreshPlexEpisodeCache(
			client({ getHistory: vi.fn().mockResolvedValue([]) } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).toHaveBeenCalledOnce();
		expect(fixture.tx.plexEpisodeCache.createMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledOnce();
	});

	it("leaves the previous generation unchanged when one duplicate show copy fails", async () => {
		const fixture = prisma([
			{ tmdbId: 42, ratingKey: "show-a" },
			{ tmdbId: 42, ratingKey: "show-b" },
		]);
		const getEpisodes = vi
			.fn()
			.mockResolvedValueOnce([episode()])
			.mockRejectedValueOnce(new Error("copy unavailable"));
		const result = await refreshPlexEpisodeCache(
			client({ getEpisodes } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("publishes complete episode evidence beyond the legacy 5,000-row cap", async () => {
		const fixture = prisma();
		const history = Array.from({ length: 5000 }, (_, index) => ({
			type: "episode",
			ratingKey: "episode-1",
			accountID: 1,
			viewedAt: 1_700_000_000 + index,
		}));
		const getHistory = vi.fn().mockResolvedValue(history);
		const result = await refreshPlexEpisodeCache(
			client({ getHistory } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(getHistory).toHaveBeenCalledWith({ maxResults: 100_000, requireComplete: true });
		expect(fixture.db.$transaction).toHaveBeenCalledOnce();
	});

	it("keeps the previous episode generation when complete history exceeds the safety bound", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({
				getHistory: vi
					.fn()
					.mockRejectedValue(
						new Error("Plex history contains 100001 rows, exceeding the safe 100000-row limit"),
					),
			} as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/exceeding the safe 100000-row limit/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous episode generation when complete history contains a repeated page", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({
				getHistory: vi
					.fn()
					.mockRejectedValue(new Error("Plex history returned a duplicate row while paging")),
			} as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/duplicate row while paging/i);
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("keeps the previous episode generation when history changes during episode enrichment", async () => {
		const fixture = prisma();
		const verifyHistorySnapshot = vi
			.fn()
			.mockRejectedValue(new Error("Plex history changed before publication"));
		const result = await refreshPlexEpisodeCache(
			client({ verifyHistorySnapshot } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/revalidate Plex history/i);
		expect(verifyHistorySnapshot).toHaveBeenCalledOnce();
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("fails closed when account attribution is absent from a complete account inventory", async () => {
		const fixture = prisma();
		const result = await refreshPlexEpisodeCache(
			client({ getAccounts: vi.fn().mockResolvedValue([]) } as Partial<PlexClient>),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("rejects inventories beyond the bounded complete-show capacity", async () => {
		const shows = Array.from({ length: 201 }, (_, index) => ({
			tmdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const fixture = prisma(shows);
		const result = await refreshPlexEpisodeCache(
			client(),
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			undefined,
		);

		expect(result).toMatchObject({
			complete: false,
			capacityDegraded: true,
			eligibleShows: 201,
			refreshedShows: 0,
		});
		expect(fixture.tx.plexEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});
});
