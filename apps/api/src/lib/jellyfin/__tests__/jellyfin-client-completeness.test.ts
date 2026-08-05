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
});
