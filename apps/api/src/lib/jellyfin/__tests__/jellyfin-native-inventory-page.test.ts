import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function page(items: Array<Record<string, unknown>>, startIndex: number, totalRecordCount: number) {
	return new Response(
		JSON.stringify({ Items: items, StartIndex: startIndex, TotalRecordCount: totalRecordCount }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

describe("Jellyfin durable native inventory page", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("returns one validated library page before a later page fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				page(
					[
						{ Id: "item-1", Type: "Movie", Name: "Synthetic 1", ProviderIds: { Tmdb: "101" } },
						{ Id: "item-2", Type: "Series", Name: "Synthetic 2", ProviderIds: null },
					],
					0,
					3,
				),
			)
			.mockRejectedValueOnce(new Error("synthetic network failure"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
		const deadlineAt = Date.now() + 5_000;
		const input = {
			domain: "library" as const,
			libraryId: "library-1",
			includeItemTypes: "Movie,Series" as const,
			limit: 2,
			deadlineAt,
		};

		await expect(client.readNativeInventoryPage({ ...input, startIndex: 0 })).resolves.toEqual({
			status: "page",
			domain: "library",
			startIndex: 0,
			totalRecordCount: 3,
			items: [
				{ id: "item-1", type: "Movie", name: "Synthetic 1", externalIds: { tmdb: [101] } },
				{ id: "item-2", type: "Series", name: "Synthetic 2" },
			],
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(firstUrl.searchParams.get("StartIndex")).toBe("0");
		expect(firstUrl.searchParams.get("Limit")).toBe("2");
		expect(firstUrl.searchParams.get("ParentId")).toBe("library-1");
		expect(firstUrl.searchParams.get("IncludeItemTypes")).toBe("Movie,Series");
		expect(firstUrl.searchParams.get("EnableUserData")).toBe("false");
		expect(firstUrl.searchParams.get("EnableImages")).toBe("false");
		expect(firstUrl.searchParams.get("Fields")).toBe("ProviderIds");

		await expect(client.readNativeInventoryPage({ ...input, startIndex: 2 })).resolves.toEqual({
			status: "unavailable",
			reason: "provider-unavailable",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps a valid page available when timing telemetry throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				page(
					[
						{
							Id: "episode-1",
							Type: "Episode",
							Name: "Synthetic",
							SeriesId: "series-1",
							ParentIndexNumber: 1,
							IndexNumber: 2,
						},
					],
					0,
					1,
				),
			),
		);
		const throwingLog = {
			warn: vi.fn(),
			info: vi.fn(() => {
				throw new Error("synthetic telemetry failure");
			}),
		} as unknown as FastifyBaseLogger;
		const client = new JellyfinClient("http://jellyfin.test", "api-key", throwingLog);

		await expect(
			client.readNativeInventoryPage({
				domain: "episode",
				libraryId: "library-1",
				startIndex: 0,
				limit: 1,
				deadlineAt: Date.now() + 5_000,
			}),
		).resolves.toEqual({
			status: "page",
			domain: "episode",
			startIndex: 0,
			totalRecordCount: 1,
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "Synthetic",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 2,
				},
			],
		});
	});

	it("accepts a bounded 2000-item request but rejects a larger one", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(page([{ Id: "episode-1", Type: "Episode", Name: "Synthetic" }], 0, 1));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
		const input = {
			domain: "episode" as const,
			libraryId: "library-1",
			startIndex: 0,
			deadlineAt: Date.now() + 5_000,
		};
		await expect(client.readNativeInventoryPage({ ...input, limit: 2_000 })).resolves.toMatchObject(
			{
				status: "page",
			},
		);
		expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("Limit")).toBe("2000");
		await expect(client.readNativeInventoryPage({ ...input, limit: 2_001 })).rejects.toThrow(
			"Jellyfin native page input is invalid",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
