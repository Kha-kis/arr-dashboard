import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";
import { classifyPlexHistoryFailure } from "../plex-collection-diagnostics.js";

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

function historyItem(index: number) {
	return {
		historyKey: `/status/sessions/history/${index}`,
		ratingKey: `movie-${index}`,
		title: `Movie ${index}`,
		type: "movie",
		viewedAt: 1_700_000_000,
		accountID: 1,
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
			)
			.mockResolvedValueOnce(response({ size: 50, Metadata: firstPage.slice(0, 50) }))
			.mockResolvedValueOnce(response({ size: 50, Metadata: firstPage.slice(50, 100) }))
			.mockResolvedValueOnce(response({ size: 50, Metadata: firstPage.slice(100, 150) }))
			.mockResolvedValueOnce(response({ size: 50, Metadata: firstPage.slice(150, 200) }))
			.mockResolvedValueOnce(response({ size: 1, Metadata: [libraryItem(201)] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const items = await client.getLibraryItems("movies");

		expect(items).toHaveLength(201);
		expect(fetchMock).toHaveBeenCalledTimes(7);
		const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(secondUrl.searchParams.get("X-Plex-Container-Start")).toBe("200");
	});

	it("keeps authoritative metadata hydration within a transport-safe key budget", async () => {
		const items = Array.from({ length: 201 }, (_, index) => libraryItem(index + 1));
		const metadataBatchSizes: number[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.pathname.includes("/library/sections/")) {
				const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
				const page = items.slice(start, start + 200);
				return response({
					offset: start,
					size: page.length,
					totalSize: items.length,
					Metadata: page,
				});
			}
			const keys = url.pathname.replace("/library/metadata/", "").split(",");
			metadataBatchSizes.push(keys.length);
			if (keys.length > 50) return new Response(null, { status: 414 });
			return response({
				size: keys.length,
				Metadata: keys.map((key) => libraryItem(Number(key.replace("item-", "")))),
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ ratingKey: "item-201" })]),
			expectedRawCount: 201,
			rawObserved: 201,
			reason: null,
		});
		expect(metadataBatchSizes).toEqual([50, 50, 50, 50, 1]);
	});

	it("enriches complete section rows with item-level labels and collections", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 1, totalSize: 1, Metadata: [libraryItem(1)] }),
			)
			.mockResolvedValueOnce(
				response({
					size: 1,
					Metadata: [
						{
							...libraryItem(1),
							Label: [{ tag: "Family" }],
							Collection: [{ tag: "Classics" }],
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItems("movies")).resolves.toEqual([
			expect.objectContaining({
				ratingKey: "item-1",
				Label: [{ tag: "Family" }],
				Collection: [{ tag: "Classics" }],
			}),
		]);
		const metadataUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(metadataUrl.pathname).toBe("/library/metadata/item-1");
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

	it("exposes declared totals and page counters for a complete library inventory", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 2, totalSize: 2, Metadata: [libraryItem(1), libraryItem(2)] }),
			)
			.mockResolvedValueOnce(
				response({
					size: 2,
					Metadata: [libraryItem(1), libraryItem(2)],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: [
				expect.objectContaining({ ratingKey: "item-1" }),
				expect.objectContaining({ ratingKey: "item-2" }),
			],
			expectedRawCount: 2,
			rawObserved: 2,
			pagesAttempted: 1,
			pagesCompleted: 1,
			reason: null,
		});
	});

	it.each([
		[
			"repeated pages",
			[
				response({ offset: 0, size: 2, totalSize: 4, Metadata: [libraryItem(1), libraryItem(2)] }),
				response({ offset: 2, size: 2, totalSize: 4, Metadata: [libraryItem(1), libraryItem(2)] }),
			],
		],
		[
			"count shrink",
			[
				response({ offset: 0, size: 2, totalSize: 4, Metadata: [libraryItem(1), libraryItem(2)] }),
				response({ offset: 2, size: 1, totalSize: 3, Metadata: [libraryItem(3)] }),
			],
		],
		[
			"count growth",
			[
				response({ offset: 0, size: 2, totalSize: 4, Metadata: [libraryItem(1), libraryItem(2)] }),
				response({ offset: 2, size: 1, totalSize: 5, Metadata: [libraryItem(3)] }),
			],
		],
	] as const)("returns no partial items for %s", async (_name, responses) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(() => responses[0])
				.mockImplementationOnce(() => responses[1]),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		const result = await client.getLibraryItemsWithCoverage("movies");

		expect(result.items).toEqual([]);
		expect(result.expectedRawCount).toBe(4);
		expect(result.rawObserved).toBe(2);
		expect(result.pagesAttempted).toBe(responses.length > 1 ? 2 : 1);
		expect(result.pagesCompleted).toBe(1);
		expect(result.reason).toBe("page-failure");
		expect(JSON.stringify(result)).not.toMatch(/Movie|item-|token|http/i);
	});

	it("returns bounded counters when a page becomes empty before the declared total", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 2, totalSize: 4, Metadata: [libraryItem(1), libraryItem(2)] }),
			)
			.mockResolvedValueOnce(response({ offset: 2, size: 0, totalSize: 4, Metadata: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 4,
			rawObserved: 2,
			pagesAttempted: 2,
			pagesCompleted: 1,
			reason: "page-failure",
		});
	});

	it("redacts tag enrichment failures after complete pagination while preserving counters", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => libraryItem(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: [libraryItem(201)] }),
			)
			.mockRejectedValueOnce(new Error("private provider response text"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const result = await client.getLibraryItemsWithCoverage("movies");

		expect(result).toMatchObject({
			items: [],
			expectedRawCount: 201,
			pagesAttempted: 2,
			pagesCompleted: 2,
			rawObserved: 201,
			reason: "page-failure",
		});
		expect(JSON.stringify(result)).not.toContain("private provider response text");
	});

	it("fails closed when a metadata hydration batch omits a requested key", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 2, totalSize: 2, Metadata: [libraryItem(1), libraryItem(2)] }),
			)
			.mockResolvedValueOnce(response({ size: 1, Metadata: [libraryItem(1)] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 2,
			rawObserved: 2,
			reason: "page-failure",
		});
	});

	it("returns a bounded result when the provider exceeds the safe page cap", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					offset: 0,
					size: 1,
					totalSize: 100_001,
					Metadata: [libraryItem(1)],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 100_001,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 0,
			reason: "page-failure",
		});
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

	it("uses a Plex-compatible single sort key for complete history", async () => {
		const history = Array.from({ length: 201 }, (_, index) => historyItem(index));
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.searchParams.get("sort") !== "viewedAt:desc") {
				return new Response(null, { status: 400, statusText: "Bad Request" });
			}
			const offset = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
			const page = history.slice(offset, offset + 200);
			return response({ offset, size: page.length, totalSize: history.length, Metadata: page });
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = new PlexClient("http://plex.test", "token", log);
		await expect(
			client.getHistory({ maxResults: 100_000, requireComplete: true }),
		).resolves.toHaveLength(201);
		for (const [input] of fetchMock.mock.calls) {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			expect(url.searchParams.get("sort")).toBe("viewedAt:desc");
		}
	});

	it("rejects a repeated history page instead of exposing an incomplete watch inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000,
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

	it("classifies real history-total drift without returning the changed payload", async () => {
		const first = Array.from({ length: 200 }, (_, index) => historyItem(index));
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ offset: 0, size: 200, totalSize: 201, Metadata: first }))
				.mockResolvedValueOnce(
					response({ offset: 200, size: 1, totalSize: 202, Metadata: [historyItem(200)] }),
				),
		);
		const client = new PlexClient("http://plex.test", "token", log);
		const failure = await client
			.getHistory({ maxResults: 100_000, requireComplete: true })
			.catch((error: unknown) => error);
		expect(classifyPlexHistoryFailure(failure)).toBe("history-pagination-changed");
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
		const verification = client.verifyHistorySnapshot(snapshot);
		await expect(verification).rejects.toThrow(/changed before.*snapshot/i);
		await verification.catch((error: unknown) => {
			expect(classifyPlexHistoryFailure(error)).toBe("history-verification-changed");
		});
	});

	it("rejects a librarySectionID change between collection and verification", async () => {
		const base = {
			historyKey: "/status/sessions/history/1",
			ratingKey: "",
			title: "Home Video",
			type: "movie",
			viewedAt: 1_700_000_000,
			accountID: 1,
		};
		const initial = [{ ...base, librarySectionID: "personal-section" }];
		const changed = [{ ...base, librarySectionID: "supported-section" }];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ offset: 0, size: 1, totalSize: 1, Metadata: initial }))
				.mockResolvedValueOnce(response({ offset: 0, size: 1, totalSize: 1, Metadata: changed })),
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

	it("preserves the section agent through the wire mapping", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				size: 1,
				Directory: [
					{ key: "7", title: "Personal", type: "movie", agent: "com.plexapp.agents.none" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).resolves.toEqual([
			{ key: "7", title: "Personal", type: "movie", agent: "com.plexapp.agents.none" },
		]);
	});

	it("leaves an absent section agent undefined rather than defaulting it", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, Directory: [{ key: "1", title: "Movies", type: "movie" }] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const sections = await client.getLibrarySections();
		expect(sections[0]).toEqual({ key: "1", title: "Movies", type: "movie" });
		expect(sections[0]?.agent).toBeUndefined();
	});

	it("coerces a numeric librarySectionID to a string through getHistory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					{
						historyKey: "/status/sessions/history/1",
						ratingKey: "movie-1",
						title: "Movie",
						type: "movie",
						viewedAt: 1_700_000_000,
						accountID: 1,
						librarySectionID: 7,
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(history[0]?.librarySectionID).toBe("7");
	});

	it("leaves a missing librarySectionID undefined through getHistory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					{
						historyKey: "/status/sessions/history/1",
						ratingKey: "movie-1",
						title: "Movie",
						type: "movie",
						viewedAt: 1_700_000_000,
						accountID: 1,
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(history[0]?.librarySectionID).toBeUndefined();
	});

	it("returns the bounded live section settlement fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				response({
					size: 1,
					Directory: [
						{
							key: "1",
							uuid: "movie-section-uuid",
							title: "Movies",
							type: "movie",
							agent: "tv.plex.agents.movie",
							refreshing: "0",
							scannedAt: "1777000000",
							updatedAt: 1777000100,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySettlementSections()).resolves.toEqual([
			{
				key: "1",
				uuid: "movie-section-uuid",
				title: "Movies",
				type: "movie",
				agent: "tv.plex.agents.movie",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		]);
	});

	it("preserves an uninitialized section scannedAt as unavailable live state", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				response({
					size: 1,
					Directory: [
						{
							key: "6",
							uuid: "new-movie-section-uuid",
							title: "New Movies",
							type: "movie",
							refreshing: "1",
							updatedAt: 1_777_000_100,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySettlementSections()).resolves.toEqual([
			{
				key: "6",
				uuid: "new-movie-section-uuid",
				title: "New Movies",
				type: "movie",
				refreshing: true,
				scannedAt: null,
				updatedAt: 1_777_000_100,
			},
		]);
	});

	it("sends the Plex metadata type and locks a tag field before editing it", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await client.updateMetadataTags("123", "movie", "label", "add", "Family");

		const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(url.pathname).toBe("/library/metadata/123");
		expect(url.searchParams.get("type")).toBe("1");
		expect(url.searchParams.get("label.locked")).toBe("1");
		expect(url.searchParams.get("label[0].tag.tag")).toBe("Family");
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
	});

	it("loads a complete bounded activity inventory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				size: 2,
				Activity: [
					{ type: "library.update.section", Context: { librarySectionID: 1 } },
					{ type: "media.generate.bif" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getActivities()).resolves.toEqual([
			{ type: "library.update.section", Context: { librarySectionID: "1" } },
			{ type: "media.generate.bif" },
		]);
		expect(new URL(fetchMock.mock.calls[0]?.[0] as string).pathname).toBe("/activities");
	});

	it("fails closed when the activity inventory is malformed or incomplete", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ size: 1, Activity: [{ Context: {} }] }))
			.mockResolvedValueOnce(response({ size: 2, Activity: [{ type: "media.generate.bif" }] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getActivities()).rejects.toThrow();
		await expect(client.getActivities()).rejects.toThrow(/complete single-page/i);
	});

	it("shares only simultaneous ordinary activity reads and never completed results", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => response({ size: 0, Activity: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const [first, second] = await Promise.all([client.getActivities(), client.getActivities()]);
		expect(first).toEqual([]);
		expect(second).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await client.getActivities();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not coalesce uncached mutation probes", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => response({ size: 0, Activity: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await Promise.all([
			client.getActivities({ uncached: true }),
			client.getActivities({ uncached: true }),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
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
