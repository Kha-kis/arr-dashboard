import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClientInstance } from "../prisma.js";
import type { PlexClient } from "./plex-client.js";
import { refreshPlexEpisodeCache } from "./plex-episode-cache-refresher.js";

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

function prisma(
	shows = [{ tmdbId: 42, ratingKey: "show-1" }],
	currentConnection = { service: "PLEX", enabled: true, connectionGeneration: 7 },
) {
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
		cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
	};
	const db = {
		plexCache: { findMany: vi.fn().mockResolvedValue(shows) },
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	} as unknown as PrismaClientInstance;
	return { db, tx, published };
}

describe("refreshPlexEpisodeCache authoritative publication", () => {
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
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ lastRefreshedAt: result.completedAt, itemCount: 1 }),
			}),
		);
	});

	it("discards an outgoing episode generation after its Plex connection changes", async () => {
		const currentConnection = {
			service: "PLEX",
			enabled: true,
			connectionGeneration: 7,
		};
		const fixture = prisma(undefined, currentConnection);
		let resolveHistory: (history: unknown[]) => void = () => {};
		const pendingHistory = new Promise<unknown[]>((resolve) => {
			resolveHistory = resolve;
		});
		const plexClient = client({ getHistory: vi.fn().mockReturnValue(pendingHistory) });
		const refresh = refreshPlexEpisodeCache(
			plexClient,
			fixture.db,
			"plex-1",
			log,
			"fingerprint-1",
			{ service: "PLEX", connectionGeneration: 7 },
		);
		await vi.waitFor(() => expect(plexClient.getHistory).toHaveBeenCalledOnce());
		currentConnection.connectionGeneration = 8;
		resolveHistory([
			{ type: "episode", ratingKey: "episode-1", accountID: 1, viewedAt: 1_700_000_000 },
		]);
		const result = await refresh;

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
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
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
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
		expect(fixture.db.$transaction).not.toHaveBeenCalled();
	});
});
