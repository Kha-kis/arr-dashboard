import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

const log = { warn: vi.fn() } as never;

function response(MediaContainer: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ MediaContainer }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function metadata(ratingKey: string, overrides: Record<string, unknown> = {}) {
	return {
		ratingKey,
		type: "movie",
		guid: `plex://movie/${ratingKey}`,
		Guid: [{ id: `tmdb://${ratingKey}` }],
		librarySectionID: "movies",
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("PlexClient target metadata", () => {
	it("reads up to 100 target metadata records in one comma-separated request", async () => {
		const ratingKeys = Array.from({ length: 100 }, (_, index) => `movie-${index + 1}`);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				response({ Metadata: ratingKeys.map((ratingKey) => metadata(ratingKey)) }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadataBatch(ratingKeys)).resolves.toHaveLength(100);
		expect(fetchMock).toHaveBeenCalledOnce();
		const url = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(url.pathname).toBe(`/library/metadata/${ratingKeys.join(",")}`);
		expect(url.searchParams.get("includeGuids")).toBe("1");
	});

	it("returns available records when Plex omits a requested key", async () => {
		const fetchMock = vi.fn().mockResolvedValue(response({ Metadata: [metadata("movie-1")] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadataBatch(["movie-1", "movie-2"])).resolves.toMatchObject([
			{ ratingKey: "movie-1" },
		]);
	});

	it("rejects invalid, duplicate, and over-limit requests before HTTP", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadataBatch([])).resolves.toEqual([]);
		await expect(client.getTargetMetadataBatch(["movie-1", "movie-1"])).rejects.toThrow();
		await expect(client.getTargetMetadataBatch(["   "])).rejects.toThrow();
		await expect(
			client.getTargetMetadataBatch(Array.from({ length: 101 }, (_, index) => `movie-${index}`)),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects duplicate or unrequested returned identities without fallback calls", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Metadata: [metadata("movie-1"), metadata("movie-1")] }))
			.mockResolvedValueOnce(response({ Metadata: [metadata("movie-2")] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadataBatch(["movie-1"])).rejects.toThrow();
		await expect(client.getTargetMetadataBatch(["movie-1"])).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a failed batch as per-item metadata requests", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("batch failed"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadataBatch(["movie-1", "movie-2"])).rejects.toThrow(
			"batch failed",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("strictly returns the current GUID, external GUIDs, section and ancestry", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			response({
				Metadata: [
					{
						ratingKey: "episode-9",
						type: "episode",
						guid: "plex://episode/9",
						Guid: [{ id: "tmdb://42" }],
						librarySectionID: 7,
						parentRatingKey: "season-2",
						grandparentRatingKey: "show-1",
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadata("episode-9")).resolves.toEqual({
			ratingKey: "episode-9",
			type: "episode",
			guid: "plex://episode/9",
			Guid: [{ id: "tmdb://42" }],
			librarySectionID: "7",
			parentRatingKey: "season-2",
			grandparentRatingKey: "show-1",
		});
		const url = new URL(fetchMock.mock.calls[0]![0] as string);
		expect(url.pathname).toBe("/library/metadata/episode-9");
		expect(url.searchParams.get("includeGuids")).toBe("1");
	});

	it("rejects duplicate, missing GUID, and wrong identity records", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Metadata: [] }))
			.mockResolvedValueOnce(
				response({
					Metadata: [
						{
							ratingKey: "movie-1",
							type: "movie",
							guid: "plex://movie/1",
							Guid: [{ id: "tmdb://1" }],
							librarySectionID: "movies",
						},
						{
							ratingKey: "movie-1",
							type: "movie",
							guid: "plex://movie/2",
							Guid: [{ id: "tmdb://1" }],
							librarySectionID: "movies",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				response({
					Metadata: [
						{
							ratingKey: "movie-2",
							type: "movie",
							Guid: [{ id: "tmdb://2" }],
							librarySectionID: "movies",
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getTargetMetadata("movie-0")).rejects.toThrow();
		await expect(client.getTargetMetadata("movie-1")).rejects.toThrow();
		await expect(client.getTargetMetadata("movie-2")).rejects.toThrow();
	});
});
