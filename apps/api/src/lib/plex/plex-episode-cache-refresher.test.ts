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

	it("preserves cached aggregate watches omitted by bounded successful history", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const existingLastWatchedAt = new Date("2025-01-02T03:04:05.000Z");
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([
					{
						showTmdbId: 123,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						sourceFingerprint: "connection-fingerprint",
						watched: true,
						watchedByUsers: JSON.stringify(["Shared Viewer"]),
						lastWatchedAt: existingLastWatchedAt,
					},
				]),
				upsert,
			},
		};
		const history = Array.from({ length: 5000 }, (_, index) => ({
			type: "episode",
			ratingKey: `newer-episode-${index}`,
			accountID: 1,
			viewedAt: 2_000_000_000 + index,
		}));
		const client = {
			getHistory: vi.fn().mockResolvedValue(history),
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Older shared watch",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 1, errors: 0 });
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					watched: true,
					watchedByUsers: JSON.stringify(["Shared Viewer"]),
					lastWatchedAt: existingLastWatchedAt,
					watchCount: 0,
				}),
			}),
		);
	});

	it("preserves resolved usernames when Plex account lookup fails", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([
					{
						showTmdbId: 123,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						sourceFingerprint: "connection-fingerprint",
						watched: true,
						watchedByUsers: JSON.stringify(["Real Viewer"]),
						lastWatchedAt: new Date("2025-01-02T03:04:05.000Z"),
					},
				]),
				upsert,
			},
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([
				{ type: "episode", ratingKey: "episode-1", accountID: 7, viewedAt: 300 },
			]),
			getAccounts: vi.fn().mockRejectedValue(new Error("accounts unavailable")),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Attributed previously",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 1, errors: 1 });
		const call = upsert.mock.calls[0]?.[0];
		expect(JSON.parse(call.update.watchedByUsers)).toEqual(["Real Viewer"]);
		expect(call.update.watchedByUsers).not.toContain("Account 7");
	});

	it("creates aggregate evidence without user attribution when account lookup is unavailable", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([]),
				upsert,
			},
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([
				{ type: "episode", ratingKey: "episode-1", accountID: 7, viewedAt: 300 },
			]),
			getAccounts: vi.fn().mockRejectedValue(new Error("accounts unavailable")),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "No resolved account",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 1, errors: 1 });
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					watched: true,
					watchedByUsers: JSON.stringify([]),
				}),
			}),
		);
	});

	it("keeps the episode denominator complete when history references a removed account", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([]),
				upsert,
			},
		};
		const client = {
			getHistory: vi.fn().mockResolvedValue([
				{ type: "episode", ratingKey: "episode-1", accountID: 7, viewedAt: 300 },
				{ type: "episode", ratingKey: "episode-2", accountID: 1, viewedAt: 301 },
			]),
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Removed account watch",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
				{
					ratingKey: "episode-2",
					title: "Resolved owner watch",
					seasonNumber: 1,
					episodeNumber: 2,
					viewCount: 0,
				},
				{
					ratingKey: "episode-3",
					title: "Unwatched sibling",
					seasonNumber: 1,
					episodeNumber: 3,
					viewCount: 0,
				},
			]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 3, errors: 0 });
		expect(upsert).toHaveBeenCalledTimes(3);
		expect(upsert.mock.calls.map(([call]) => call.create)).toEqual([
			expect.objectContaining({
				ratingKey: "episode-1",
				watched: true,
				watchedByUsers: JSON.stringify([]),
			}),
			expect.objectContaining({
				ratingKey: "episode-2",
				watched: true,
				watchedByUsers: JSON.stringify(["Owner"]),
			}),
			expect.objectContaining({
				ratingKey: "episode-3",
				watched: false,
				watchedByUsers: JSON.stringify([]),
			}),
		]);
	});

	it("refreshes authoritative metadata when history attribution is unavailable", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([
					{
						showTmdbId: 123,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						sourceFingerprint: "connection-fingerprint",
					},
				]),
				updateMany,
				upsert,
			},
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
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				instanceId: "plex-1",
				showTmdbId: 123,
				seasonNumber: 1,
				episodeNumber: 1,
				ratingKey: "episode-1",
				sourceFingerprint: "connection-fingerprint",
			},
			data: expect.objectContaining({
				watchCount: 2,
				watched: true,
				lastWatchedAt: new Date(1_700_000_000 * 1000),
			}),
		});
		expect(updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("watchedByUsers");
		expect(upsert).not.toHaveBeenCalled();
		expect(client.getAccounts).not.toHaveBeenCalled();
	});

	it("preserves existing shared watch state when history and account metadata are unavailable", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue([
					{
						showTmdbId: 123,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						sourceFingerprint: "connection-fingerprint",
					},
				]),
				updateMany,
				upsert,
			},
		};
		const client = {
			getHistory: vi.fn().mockRejectedValue(new Error("history unavailable")),
			getAccounts: vi.fn(),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Shared history only",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};

		await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		const call = updateMany.mock.calls[0]?.[0];
		expect(call.data).toMatchObject({
			ratingKey: "episode-1",
			watchCount: 0,
			sourceFingerprint: "connection-fingerprint",
		});
		expect(call.data).not.toHaveProperty("watched");
		expect(call.data).not.toHaveProperty("watchedByUsers");
		expect(call.data).not.toHaveProperty("lastWatchedAt");
		expect(upsert).not.toHaveBeenCalled();
	});

	it.each([
		["no cached row exists", []],
		[
			"a changed Plex rating key",
			[
				{
					showTmdbId: 123,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "old-episode",
					sourceFingerprint: "connection-fingerprint",
				},
			],
		],
		[
			"a changed connection fingerprint",
			[
				{
					showTmdbId: 123,
					seasonNumber: 1,
					episodeNumber: 1,
					ratingKey: "episode-1",
					sourceFingerprint: "old-connection-fingerprint",
				},
			],
		],
	])("does not create or rebind aggregate watch state when %s", async (_, existingEpisodes) => {
		const upsert = vi.fn().mockResolvedValue({});
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			plexCache: {
				findMany: vi.fn().mockResolvedValue([{ tmdbId: 123, ratingKey: "show-1" }]),
			},
			plexEpisodeCache: {
				groupBy: vi.fn().mockResolvedValue([]),
				findMany: vi.fn().mockResolvedValue(existingEpisodes),
				updateMany,
				upsert,
			},
		};
		const client = {
			getHistory: vi.fn().mockRejectedValue(new Error("history unavailable")),
			getAccounts: vi.fn(),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Current identity",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 0,
				},
			]),
		};

		const result = await refreshPlexEpisodeCache(
			client as never,
			prisma as never,
			"plex-1",
			{ debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
			"connection-fingerprint",
		);

		expect(result).toMatchObject({ upserted: 0, errors: 1, refreshedShows: 1 });
		expect(updateMany).not.toHaveBeenCalled();
		expect(upsert).not.toHaveBeenCalled();
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
