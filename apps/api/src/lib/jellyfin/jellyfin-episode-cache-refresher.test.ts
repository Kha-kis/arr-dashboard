import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../prisma.js";
import type { JellyfinClient } from "./jellyfin-client.js";
import {
	JELLYFIN_EPISODE_MAX_SERIES,
	refreshJellyfinEpisodeCache,
} from "./jellyfin-episode-cache-refresher.js";

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
} as unknown as FastifyBaseLogger;

function fixture(series: unknown[] = [{ tmdbId: 42, jellyfinId: "series-1", title: "Show" }]) {
	const published: unknown[] = [];
	const tx = {
		jellyfinEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				published.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
	};
	const prisma = {
		jellyfinCache: { findMany: vi.fn().mockResolvedValue(series) },
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
		const result = await refreshJellyfinEpisodeCache(state.client, state.prisma, "jellyfin-1", log);

		expect(result).toMatchObject({ upserted: 1, errors: 0, complete: true });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "jellyfin-1" },
		});
		expect(state.published).toEqual([
			expect.objectContaining({
				instanceId: "jellyfin-1",
				showTmdbId: 42,
				watched: true,
				watchedByUsers: JSON.stringify(["Alice"]),
			}),
		]);
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
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

		const result = await refreshJellyfinEpisodeCache(state.client, state.prisma, "jellyfin-1", log);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("does not evict prior evidence when user discovery is empty", async () => {
		const state = fixture();
		(state.client.getUsers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

		const result = await refreshJellyfinEpisodeCache(state.client, state.prisma, "jellyfin-1", log);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects a truncated series inventory without publishing any rows", async () => {
		const series = Array.from({ length: JELLYFIN_EPISODE_MAX_SERIES + 1 }, (_, index) => ({
			tmdbId: index + 1,
			jellyfinId: `series-${index + 1}`,
			title: `Show ${index + 1}`,
		}));
		const state = fixture(series);

		const result = await refreshJellyfinEpisodeCache(state.client, state.prisma, "jellyfin-1", log);

		expect(result).toEqual({ upserted: 0, errors: 1, complete: false });
		expect(state.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("publishes an empty complete inventory to evict stale rows", async () => {
		const state = fixture([]);
		const result = await refreshJellyfinEpisodeCache(state.client, state.prisma, "jellyfin-1", log);

		expect(result).toMatchObject({ upserted: 0, errors: 0, complete: true });
		expect(state.tx.jellyfinEpisodeCache.deleteMany).toHaveBeenCalledOnce();
		expect(state.tx.jellyfinEpisodeCache.createMany).not.toHaveBeenCalled();
		expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});
});
