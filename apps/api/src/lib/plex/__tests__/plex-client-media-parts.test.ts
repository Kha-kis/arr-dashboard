import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

const log = {
	warn: vi.fn(),
} as never;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PlexClient.getMovieMediaPartsByTmdbId", () => {
	it("uses a targeted GUID query and returns file identity for the matched item", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					MediaContainer: {
						offset: 0,
						size: 1,
						totalSize: 1,
						Metadata: [
							{
								ratingKey: "9001",
								Guid: [{ id: "tmdb://42" }],
								Media: [
									{
										Part: [
											{ file: "/movies/Example.1080p.mkv", size: "1000" },
											{ file: "/movies/Example.2160p.mkv", size: 2000 },
										],
									},
								],
							},
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getMovieMediaPartsByTmdbId(42)).resolves.toEqual([
			{
				ratingKey: "9001",
				parts: [
					{ file: "/movies/Example.1080p.mkv", size: 1000 },
					{ file: "/movies/Example.2160p.mkv", size: 2000 },
				],
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(requestedUrl.pathname).toBe("/library/all");
		expect(requestedUrl.searchParams.get("guid")).toBe("tmdb://42");
		expect(requestedUrl.searchParams.get("includeMedia")).toBe("1");
	});

	it("fails closed when Plex has no exact TMDb match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						MediaContainer: { offset: 0, size: 0, totalSize: 0, Metadata: [] },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getMovieMediaPartsByTmdbId(42)).rejects.toThrow(
			"no movie item for TMDb 42",
		);
	});

	it("rejects a matched part without a path and size", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "9001",
									Guid: [{ id: "tmdb://42" }],
									Media: [{ Part: [{}] }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getMovieMediaPartsByTmdbId(42)).rejects.toThrow();
	});

	it("rejects a matched item when any media version has no resolvable parts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "9001",
									Guid: [{ id: "tmdb://42" }],
									Media: [
										{
											Part: [{ file: "/movies/Example.2160p.mkv", size: 2000 }],
										},
										{},
									],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getMovieMediaPartsByTmdbId(42)).rejects.toThrow();
	});
});

describe("PlexClient.getSeriesEpisodeMediaPartsByTvdbId", () => {
	it("retains Plex show grouping while returning exact episode media parts", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "show-1",
									title: "Example",
									type: "show",
									Guid: [{ id: "tvdb://123" }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "episode-1",
									Media: [
										{
											Part: [{ file: "/tv/Example/S01E01.mkv", size: "1000" }],
										},
									],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getSeriesEpisodeMediaPartsByTvdbId(123)).resolves.toEqual([
			{
				ratingKey: "show-1",
				episodes: [
					{
						ratingKey: "episode-1",
						parts: [{ file: "/tv/Example/S01E01.mkv", size: 1000 }],
					},
				],
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const showUrl = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(showUrl.pathname).toBe("/library/all");
		expect(showUrl.searchParams.get("guid")).toBe("tvdb://123");
		expect(fetchMock.mock.calls[1]![0]).toContain(
			"/library/metadata/show-1/allLeaves?includeMedia=1",
		);
	});

	it("fails closed when Plex has no exact TVDB series match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "show-other",
									title: "Same title",
									type: "show",
									Guid: [{ id: "tvdb://999" }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getSeriesEpisodeMediaPartsByTvdbId(123)).rejects.toThrow(
			"no series item for TVDB 123",
		);
	});

	it("rejects an episode whose physical media source is incomplete", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "show-1",
									title: "Example",
									type: "show",
									Guid: [{ id: "tvdb://123" }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [{ ratingKey: "episode-1", Media: [{ Part: [{}] }] }],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getSeriesEpisodeMediaPartsByTvdbId(123)).rejects.toThrow();
	});

	it("pages every episode before returning a complete show file set", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Metadata: [
								{
									ratingKey: "show-1",
									type: "show",
									Guid: [{ id: "tvdb://123" }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 2,
							Metadata: [
								{
									ratingKey: "episode-4k",
									parentIndex: 1,
									index: 1,
									Media: [{ Part: [{ file: "/tv-4k/Example/S01E01.mkv", size: 2_000 }] }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 1,
							size: 1,
							totalSize: 2,
							Metadata: [
								{
									ratingKey: "episode-hd",
									parentIndex: 1,
									index: 2,
									Media: [{ Part: [{ file: "/tv-hd/Example/S01E01.mkv", size: 1_000 }] }],
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getSeriesEpisodeMediaPartsByTvdbId(123)).resolves.toEqual([
			{
				ratingKey: "show-1",
				episodes: [
					{
						ratingKey: "episode-4k",
						seasonNumber: 1,
						episodeNumber: 1,
						parts: [{ file: "/tv-4k/Example/S01E01.mkv", size: 2_000 }],
					},
					{
						ratingKey: "episode-hd",
						seasonNumber: 1,
						episodeNumber: 2,
						parts: [{ file: "/tv-hd/Example/S01E01.mkv", size: 1_000 }],
					},
				],
			},
		]);
		expect(
			new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("X-Plex-Container-Start"),
		).toBe("0");
		expect(
			new URL(fetchMock.mock.calls[2]![0] as string).searchParams.get("X-Plex-Container-Start"),
		).toBe("1");
	});
});

describe("PlexClient.getEpisodes", () => {
	it("pages every episode before returning the show watch inventory", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 2,
							Metadata: [
								{
									ratingKey: "episode-1",
									title: "Episode 1",
									parentIndex: 1,
									index: 1,
									viewCount: 1,
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							offset: 1,
							size: 1,
							totalSize: 2,
							Metadata: [
								{
									ratingKey: "episode-2",
									title: "Episode 2",
									parentIndex: 1,
									index: 2,
									viewCount: 3,
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getEpisodes("show-1")).resolves.toEqual([
			{
				ratingKey: "episode-1",
				title: "Episode 1",
				seasonNumber: 1,
				episodeNumber: 1,
				viewCount: 1,
				lastViewedAt: undefined,
			},
			{
				ratingKey: "episode-2",
				title: "Episode 2",
				seasonNumber: 1,
				episodeNumber: 2,
				viewCount: 3,
				lastViewedAt: undefined,
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get("X-Plex-Container-Start"),
		).toBe("0");
		expect(
			new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("X-Plex-Container-Start"),
		).toBe("1");
	});
});

describe("PlexClient.getEpisodeWatchCount", () => {
	it("reads the current count for the exact episode rating key", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					MediaContainer: {
						Metadata: [
							{
								ratingKey: "episode-1",
								title: "Episode 1",
								viewCount: 3,
							},
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex:32400", "token", log);

		await expect(client.getEpisodeWatchCount("episode-1")).resolves.toBe(3);
		expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe(
			"/library/metadata/episode-1",
		);
	});
});
