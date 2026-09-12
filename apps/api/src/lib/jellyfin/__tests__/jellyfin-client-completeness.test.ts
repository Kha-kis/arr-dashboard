import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const logMock = { warn: vi.fn() };
const log = logMock as unknown as FastifyBaseLogger;

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function episode(index: number) {
	return {
		Id: `episode-${index}`,
		Name: `Episode ${index}`,
		Type: "Episode",
		IndexNumber: index,
		ParentIndexNumber: 1,
	};
}

function strictEpisode(overrides: Record<string, unknown> = {}) {
	return {
		...episode(1),
		SeriesId: "series-1",
		UserData: { Played: true, PlayCount: 1, LastPlayedDate: null },
		...overrides,
	};
}

function movie(index: number) {
	return {
		Id: `movie-${index}`,
		Name: `Movie ${index}`,
		Type: "Movie",
		ProviderIds: { Tmdb: String(index) },
	};
}

type JellyfinCoverageResult = {
	items: unknown[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
};

type JellyfinCoverageClient = JellyfinClient & {
	getLibraryItemsWithCoverage: (
		userId: string,
		libraryId: string,
		options?: { includeItemTypes?: string },
	) => Promise<JellyfinCoverageResult>;
};

async function getLibraryItemsWithCoverage(
	client: JellyfinClient,
	userId: string,
	libraryId: string,
): Promise<JellyfinCoverageResult> {
	const coverageClient = client as JellyfinCoverageClient;
	// Keep a missing future boundary a precise RED assertion instead of a
	// TypeError that would obscure the intended pagination contract.
	expect(coverageClient.getLibraryItemsWithCoverage).toEqual(expect.any(Function));
	return await coverageClient.getLibraryItemsWithCoverage(userId, libraryId, {
		includeItemTypes: "Movie,Series",
	});
}

describe("JellyfinClient authoritative inventory completeness", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("rejects a truncated library inventory instead of treating it as complete", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [{ Id: "library-1", Name: "Movies", Type: "CollectionFolder" }],
					TotalRecordCount: 2,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getLibraries("user-1")).rejects.toThrow(/not returned completely/i);
	});

	it("paginates every episode before exposing the inventory", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => episode(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
			.mockResolvedValueOnce(response({ Items: [episode(1_001)], TotalRecordCount: 1_001 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getEpisodes("user-1", "series-1");

		expect(result).toHaveLength(1_001);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("StartIndex=0");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("StartIndex=1000");
	});

	it("requests one strict Episode page with its exact cursor and limit", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			response({
				Items: [
					{
						...episode(1),
						SeriesId: "series-1",
						UserData: { Played: true, PlayCount: 1, LastPlayedDate: null },
					},
				],
				StartIndex: 1_000,
				TotalRecordCount: 1_001,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 1_000);

		expect(result).toMatchObject({ startIndex: 1_000, totalRecordCount: 1_001 });
		expect(result.items).toEqual([
			expect.objectContaining({ id: "episode-1", seriesId: "series-1", played: true }),
		]);
		const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(requestUrl.pathname).toBe("/Users/user-1/Items");
		expect(requestUrl.searchParams.get("ParentId")).toBe("library-1");
		expect(requestUrl.searchParams.get("IncludeItemTypes")).toBe("Episode");
		expect(requestUrl.searchParams.get("Recursive")).toBe("true");
		expect(requestUrl.searchParams.get("EnableUserData")).toBe("true");
		expect(requestUrl.searchParams.get("Fields")).toContain("ProviderIds");
		expect(requestUrl.searchParams.get("StartIndex")).toBe("1000");
		expect(requestUrl.searchParams.get("Limit")).toBe("1000");
	});

	it("decodes only episode-authority fields when unrelated BaseItemDto fields are null", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [
						strictEpisode({
							Name: null,
							SeriesName: null,
							ProductionYear: null,
							DateCreated: null,
							PremiereDate: null,
							RunTimeTicks: null,
							ProviderIds: null,
							ImageTags: null,
							CollectionType: null,
						}),
					],
					StartIndex: 0,
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0),
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({
					id: "episode-1",
					name: "",
					seriesId: "series-1",
					played: true,
				}),
			],
		});
	});

	it.each([
		["absent", { Played: true }],
		["null", { Played: true, PlayCount: null }],
	] as const)("preserves an %s episode play count as unknown", async (_name, userData) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [strictEpisode({ UserData: userData })],
					StartIndex: 0,
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0),
		).resolves.toMatchObject({
			items: [expect.objectContaining({ playCount: null })],
		});
	});

	it.each(["2026-09-07T12:00:00Z", "2026-09-07T07:00:00-05:00", "2026-09-07T12:00:00.1234567Z"])(
		"accepts a finite Jellyfin timestamp spelling: %s",
		async (lastPlayedDate) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					response({
						Items: [
							{
								...episode(1),
								SeriesId: "series-1",
								UserData: { Played: true, LastPlayedDate: lastPlayedDate },
							},
						],
						StartIndex: 0,
						TotalRecordCount: 1,
					}),
				),
			);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
			await expect(
				client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0),
			).resolves.toMatchObject({
				items: [expect.objectContaining({ lastPlayedDate })],
			});
		},
	);

	it("rejects an invalid Episode timestamp before exposing the page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [
						{
							...episode(1),
							SeriesId: "series-1",
							UserData: { Played: true, LastPlayedDate: "not-a-date" },
						},
					],
					StartIndex: 0,
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
		await expect(client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0)).rejects.toThrow(
			/rows are inconsistent/i,
		);
	});

	it.each([
		["blank item id", { Id: "" }],
		["whitespace item id", { Id: "   " }],
		["negative season coordinate", { ParentIndexNumber: -1 }],
		["fractional episode coordinate", { IndexNumber: 1.5 }],
		["unsafe episode coordinate", { IndexNumber: Number.MAX_SAFE_INTEGER + 1 }],
		["missing played state", { UserData: { PlayCount: 1 } }],
		["negative play count", { UserData: { Played: true, PlayCount: -1 } }],
		["fractional play count", { UserData: { Played: true, PlayCount: 1.5 } }],
		["unsafe play count", { UserData: { Played: true, PlayCount: Number.MAX_SAFE_INTEGER + 1 } }],
		["non-Episode item", { Type: "Movie" }],
	] as const)("rejects a strict Episode page with %s", async (_name, overrides) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [strictEpisode(overrides)],
					StartIndex: 0,
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0)).rejects.toThrow(
			/inconsistent/i,
		);
	});

	it.each([
		{ SeriesId: undefined, ParentIndexNumber: undefined, IndexNumber: undefined },
		{ SeriesId: null },
		{ SeriesId: "   " },
		{ ParentIndexNumber: null },
		{ IndexNumber: undefined },
	])(
		"retains raw pagination and explicitly excludes missing episode metadata: %j",
		async (missing) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					response({
						Items: [strictEpisode(), strictEpisode({ Id: "unmapped", ...missing })],
						StartIndex: 86000,
						TotalRecordCount: 86002,
					}),
				),
			);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
			const result = await client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 86000);
			expect(result).toMatchObject({ startIndex: 86000, totalRecordCount: 86002 });
			expect(result.items).toEqual([
				expect.objectContaining({ id: "episode-1", seriesId: "series-1", played: true }),
				{ id: "unmapped", type: "Episode", excludedReason: "missing-episode-metadata" },
			]);
		},
	);

	it.each([
		["a response cursor mismatch", { StartIndex: 1, TotalRecordCount: 1 }],
		["a fractional response cursor", { StartIndex: 0.5, TotalRecordCount: 1 }],
		["a negative total", { StartIndex: 0, TotalRecordCount: -1 }],
		["a fractional total", { StartIndex: 0, TotalRecordCount: 1.5 }],
		["an unsafe total", { StartIndex: 0, TotalRecordCount: Number.MAX_SAFE_INTEGER + 1 }],
		["a total above the safety bound", { StartIndex: 0, TotalRecordCount: 100_001 }],
	] as const)("rejects strict Episode coverage with %s", async (_name, coverage) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ Items: [], ...coverage })));
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0)).rejects.toThrow(
			/coverage is inconsistent|safe 100000-row limit/i,
		);
	});

	it("rejects duplicate identities within one strict Episode page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [strictEpisode(), strictEpisode({ IndexNumber: 2 })],
					StartIndex: 0,
					TotalRecordCount: 2,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodeItemsPageWithCoverage("user-1", "library-1", 0)).rejects.toThrow(
			/rows are inconsistent/i,
		);
	});

	it.each([
		[-1, 1_000],
		[0.5, 1_000],
		[0, 0],
		[0, 1_001],
		[0, 1.5],
	] as const)("rejects invalid requested page bounds before network I/O", async (start, limit) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			client.getEpisodeItemsPageWithCoverage("user-1", "library-1", start, limit),
		).rejects.toThrow(/is invalid/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns mapped episodes with frozen multi-page coverage accounting", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => episode(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
			.mockResolvedValueOnce(response({ Items: [episode(1_001)], TotalRecordCount: 1_001 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodesWithCoverage("user-1", "series-1")).resolves.toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({ id: "episode-1", episodeNumber: 1, seasonNumber: 1 }),
			]),
			expectedRawCount: 1_001,
			pagesAttempted: 2,
			pagesCompleted: 2,
			rawObserved: 1_001,
			reason: null,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["early-empty", "repeated-page", "duplicate-item"] as const)(
		"returns no partial episodes for %s coverage failure",
		async (failure) => {
			const firstPage = Array.from({ length: 1_000 }, (_, index) => episode(index + 1));
			const secondPage =
				failure === "early-empty" ? [] : failure === "repeated-page" ? firstPage : [episode(1_000)];
			const total = failure === "repeated-page" ? 2_000 : 1_001;
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: total }))
				.mockResolvedValueOnce(response({ Items: secondPage, TotalRecordCount: total }));
			vi.stubGlobal("fetch", fetchMock);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

			await expect(client.getEpisodesWithCoverage("user-1", "series-1")).resolves.toMatchObject({
				items: [],
				expectedRawCount: total,
				pagesAttempted: 2,
				pagesCompleted: 1,
				rawObserved: 1_000,
				reason: "page-failure",
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
	);

	it("reports complete-result counters for the frozen library inventory", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					Items: Array.from({ length: 1_000 }, (_, index) => movie(index + 1)),
					TotalRecordCount: 1_001,
				}),
			)
			.mockResolvedValueOnce(response({ Items: [movie(1_001)], TotalRecordCount: 1_001 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(getLibraryItemsWithCoverage(client, "user-1", "library-1")).resolves.toMatchObject(
			{
				items: expect.arrayContaining([expect.objectContaining({ id: "movie-1" })]),
				expectedRawCount: 1_001,
				pagesAttempted: 2,
				pagesCompleted: 2,
				rawObserved: 1_001,
				reason: null,
			},
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns bounded counters without exposing a repeated whole page", async () => {
		const repeatedPage = Array.from({ length: 1_000 }, (_, index) => movie(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: repeatedPage, TotalRecordCount: 2_000 }))
			.mockResolvedValueOnce(response({ Items: repeatedPage, TotalRecordCount: 2_000 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(getLibraryItemsWithCoverage(client, "user-1", "library-1")).resolves.toMatchObject(
			{
				items: [],
				expectedRawCount: 2_000,
				pagesAttempted: 2,
				pagesCompleted: 1,
				rawObserved: 1_000,
				reason: "page-failure",
			},
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("StartIndex=1000");
	});

	it.each([
		["shrinks", 1_000],
		["grows", 1_002],
	] as const)("returns no partial items when the frozen total %s", async (_name, changedTotal) => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => movie(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
			.mockResolvedValueOnce(response({ Items: [movie(1_001)], TotalRecordCount: changedTotal }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(getLibraryItemsWithCoverage(client, "user-1", "library-1")).resolves.toEqual({
			items: [],
			expectedRawCount: 1_001,
			pagesAttempted: 2,
			pagesCompleted: 1,
			rawObserved: 1_000,
			reason: "page-failure",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("accepts the 100,000-row bound before reporting an empty intermediate page", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => movie(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 100_000 }))
			.mockResolvedValueOnce(response({ Items: [], TotalRecordCount: 100_000 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(getLibraryItemsWithCoverage(client, "user-1", "library-1")).resolves.toEqual({
			items: [],
			expectedRawCount: 100_000,
			pagesAttempted: 2,
			pagesCompleted: 1,
			rawObserved: 1_000,
			reason: "page-failure",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("traverses exactly 100,000 rows successfully within the safety bound", async () => {
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const start = Number(new URL(String(input)).searchParams.get("StartIndex"));
			const items = Array.from({ length: Math.min(1_000, 100_000 - start) }, (_, index) =>
				movie(start + index + 1),
			);
			return Promise.resolve(response({ Items: items, TotalRecordCount: 100_000 }));
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await getLibraryItemsWithCoverage(client, "user-1", "library-1");

		expect(result).toMatchObject({
			items: expect.any(Array),
			expectedRawCount: 100_000,
			pagesAttempted: 100,
			pagesCompleted: 100,
			rawObserved: 100_000,
			reason: null,
		});
		expect(result.items).toHaveLength(100_000);
		expect(fetchMock).toHaveBeenCalledTimes(100);
	});

	it("hides items and preserves counters when a later page request throws", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => movie(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
			.mockRejectedValueOnce(new Error("private upstream path /Users/user-secret/Items"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			getLibraryItemsWithCoverage(client, "user-secret", "library-secret"),
		).resolves.toEqual({
			items: [],
			expectedRawCount: 1_001,
			pagesAttempted: 2,
			pagesCompleted: 1,
			rawObserved: 1_000,
			reason: "page-failure",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
				.mockRejectedValueOnce(new Error("private upstream path /Users/user-secret/Items")),
		);
		await expect(client.getLibraryItems("user-secret", "library-secret")).rejects.toThrow(
			/Jellyfin item page request failed/,
		);
	});

	it("sanitizes dynamic paths and raw upstream failures in client diagnostics", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("private /Users/user-secret/Items")),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			client.getLibraryItemsWithCoverage("user-secret", "library-secret"),
		).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("user-secret");
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("library-secret");
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("private");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response("private response", { status: 503, statusText: "private status" }),
				),
		);
		await expect(
			client.getLibraryItemsWithCoverage("user-secret", "library-secret"),
		).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("user-secret");
		expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain("private status");
	});

	it("rejects duplicate rows across episode pages", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) => episode(index + 1));
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
				.mockResolvedValueOnce(response({ Items: [episode(1_000)], TotalRecordCount: 1_001 })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodes("user-1", "series-1")).rejects.toThrow(/duplicate item/i);
	});

	it("rejects an episode inventory above the bounded safety limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response({ Items: [], TotalRecordCount: 100_001 })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getEpisodes("user-1", "series-1")).rejects.toThrow(
			/safe 100000-row limit/i,
		);
	});

	it("preserves BoxSet rows while paginating the complete filtered library inventory", async () => {
		const firstPage = [
			...Array.from({ length: 999 }, (_, index) => movie(index + 1)),
			{ Id: "boxset-1", Name: "Favorites", Type: "BoxSet" },
		];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: firstPage, TotalRecordCount: 1_001 }))
			.mockResolvedValueOnce(response({ Items: [movie(1_000)], TotalRecordCount: 1_001 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getLibraryItems("user-1", "library-1", {
			includeItemTypes: "Movie,Series",
		});

		expect(result).toHaveLength(1_001);
		expect(result[999]).toMatchObject({ id: "boxset-1", type: "BoxSet", tmdbId: undefined });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			expect(String(call[0])).toContain("IncludeItemTypes=Movie%2CSeries");
			expect(String(call[0])).toContain("CollapseBoxSetItems=false");
		}
	});

	it("rejects a malformed library item before exposing a partial inventory", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [movie(1), { Id: "malformed-1", Name: "Missing type" }],
					TotalRecordCount: 2,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(
			client.getLibraryItems("user-1", "library-1", { includeItemTypes: "Movie" }),
		).rejects.toThrow(/Jellyfin item page request failed/i);
	});
});
