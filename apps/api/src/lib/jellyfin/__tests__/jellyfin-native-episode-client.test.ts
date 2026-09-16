import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";
import { collectJellyfinNativeEpisodeInventory } from "../jellyfin-native-episode-inventory.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

function response(body: Record<string, unknown>, startIndex = 0): Response {
	const payload = "StartIndex" in body ? body : { ...body, StartIndex: startIndex };
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function episode(index: number, overrides: Record<string, unknown> = {}) {
	return {
		Id: `episode-${index}`,
		Name: `Episode ${index}`,
		Type: "Episode",
		SeriesId: "series-1",
		ParentIndexNumber: 1,
		IndexNumber: index,
		...overrides,
	};
}

describe("JellyfinClient native episode inventory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("requests recursive Episode pages without watch or mapping fields", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(response({ Items: [episode(1)], TotalRecordCount: 1 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getNativeEpisodeItemsWithCoverage("library/id");

		expect(result).toMatchObject({
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "Episode 1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
				},
			],
			expectedRawCount: 1,
			rawObserved: 1,
			reason: null,
		});
		const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(requestUrl.pathname).toBe("/Items");
		expect(requestUrl.searchParams.get("ParentId")).toBe("library/id");
		expect(requestUrl.searchParams.get("IncludeItemTypes")).toBe("Episode");
		expect(requestUrl.searchParams.get("Recursive")).toBe("true");
		expect(requestUrl.searchParams.get("CollapseBoxSetItems")).toBe("false");
		expect(requestUrl.searchParams.get("StartIndex")).toBe("0");
		expect(requestUrl.searchParams.get("Limit")).toBe("1000");
		expect(requestUrl.searchParams.get("EnableUserData")).toBe("false");
		expect(requestUrl.searchParams.get("EnableImages")).toBe("false");
		expect(requestUrl.searchParams.get("Fields")).toBeNull();
	});

	it("paginates an empty native episode inventory as complete", async () => {
		const fetchMock = vi.fn().mockResolvedValue(response({ Items: [], TotalRecordCount: 0 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 0,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
			reason: null,
		});
	});

	it("retains native identity when optional metadata is malformed or absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [
						episode(1, {
							Name: 42,
							SeriesId: null,
							ParentIndexNumber: "unknown",
							IndexNumber: -1,
						}),
					],
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "",
				},
			],
			reason: null,
		});
	});

	it.each([
		["wrong type", episode(1, { Type: "Movie" })],
		["blank ID", episode(1, { Id: " " })],
		["duplicate IDs", [episode(1), episode(1)]],
	] as const)("rejects %s without exposing a partial inventory", async (_name, invalid) => {
		const items = Array.isArray(invalid) ? invalid : [invalid];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => response({ Items: items, TotalRecordCount: items.length })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
	});

	it("rejects cursor drift and total changes across pages", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(response({ Items: [episode(2)], TotalRecordCount: 3 }, 1))
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(response({ Items: [episode(2)], TotalRecordCount: 3 }, 1));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 2,
			rawObserved: 1,
			reason: "page-failure",
		});
	});

	it("rejects a page whose reported cursor does not match the requested offset", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(
				response({ Items: [episode(2)], StartIndex: 0, TotalRecordCount: 2 }, 1),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 2,
			rawObserved: 1,
			reason: "page-failure",
		});
	});
	it.each(["timeout", "total drift", "duplicate window"])(
		"publishes complete collector evidence after recovering from a late-page %s",
		async (failure) => {
			const firstPage = Array.from({ length: 1000 }, (_, index) => episode(index + 1));
			let nativeRequests = 0;
			const cursors: number[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname === "/Library/MediaFolders") {
					return response({
						Items: [{ Id: "library", Type: "CollectionFolder", CollectionType: "tvshows" }],
						TotalRecordCount: 1,
					});
				}
				expect(url.pathname).toBe("/Items");
				const cursor = Number(url.searchParams.get("StartIndex"));
				cursors.push(cursor);
				nativeRequests++;
				if (nativeRequests === 2) {
					if (failure === "timeout") throw new DOMException("request timed out", "TimeoutError");
					if (failure === "total drift")
						return response({ Items: [episode(1001)], TotalRecordCount: 1002 }, 1000);
					return response({ Items: [episode(1)], TotalRecordCount: 1001 }, 1000);
				}
				const items = cursor === 0 ? [...firstPage] : [episode(1001)];
				if (nativeRequests === 1 && failure !== "timeout") items[999] = episode(9999);
				return response({ Items: items, TotalRecordCount: 1001 }, cursor);
			});
			vi.stubGlobal("fetch", fetchMock);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
			const scopes = vi.spyOn(client, "getNativeEpisodeItemsWithCoverage");
			const result = await collectJellyfinNativeEpisodeInventory(client);
			expect(result.complete).toBe(true);
			if (!result.complete) throw new Error("recovered collector did not complete");
			expect(result.snapshots[0].rows).toHaveLength(1001);
			expect(result.snapshots[0].rows.some((row) => row.nativeId === "episode-9999")).toBe(false);
			expect(scopes).toHaveBeenCalledTimes(2);
			for (const call of scopes.mock.results) {
				expect(await call.value).toMatchObject({
					reason: null,
					pagesAttempted: 2,
					pagesCompleted: 2,
					rawObserved: 1001,
				});
			}
			expect(cursors).toEqual(
				failure === "timeout" ? [0, 1000, 1000, 0, 1000] : [0, 1000, 0, 1000, 0, 1000],
			);
		},
	);
});
