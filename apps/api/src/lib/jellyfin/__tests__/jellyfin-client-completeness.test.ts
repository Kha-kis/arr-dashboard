import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

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

function movie(index: number) {
	return {
		Id: `movie-${index}`,
		Name: `Movie ${index}`,
		Type: "Movie",
		ProviderIds: { Tmdb: String(index) },
	};
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
		).rejects.toThrow(/Upstream validation failed.*Items\.1\.Type/i);
	});
});
