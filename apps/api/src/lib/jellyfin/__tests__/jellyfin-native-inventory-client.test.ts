import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

function response(body: Record<string, unknown>, startIndex = 0): Response {
	const payload =
		"Items" in body && !("StartIndex" in body) ? { ...body, StartIndex: startIndex } : body;
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function item(index: number, overrides: Record<string, unknown> = {}) {
	return {
		Id: `item-${index}`,
		Type: index % 3 === 0 ? "BoxSet" : index % 2 === 0 ? "Series" : "Movie",
		Name: `Item ${index}`,
		ProviderIds: null,
		UserData: { Played: true, PlayCount: index },
		ImageTags: { Primary: "private-image-tag" },
		...overrides,
	};
}

function folder(index: number, overrides: Record<string, unknown> = {}) {
	return {
		Id: `library-${index}`,
		Name: `Library ${index}`,
		Type: "CollectionFolder",
		CollectionType: "movies",
		...overrides,
	};
}

describe("JellyfinClient native library inventory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("discovers all server-native media folders without user fan-out", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ Items: [folder(1), folder(2, { Name: null })], TotalRecordCount: 2 }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeMediaFolders()).resolves.toEqual([
			{ id: "library-1", name: "Library 1", collectionType: "movies" },
			{ id: "library-2", name: "", collectionType: "movies" },
		]);
		expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe("/Library/MediaFolders");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["incomplete total", { Items: [folder(1)], TotalRecordCount: 2 }],
		["missing total", { Items: [folder(1)] }],
		["duplicate IDs", { Items: [folder(1), folder(1)], TotalRecordCount: 2 }],
		["missing native type", { Items: [folder(1, { Type: undefined })], TotalRecordCount: 1 }],
		["nonzero start", { Items: [folder(1)], TotalRecordCount: 1, StartIndex: 1 }],
	] as const)("rejects native media-folder discovery with %s", async (_name, body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeMediaFolders()).rejects.toThrow();
	});

	it("rejects duplicate native media-folder IDs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ Items: [folder(1), folder(1)], TotalRecordCount: 2 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeMediaFolders()).rejects.toThrow(/duplicate IDs/);
	});

	it("paginates native items with provider IDs without user or image fields", async () => {
		const firstPage = Array.from({ length: 1_000 }, (_, index) =>
			item(
				index + 1,
				index === 0
					? { ProviderIds: { Tmdb: "1001" } }
					: index === 1
						? { ProviderIds: { Tmdb: "not-a-number" } }
						: index === 2
							? { ProviderIds: undefined }
							: {},
			),
		);
		const fetchMock = vi.fn().mockImplementation((request) => {
			const url = new URL(String(request));
			const startIndex = Number(url.searchParams.get("StartIndex") ?? "0");
			const pageItems = startIndex === 0 ? firstPage : [item(1_001)];
			const includesProviderIds = url.searchParams
				.get("Fields")
				?.split(",")
				.includes("ProviderIds");
			return Promise.resolve(
				response(
					{
						Items: pageItems.map((candidate) => {
							if (includesProviderIds) return candidate;
							const { ProviderIds: _providerIds, ...withoutProviderIds } = candidate;
							return withoutProviderIds;
						}),
						TotalRecordCount: 1_001,
					},
					startIndex,
				),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getNativeLibraryItemsWithCoverage("library/id", {
			includeItemTypes: "Movie,Series",
		});

		expect(result).toMatchObject({
			expectedRawCount: 1_001,
			rawObserved: 1_001,
			pagesAttempted: 2,
			pagesCompleted: 2,
			reason: null,
		});
		expect(result.items).toHaveLength(1_001);
		expect(result.items[0]).toEqual({
			id: "item-1",
			type: "Movie",
			name: "Item 1",
			externalIds: { tmdb: [1001] },
		});
		expect(result.items[1]).toEqual({ id: "item-2", type: "Series", name: "Item 2" });
		expect(result.items[2]).toEqual({ id: "item-3", type: "BoxSet", name: "Item 3" });
		const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(firstUrl.pathname).toBe("/Items");
		expect(firstUrl.searchParams.get("ParentId")).toBe("library/id");
		expect(firstUrl.searchParams.get("Recursive")).toBe("true");
		expect(firstUrl.searchParams.get("CollapseBoxSetItems")).toBe("false");
		expect(firstUrl.searchParams.get("IncludeItemTypes")).toBe("Movie,Series");
		expect(firstUrl.searchParams.get("EnableUserData")).toBe("false");
		expect(firstUrl.searchParams.get("EnableImages")).toBe("false");
		expect(firstUrl.searchParams.get("StartIndex")).toBe("0");
		expect(firstUrl.searchParams.get("Limit")).toBe("1000");
		expect(firstUrl.searchParams.get("Fields")).toBe("ProviderIds");
		const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
		expect(secondUrl.searchParams.get("StartIndex")).toBe("1000");
		expect(secondUrl.searchParams.get("Fields")).toBe("ProviderIds");
	});

	it("accepts an empty complete native inventory", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ Items: [], TotalRecordCount: 0 })));
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 0,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
			reason: null,
		});
	});

	it.each([
		["missing", { Items: [item(1)], TotalRecordCount: 1, StartIndex: undefined }],
		["mismatched", { Items: [item(1)], TotalRecordCount: 1, StartIndex: 1 }],
	] as const)("rejects a native page with %s StartIndex", async (_name, body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: null,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 0,
			reason: "page-failure",
		});
	});

	it("retains native items with malformed optional names and unrelated watch or mapping fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [
						item(1, {
							Name: null,
							ProviderIds: {
								Tmdb: "100",
								tmdb: "200",
								Tvdb: "300",
								Imdb: "tt123",
								Bad: "not-a-number",
							},
							UserData: null,
							ImageTags: null,
						}),
						item(2, { Name: 42, ProviderIds: { Tmdb: "not-required" } }),
					],
					TotalRecordCount: 2,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: [
				{ id: "item-1", type: "Movie", name: "", externalIds: { tmdb: [100, 200], tvdb: [300] } },
				{ id: "item-2", type: "Series", name: "" },
			],
			reason: null,
		});
	});

	it.each([
		["blank ID", item(1, { Id: "" })],
		["whitespace ID", item(1, { Id: "   " })],
		["NUL-containing ID", item(1, { Id: "item-\0-1" })],
		["missing type", item(1, { Type: undefined })],
		["unsupported type", item(1, { Type: "Episode" })],
	] as const)("rejects %s without exposing partial inventory", async (_name, invalidItem) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response({ Items: [invalidItem], TotalRecordCount: 1 })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
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
			"truncation",
			[
				response({ Items: [item(1)], TotalRecordCount: 2 }),
				response({ Items: [], TotalRecordCount: 2 }, 1),
			],
		],
	] as const)("rejects %s without returning observed rows", async (_name, pages) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(() => pages[0])
				.mockImplementationOnce(() => pages[1])
				.mockImplementationOnce(() => pages[0])
				.mockImplementationOnce(() => pages[1]),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			rawObserved: 1,
			reason: "page-failure",
		});
	});

	it("restarts once at zero after total drift and accepts a stable second pass", async () => {
		const pages = [
			response({ Items: [item(1)], TotalRecordCount: 2 }),
			response({ Items: [item(2)], TotalRecordCount: 3 }, 1),
			response({ Items: [item(1)], TotalRecordCount: 2 }),
			response({ Items: [item(2)], TotalRecordCount: 2 }, 1),
		];
		let call = 0;
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(pages[call++]));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: expect.arrayContaining([
				{ id: "item-1", type: "Movie", name: "Item 1" },
				{ id: "item-2", type: "Series", name: "Item 2" },
			]),
			expectedRawCount: 2,
			rawObserved: 2,
			reason: null,
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(new URL(String(fetchMock.mock.calls[2]?.[0])).searchParams.get("StartIndex")).toBe("0");
	});

	it("fails closed after one persistent duplicate-window restart", async () => {
		const pages = [
			response({ Items: [item(1)], TotalRecordCount: 2 }),
			response({ Items: [item(1)], TotalRecordCount: 2 }, 1),
			response({ Items: [item(1)], TotalRecordCount: 2 }),
			response({ Items: [item(1)], TotalRecordCount: 2 }, 1),
		];
		let call = 0;
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(pages[call++]));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			rawObserved: 1,
			reason: "page-failure",
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("retries a failed native page at the same cursor and retains prior rows", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [item(1)], TotalRecordCount: 2 }))
			.mockRejectedValueOnce(new Error("transient timeout"))
			.mockResolvedValueOnce(response({ Items: [item(2)], TotalRecordCount: 2 }, 1));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeLibraryItemsWithCoverage("library")).resolves.toMatchObject({
			items: expect.arrayContaining([
				{ id: "item-1", type: "Movie", name: "Item 1" },
				{ id: "item-2", type: "Series", name: "Item 2" },
			]),
			expectedRawCount: 2,
			rawObserved: 2,
			reason: null,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("StartIndex")).toBe("1");
		expect(new URL(String(fetchMock.mock.calls[2]?.[0])).searchParams.get("StartIndex")).toBe("1");
	});

	it("rejects provider failures without exposing prior rows", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [item(1)], TotalRecordCount: 2 }))
			.mockRejectedValue(new Error("private provider failure"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getNativeLibraryItemsWithCoverage("library");

		expect(result).toMatchObject({
			items: [],
			rawObserved: 1,
			pagesAttempted: 2,
			pagesCompleted: 1,
			reason: "page-failure",
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		for (const call of fetchMock.mock.calls.slice(1)) {
			expect(new URL(String(call[0])).searchParams.get("StartIndex")).toBe("1");
		}
		expect(JSON.stringify(result)).not.toContain("private provider failure");
	});
});
