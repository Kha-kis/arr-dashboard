import { describe, expect, it, vi } from "vitest";
import type {
	JellyfinClient,
	JellyfinLibrary,
	JellyfinNativeLibraryItem,
} from "../jellyfin-client.js";
import { collectJellyfinNativeLibraryInventory } from "../jellyfin-native-inventory.js";

function page(items: JellyfinNativeLibraryItem[], expectedRawCount = items.length) {
	return {
		items,
		expectedRawCount,
		rawObserved: items.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		reason: null as "page-failure" | null,
	};
}
function library(id: string, collectionType = "movies"): JellyfinLibrary {
	return { id, name: "Private library", collectionType };
}
function nativeItem(
	id: string,
	type: JellyfinNativeLibraryItem["type"] = "Movie",
	name = "Native item",
	overrides: Partial<JellyfinNativeLibraryItem> = {},
): JellyfinNativeLibraryItem {
	return { id, type, name, ...overrides };
}
function fixture(
	options: {
		libraries?: JellyfinLibrary[];
		items?: Record<string, JellyfinNativeLibraryItem[]>;
	} = {},
) {
	const libraries = options.libraries ?? [library("library-1")];
	const items = options.items ?? { "library-1": [nativeItem("movie-1")] };
	const getNativeMediaFolders = vi.fn(async () => libraries);
	const getUsers = vi.fn(() => {
		throw new Error("Native inventory must not enumerate users");
	});
	const getLibraries = vi.fn(() => {
		throw new Error("Native inventory must not enumerate user views");
	});
	const getNativeLibraryItemsWithCoverage = vi.fn(async (libraryId: string) =>
		page(items[libraryId] ?? []),
	);
	const client = {
		getNativeMediaFolders,
		getUsers,
		getLibraries,
		getNativeLibraryItemsWithCoverage,
	} as unknown as JellyfinClient;
	return {
		client,
		getNativeMediaFolders,
		getUsers,
		getLibraries,
		getNativeLibraryItemsWithCoverage,
	};
}

