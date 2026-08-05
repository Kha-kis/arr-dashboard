import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

const log = { warn: vi.fn() } as never;

function response(MediaContainer: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ MediaContainer }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function libraryItem(index: number) {
	return {
		ratingKey: `item-${index}`,
		title: `Movie ${index}`,
		type: "movie",
		Guid: [{ id: `tmdb://${index}` }],
	};
}

describe("PlexClient authoritative inventory completeness", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("paginates every library item before exposing the inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => libraryItem(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: [libraryItem(201)] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const items = await client.getLibraryItems("movies");

		expect(items).toHaveLength(201);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(secondUrl.searchParams.get("X-Plex-Container-Start")).toBe("200");
	});

	it("rejects a library page that stops before its declared total", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 1, totalSize: 2, Metadata: [libraryItem(1)] }),
			)
			.mockResolvedValueOnce(response({ offset: 1, size: 0, totalSize: 2, Metadata: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItems("movies")).rejects.toThrow(/stopped before/i);
	});

	it("rejects capped history instead of exposing a partial watch inventory", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					offset: 0,
					size: 1,
					totalSize: 100_001,
					Metadata: [
						{
							ratingKey: "movie-1",
							title: "Movie",
							type: "movie",
							viewedAt: 1_700_000_000,
							accountID: 1,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getHistory({ maxResults: 100_000, requireComplete: true })).rejects.toThrow(
			/exceeding the safe 100000-row limit/i,
		);
	});

	it("rejects a repeated history page instead of exposing an incomplete watch inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 400, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 400, Metadata: firstPage }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getHistory({ maxResults: 100_000, requireComplete: true })).rejects.toThrow(
			/duplicate row while paging/i,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("accepts distinct same-second plays and verifies the newest page before publishing", async () => {
		const history = Array.from({ length: 201 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: "movie-1",
			title: "Movie",
			type: "movie",
			viewedAt: 1_700_000_000,
			accountID: 1,
		}));
		const reordered = [...history].reverse();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: history.slice(200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: reordered.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: reordered.slice(200) }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(snapshot).toHaveLength(201);
		await expect(client.verifyHistorySnapshot(snapshot)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("rejects equal-count history churn detected by the newest-page verification", async () => {
		const initial = Array.from({ length: 200 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const changed = [
			{
				historyKey: "/status/sessions/history/new",
				ratingKey: "movie-new",
				title: "New Movie",
				type: "movie",
				viewedAt: 1_800_000_000,
				accountID: 1,
			},
			...initial.slice(0, 199),
		];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({ offset: 0, size: 200, totalSize: 200, Metadata: initial }),
				)
				.mockResolvedValueOnce(
					response({ offset: 0, size: 200, totalSize: 200, Metadata: changed }),
				),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		await expect(client.verifyHistorySnapshot(snapshot)).rejects.toThrow(
			/changed before.*snapshot/i,
		);
	});

	it("rejects equal-count churn in a middle page during complete verification", async () => {
		const history = Array.from({ length: 401 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const changedMiddle = history.slice(200, 400).map((item) => ({ ...item }));
		changedMiddle[50] = { ...changedMiddle[50]!, accountID: 2 };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 401, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 401, Metadata: history.slice(200, 400) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 400, size: 1, totalSize: 401, Metadata: history.slice(400) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 401, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 401, Metadata: changedMiddle }),
			)
			.mockResolvedValueOnce(
				response({ offset: 400, size: 1, totalSize: 401, Metadata: history.slice(400) }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		await expect(client.verifyHistorySnapshot(snapshot)).rejects.toThrow(
			/changed before.*snapshot/i,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("accepts endpoint-specific account and section inventories that publish size only", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, Directory: [{ key: "1", title: "Movies", type: "movie" }] }),
			)
			.mockResolvedValueOnce(response({ size: 1, Account: [{ id: 1, name: "Admin" }] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).resolves.toHaveLength(1);
		await expect(client.getAccounts()).resolves.toEqual([{ id: 1, name: "Admin" }]);
	});

	it("rejects inconsistent optional pagination metadata on sections and accounts", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, offset: 1, Directory: [{ key: "1", type: "movie" }] }),
			)
			.mockResolvedValueOnce(
				response({ size: 1, totalSize: 2, Account: [{ id: 1, name: "Admin" }] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).rejects.toThrow(/complete single-page/i);
		await expect(client.getAccounts()).rejects.toThrow(/complete single-page/i);
	});

	it("paginates allLeaves and rejects duplicate episode coordinates", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => ({
			ratingKey: `episode-${index + 1}`,
			title: `Episode ${index + 1}`,
			parentIndex: 1,
			index: index + 1,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({
					offset: 200,
					size: 1,
					totalSize: 201,
					Metadata: [{ ratingKey: "episode-201", title: "Duplicate", parentIndex: 1, index: 200 }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getEpisodes("show-1")).rejects.toThrow(/duplicate episode coordinate/i);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects duplicate rating keys and truncated allLeaves pages", async () => {
		const client = new PlexClient("http://plex.test", "token", log);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({
						offset: 0,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 1 }],
					}),
				)
				.mockResolvedValueOnce(
					response({
						offset: 1,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 2 }],
					}),
				),
		);
		await expect(client.getEpisodes("show-1")).rejects.toThrow(/duplicate item/i);

		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({
						offset: 0,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 1 }],
					}),
				)
				.mockResolvedValueOnce(response({ offset: 1, size: 0, totalSize: 2, Metadata: [] })),
		);
		await expect(client.getEpisodes("show-1")).rejects.toThrow(/stopped before/i);
	});
});
