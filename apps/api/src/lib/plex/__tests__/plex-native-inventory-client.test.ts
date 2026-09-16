import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

const log = { warn: vi.fn() } as never;

function response(MediaContainer: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ MediaContainer }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function episode(index: number, overrides: Record<string, unknown> = {}) {
	return {
		ratingKey: `episode-${index}`,
		type: "episode",
		title: `Episode ${index}`,
		grandparentRatingKey: "show-1",
		parentIndex: 1,
		index,
		...overrides,
	};
}

describe("PlexClient native episode inventory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("paginates a complete encoded section inventory and preserves native identity", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => episode(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: [episode(201)] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const result = await client.getNativeEpisodeItemsWithCoverage("owned/shows");

		expect(result).toMatchObject({
			expectedRawCount: 201,
			rawObserved: 201,
			pagesAttempted: 2,
			pagesCompleted: 2,
			reason: null,
		});
		expect(result.items).toHaveLength(201);
		expect(result.items[0]).toEqual({
			ratingKey: "episode-1",
			type: "episode",
			grandparentRatingKey: "show-1",
			seasonNumber: 1,
			episodeNumber: 1,
			title: "Episode 1",
		});
		expect(result.items[200]).toEqual(expect.objectContaining({ ratingKey: "episode-201" }));
		const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(firstUrl.pathname).toBe("/library/sections/owned%2Fshows/all");
		expect(firstUrl.searchParams.get("type")).toBe("4");
		expect(firstUrl.searchParams.get("X-Plex-Container-Start")).toBe("0");
		expect(firstUrl.searchParams.get("X-Plex-Container-Size")).toBe("200");
		const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(secondUrl.searchParams.get("X-Plex-Container-Start")).toBe("200");
	});

	it("accepts an empty complete section", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response({ offset: 0, size: 0, totalSize: 0, Metadata: [] })),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("shows")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 0,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
			reason: null,
		});
	});

	it("retains items when optional mapping and coordinates are missing or malformed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					offset: 0,
					size: 3,
					totalSize: 3,
					Metadata: [
						episode(1, {
							grandparentRatingKey: undefined,
							parentIndex: undefined,
							index: undefined,
						}),
						episode(2, {
							grandparentRatingKey: " \t",
							parentIndex: "unknown",
							index: null,
							title: 42,
						}),
						episode(3, { grandparentRatingKey: "\0", parentIndex: 0, index: 0 }),
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("shows")).resolves.toMatchObject({
			items: [
				{
					ratingKey: "episode-1",
					type: "episode",
					grandparentRatingKey: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Episode 1",
				},
				{
					ratingKey: "episode-2",
					type: "episode",
					grandparentRatingKey: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "",
				},
				{
					ratingKey: "episode-3",
					type: "episode",
					grandparentRatingKey: null,
					seasonNumber: 0,
					episodeNumber: 0,
					title: "Episode 3",
				},
			],
			reason: null,
		});
	});

	it("retains a valid zero episode coordinate at the request boundary", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					offset: 0,
					size: 1,
					totalSize: 1,
					Metadata: [episode(1, { parentIndex: 0, index: 0 })],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("shows")).resolves.toMatchObject({
			items: [
				{
					ratingKey: "episode-1",
					seasonNumber: 0,
					episodeNumber: 0,
				},
			],
			reason: null,
		});
	});

	it.each([
		["missing native ID", episode(1, { ratingKey: "" })],
		["whitespace native ID", episode(1, { ratingKey: "   " })],
		["NUL-containing native ID", episode(1, { ratingKey: "episode-\0-1" })],
		["wrong native type", episode(1, { type: "show" })],
	] as const)("rejects %s without exposing partial inventory", async (_name, item) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response({ offset: 0, size: 1, totalSize: 1, Metadata: [item] })),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("shows")).resolves.toMatchObject({
			items: [],
			expectedRawCount: null,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 0,
			reason: "page-failure",
		});
	});

	it.each([
		[
			"duplicate native IDs",
			[
				response({ offset: 0, size: 1, totalSize: 2, Metadata: [episode(1)] }),
				response({ offset: 1, size: 1, totalSize: 2, Metadata: [episode(1)] }),
			],
		],
		[
			"truncated pages",
			[
				response({ offset: 0, size: 1, totalSize: 2, Metadata: [episode(1)] }),
				response({ offset: 1, size: 0, totalSize: 2, Metadata: [] }),
			],
		],
		[
			"total drift",
			[
				response({ offset: 0, size: 1, totalSize: 2, Metadata: [episode(1)] }),
				response({ offset: 1, size: 1, totalSize: 3, Metadata: [episode(2)] }),
			],
		],
	] as const)("rejects %s without returning observed rows", async (_name, responses) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(() => responses[0])
				.mockImplementationOnce(() => responses[1]),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("shows")).resolves.toMatchObject({
			items: [],
			rawObserved: 1,
			reason: "page-failure",
		});
	});

	it("rejects provider page failures without exposing prior rows", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({ offset: 0, size: 1, totalSize: 2, Metadata: [episode(1)] }),
				)
				.mockRejectedValueOnce(new Error("private provider failure")),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		const result = await client.getNativeEpisodeItemsWithCoverage("shows");

		expect(result).toMatchObject({
			items: [],
			rawObserved: 1,
			pagesAttempted: 2,
			pagesCompleted: 1,
			reason: "page-failure",
		});
		expect(JSON.stringify(result)).not.toContain("private provider failure");
	});

	it("enumerates native movies, shows, and collection containers without enrichment calls", async () => {
		const nativeRows = [
			{
				ratingKey: "movie-1",
				type: "movie",
				title: "Movie",
				Guid: [
					{ id: "tmdb://100" },
					{ id: "tmdb://200" },
					{ id: "tvdb://300" },
					{ id: "imdb://tt123" },
				],
			},
			{ ratingKey: "show-1", type: "show", Guid: [{ id: "tmdb://not-a-number" }] },
			{ ratingKey: "collection-1", type: "collection", title: "Collection" },
		];
		const fetchMock = vi.fn().mockImplementation((request) => {
			const url = new URL(String(request));
			const includesGuids = url.searchParams.get("includeGuids") === "1";
			return Promise.resolve(
				response({
					offset: 0,
					size: nativeRows.length,
					totalSize: nativeRows.length,
					Metadata: nativeRows.map((candidate) => {
						if (includesGuids) return candidate;
						const { Guid: _guid, ...withoutGuids } = candidate;
						return withoutGuids;
					}),
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeLibraryItemsWithCoverage("owned/shows")).resolves.toMatchObject({
			items: [
				{
					ratingKey: "movie-1",
					type: "movie",
					title: "Movie",
					externalIds: { tmdb: [100, 200], tvdb: [300] },
				},
				{ ratingKey: "show-1", type: "show", title: "" },
				{ ratingKey: "collection-1", type: "collection", title: "Collection" },
			],
			expectedRawCount: 3,
			rawObserved: 3,
			reason: null,
		});

		const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(url.pathname).toBe("/library/sections/owned%2Fshows/all");
		expect(url.searchParams.get("type")).toBeNull();
		expect(url.searchParams.get("includeGuids")).toBe("1");
		expect(url.searchParams.get("includeCollections")).toBeNull();
		expect(url.searchParams.get("includeLabels")).toBeNull();
		expect(url.searchParams.get("X-Plex-Container-Start")).toBe("0");
		expect(url.searchParams.get("X-Plex-Container-Size")).toBe("200");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["missing native ID", { type: "movie", title: "Movie" }],
		["unsupported native type", { ratingKey: "item-1", type: "artist", title: "Artist" }],
	] as const)(
		"rejects library rows with %s without exposing partial inventory",
		async (_name, item) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(response({ offset: 0, size: 1, totalSize: 1, Metadata: [item] })),
			);
			const client = new PlexClient("http://plex.test", "token", log);

			await expect(client.getNativeLibraryItemsWithCoverage("shows")).resolves.toMatchObject({
				items: [],
				expectedRawCount: null,
				rawObserved: 0,
				pagesAttempted: 1,
				pagesCompleted: 0,
				reason: "page-failure",
			});
		},
	);

	it("normalizes all valid TMDB and TVDB GUIDs while retaining the native row", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			response({
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					{
						ratingKey: "movie-1",
						type: "movie",
						title: "Movie",
						Guid: [
							{ id: "tmdb://100" },
							{ id: "tmdb://100" },
							{ id: "tmdb://200" },
							{ id: "tvdb://300" },
							{ id: "tvdb://0" },
							{ id: "tvdb://not-a-number" },
							{ id: "imdb://tt123" },
						],
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getNativeLibraryItemsWithCoverage("movies")).resolves.toMatchObject({
			items: [
				{
					ratingKey: "movie-1",
					externalIds: { tmdb: [100, 200], tvdb: [300] },
				},
			],
			reason: null,
		});
	});
});
