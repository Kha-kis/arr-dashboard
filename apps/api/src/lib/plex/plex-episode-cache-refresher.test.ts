import { describe, expect, it, vi } from "vitest";
import { refreshPlexEpisodeCache } from "./plex-episode-cache-refresher.js";

describe("refreshPlexEpisodeCache watch count", () => {
	it("keeps shared history in watched while using account metadata for watchCount", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: { groupBy: vi.fn().mockResolvedValue([]), upsert },
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([
				{ type: "episode", ratingKey: "episode-1", accountID: 1, viewedAt: 100 },
				{ type: "episode", ratingKey: "episode-1", accountID: 1, viewedAt: 200 },
				{ type: "episode", ratingKey: "episode-2", accountID: 1, viewedAt: 300 },
			]),
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Viewer" }]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "History wins",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
				{
					ratingKey: "episode-2",
					title: "View count wins",
					seasonNumber: 1,
					episodeNumber: 2,
					viewCount: 4,
				},
			]),
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			log as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 2, errors: 0 });
		expect(upsert).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				create: expect.objectContaining({
					watchCount: 0,
					watched: true,
					watchedByUsers: JSON.stringify(["Viewer"]),
					lastWatchedAt: new Date(200 * 1000),
					sourceFingerprint: "connection-fingerprint",
				}),
				update: expect.objectContaining({
					watchCount: 0,
					watched: true,
					watchedByUsers: JSON.stringify(["Viewer"]),
					lastWatchedAt: new Date(200 * 1000),
					sourceFingerprint: "connection-fingerprint",
				}),
			}),
		);
		expect(upsert).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				create: expect.objectContaining({ watchCount: 4, watched: true }),
				update: expect.objectContaining({ watchCount: 4, watched: true }),
			}),
		);
		const firstCall = upsert.mock.calls[0]?.[0];
		expect(firstCall.create.refreshedAt).toBeInstanceOf(Date);
		expect(firstCall.update.refreshedAt).toEqual(firstCall.create.refreshedAt);
	});

	it("refreshes authoritative metadata when history attribution is unavailable", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: { groupBy: vi.fn().mockResolvedValue([]), upsert },
		};
		const client = {
			getHistory: vi.fn().mockRejectedValue(new Error("history unavailable")),
			getAccounts: vi.fn(),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Current metadata",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 2,
					lastViewedAt: 1_700_000_000,
				},
			]),
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			log as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 1, errors: 1, refreshedShows: 1 });
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					watchCount: 2,
					watched: true,
					watchedByUsers: "[]",
					lastWatchedAt: new Date(1_700_000_000 * 1000),
				}),
			}),
		);
		expect(client.getAccounts).not.toHaveBeenCalled();
	});

	it("records a refreshed zero without treating it as a positive witness", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: { groupBy: vi.fn().mockResolvedValue([]), upsert },
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([]),
			getAccounts: vi.fn().mockResolvedValue([]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Unwatched",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};

		await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			log as never,
			"connection-fingerprint",
		);

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ watchCount: 0, watched: false }),
				update: expect.objectContaining({ watchCount: 0, watched: false }),
			}),
		);
	});

	it("rotates a bounded batch toward never-refreshed shows for eventual coverage", async () => {
		const shows = Array.from({ length: 51 }, (_, index) => ({
			tmdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const recentlyRefreshed = new Date("2026-07-30T12:00:00.000Z");
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue(shows),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue(
					shows.slice(0, 50).map((show) => ({
						showTmdbId: show.tmdbId,
						_max: { refreshedAt: recentlyRefreshed },
					})),
				),
				upsert: vi.fn().mockResolvedValue({}),
			},
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([]),
			getAccounts: vi.fn().mockResolvedValue([]),
			getEpisodes: vi.fn().mockResolvedValue([]),
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			log as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({
			eligibleShows: 51,
			refreshedShows: 50,
			coverageIncomplete: true,
		});
		expect(client.getEpisodes).toHaveBeenCalledTimes(50);
		expect(client.getEpisodes).toHaveBeenCalledWith("show-51");
		expect(prisma.plexEpisodeCache.groupBy).toHaveBeenCalledWith({
			by: ["showTmdbId"],
			where: {
				instanceId: "plex-1",
				showTmdbId: { in: shows.map((show) => show.tmdbId) },
			},
			_max: { refreshedAt: true },
		});
	});

	it("marks capacity degraded when a 6-hour cycle cannot keep evidence under 24 hours", async () => {
		const shows = Array.from({ length: 201 }, (_, index) => ({
			tmdbId: index + 1,
			ratingKey: `show-${index + 1}`,
		}));
		const prisma = {
			plexCache: { findMany: vi.fn().mockResolvedValue(shows) },
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				upsert: vi.fn().mockResolvedValue({}),
			},
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([]),
			getAccounts: vi.fn().mockResolvedValue([]),
			getEpisodes: vi.fn().mockResolvedValue([]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({
			eligibleShows: 201,
			refreshedShows: 50,
			coverageIncomplete: true,
			capacityDegraded: true,
		});
	});
});