describe("complete Jellyfin server-native library inventory", () => {
	it("reads server folders twice without user fan-out and merges shared native IDs", async () => {
		const f = fixture({
			libraries: [library("library-1"), library("library-2")],
			items: {
				"library-1": [
					nativeItem("shared", "Movie", "First title", { externalIds: { tmdb: [100] } }),
				],
				"library-2": [
					nativeItem("shared", "Movie", "Second title", { externalIds: { tmdb: [200] } }),
				],
			},
		});
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: true,
			snapshots: [
				{
					domain: "library",
					scopeKeys: ["library:library-1", "library:library-2"],
					rows: [
						{
							nativeId: "shared",
							mediaType: "movie",
							libraryIds: ["library-1", "library-2"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Second title",
							externalIds: { tmdb: [100, 200] },
						},
					],
				},
			],
		});
		expect(f.getNativeMediaFolders).toHaveBeenCalledTimes(3);
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(4);
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenNthCalledWith(1, "library-1", {
			includeItemTypes: "Movie",
		});
		expect(f.getUsers).not.toHaveBeenCalled();
		expect(f.getLibraries).not.toHaveBeenCalled();
	});

	it("retains native membership with unknown matching when identifiers disappear between passes", async () => {
		const f = fixture();
		f.getNativeLibraryItemsWithCoverage
			.mockResolvedValueOnce(
				page([nativeItem("movie-1", "Movie", "Movie", { externalIds: { tmdb: [100] } })]),
			)
			.mockResolvedValue(page([nativeItem("movie-1", "Movie", "Movie")]));
		const result = await collectJellyfinNativeLibraryInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots[0]?.rows).toHaveLength(1);
		expect(result.snapshots[0]?.rows[0]?.externalIds).toBeUndefined();
	});

	it("publishes native items and preserves ambiguity when identifier metadata changes between passes", async () => {
		const f = fixture();
		f.getNativeLibraryItemsWithCoverage
			.mockResolvedValueOnce(
				page([nativeItem("movie-1", "Movie", "Movie", { externalIds: { tmdb: [100] } })]),
			)
			.mockResolvedValueOnce(
				page([nativeItem("movie-1", "Movie", "Movie", { externalIds: { tmdb: [200] } })]),
			)
			.mockResolvedValue(
				page([nativeItem("movie-1", "Movie", "Movie", { externalIds: { tmdb: [300] } })]),
			);

		const result = await collectJellyfinNativeLibraryInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots[0]?.rows[0]?.externalIds).toEqual({ tmdb: [100, 200] });
	});

	it("omits the playlist grouping but scans unknown and nonstandard media folders", async () => {
		const f = fixture({
			libraries: [
				library("playlists", "playlists"),
				library("music", "music"),
				library("mixed", "custom"),
			],
			items: {
				music: [nativeItem("unmatched-movie", "Movie", "")],
				mixed: [nativeItem("unmatched-series", "Series")],
			},
		});
		const result = await collectJellyfinNativeLibraryInventory(f.client);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [
				{
					scopeKeys: ["library:mixed", "library:music"],
					rows: [{ nativeId: "unmatched-movie", title: "" }, { nativeId: "unmatched-series" }],
				},
			],
		});
		expect(f.getNativeLibraryItemsWithCoverage).not.toHaveBeenCalledWith(
			"playlists",
			expect.anything(),
		);
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledWith("music", {
			includeItemTypes: "Movie,Series",
		});
	});

	it("publishes verified empty discovery without inventing a library", async () => {
		const f = fixture({ libraries: [] });
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: true,
			snapshots: [{ domain: "library", scopeKeys: [], rows: [] }],
		});
		expect(f.getNativeLibraryItemsWithCoverage).not.toHaveBeenCalled();
	});

	it("retains unmapped native items and excludes BoxSet containers", async () => {
		const f = fixture({
			items: {
				"library-1": [nativeItem("box-set", "BoxSet"), nativeItem("unmapped", "Movie", "")],
			},
		});
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "unmapped", mediaType: "movie", title: "" }] }],
		});
	});

	it("converges on the third pass after a native item is added", async () => {
		const f = fixture();
		f.getNativeLibraryItemsWithCoverage
			.mockResolvedValueOnce(page([nativeItem("existing")]))
			.mockResolvedValue(page([nativeItem("existing"), nativeItem("added")]));
		const result = await collectJellyfinNativeLibraryInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) throw new Error("not complete");
		expect(result.snapshots[0].rows.map((row) => row.nativeId)).toEqual(["added", "existing"]);
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(3);
	});

	it("requires two matching replacement passes instead of merging obsolete IDs", async () => {
		const f = fixture();
		f.getNativeLibraryItemsWithCoverage
			.mockResolvedValueOnce(page([nativeItem("removed")]))
			.mockResolvedValue(page([nativeItem("replacement")]));
		const result = await collectJellyfinNativeLibraryInventory(f.client);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "replacement" }] }],
		});
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(3);
	});

	it.each(["continual additions", "nonconsecutive agreement"])(
		"bounds %s without publishing an unverified union",
		async (scenario) => {
			const f = fixture();
			f.getNativeLibraryItemsWithCoverage
				.mockResolvedValueOnce(page([nativeItem("first")]))
				.mockResolvedValueOnce(page([nativeItem("second")]))
				.mockResolvedValue(
					page([nativeItem(scenario === "nonconsecutive agreement" ? "first" : "third")]),
				);
			expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
				complete: false,
				reason: "coverage-incomplete",
			});
			expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(3);
		},
	);

	it("restarts scope comparison after rediscovery changes and verifies the new scopes twice", async () => {
		const f = fixture({
			items: { "library-1": [nativeItem("old")], "library-2": [nativeItem("new")] },
		});
		f.getNativeMediaFolders
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValue([library("library-2")]);
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ scopeKeys: ["library:library-2"], rows: [{ nativeId: "new" }] }],
		});
		expect(f.getNativeLibraryItemsWithCoverage.mock.calls.map((call) => call[0])).toEqual([
			"library-1",
			"library-2",
			"library-2",
		]);
	});

	it("withholds publication if scope changes after the matching second pass", async () => {
		const f = fixture();
		f.getNativeMediaFolders
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValue([library("library-2")]);
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(3);
	});

	it("bounds continual scope changes", async () => {
		const f = fixture();
		let discovered = 0;
		f.getNativeMediaFolders.mockImplementation(async () => [library(`library-${++discovered}`)]);
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(f.getNativeLibraryItemsWithCoverage).toHaveBeenCalledTimes(3);
	});

	it.each([
		{ libraries: [library("same"), library("same")] },
		{ libraries: [library("")] },
		{ libraries: [library("bad\0id")] },
	])("rejects ambiguous folder identity", async (options) => {
		const f = fixture(options);
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(f.getNativeLibraryItemsWithCoverage).not.toHaveBeenCalled();
	});

	it("rejects conflicting native types across physical folders", async () => {
		const f = fixture({
			libraries: [library("movies"), library("shows", "tvshows")],
			items: { movies: [nativeItem("same-id")], shows: [nativeItem("same-id", "Series")] },
		});
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it("rejects a duplicate within one scope", async () => {
		const f = fixture({ items: { "library-1": [nativeItem("same-id"), nativeItem("same-id")] } });
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it.each(["getNativeMediaFolders", "getNativeLibraryItemsWithCoverage"] as const)(
		"fails closed on %s errors without falling back to user views",
		async (method) => {
			const f = fixture();
			f[method].mockRejectedValueOnce(new Error("private provider failure"));
			expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
				complete: false,
				reason: "provider-unavailable",
			});
			expect(f.getUsers).not.toHaveBeenCalled();
			expect(f.getLibraries).not.toHaveBeenCalled();
		},
	);

	it("does not publish incomplete page evidence", async () => {
		const f = fixture();
		f.getNativeLibraryItemsWithCoverage.mockResolvedValueOnce({
			...page([]),
			expectedRawCount: 2,
			reason: "page-failure",
		});
		expect(await collectJellyfinNativeLibraryInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});
});
