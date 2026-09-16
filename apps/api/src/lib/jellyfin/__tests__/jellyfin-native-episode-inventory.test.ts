import { describe, expect, it, vi } from "vitest";
import type {
	JellyfinClient,
	JellyfinLibrary,
	JellyfinNativeEpisodeItem,
} from "../jellyfin-client.js";
import { collectJellyfinNativeEpisodeInventory } from "../jellyfin-native-episode-inventory.js";

function episode(
	id: string,
	overrides: Partial<JellyfinNativeEpisodeItem> = {},
): JellyfinNativeEpisodeItem {
	return { id, type: "Episode", name: "Episode", ...overrides };
}
function page(items: JellyfinNativeEpisodeItem[]) {
	return {
		items,
		expectedRawCount: items.length,
		rawObserved: items.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		reason: null as "page-failure" | null,
	};
}
function library(id: string, collectionType = "tvshows"): JellyfinLibrary {
	return { id, name: "Private library", collectionType };
}
function fixture(
	options: {
		libraries?: JellyfinLibrary[];
		items?: Record<string, JellyfinNativeEpisodeItem[]>;
	} = {},
) {
	const libraries = options.libraries ?? [library("library-1")];
	const items = options.items ?? { "library-1": [episode("episode-1")] };
	const getNativeMediaFolders = vi.fn(async () => libraries);
	const getUsers = vi.fn(() => {
		throw new Error("Native inventory must not enumerate users");
	});
	const getLibraries = vi.fn(() => {
		throw new Error("Native inventory must not enumerate user views");
	});
	const getNativeEpisodeItemsWithCoverage = vi.fn(async (libraryId: string) =>
		page(items[libraryId] ?? []),
	);
	const client = {
		getNativeMediaFolders,
		getUsers,
		getLibraries,
		getNativeEpisodeItemsWithCoverage,
	} as unknown as JellyfinClient;
	return {
		client,
		getNativeMediaFolders,
		getUsers,
		getLibraries,
		getNativeEpisodeItemsWithCoverage,
	};
}
const unknownCoordinates = { parentNativeId: null, seasonNumber: null, episodeNumber: null };
const coordinates = { seriesId: "series-1", seasonNumber: 1, episodeNumber: 1 };

describe("complete Jellyfin server-native episode inventory", () => {
	it("scans each physical folder twice without user fan-out and merges shared IDs", async () => {
		const f = fixture({
			libraries: [library("one", "movies"), library("two", "music")],
			items: { one: [episode("shared", coordinates)], two: [episode("shared", coordinates)] },
		});
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
			complete: true,
			snapshots: [
				{
					domain: "episode",
					scopeKeys: ["library:one", "library:two"],
					rows: [
						{
							nativeId: "shared",
							mediaType: "episode",
							libraryIds: ["one", "two"],
							parentNativeId: "series-1",
							seasonNumber: 1,
							episodeNumber: 1,
							title: "Episode",
						},
					],
				},
			],
		});
		expect(f.getNativeMediaFolders).toHaveBeenCalledTimes(3);
		expect(f.getNativeEpisodeItemsWithCoverage.mock.calls).toEqual([
			["one"],
			["two"],
			["one"],
			["two"],
		]);
		expect(f.getUsers).not.toHaveBeenCalled();
		expect(f.getLibraries).not.toHaveBeenCalled();
	});
	it("omits only the playlist grouping while retaining custom media folders", async () => {
		const f = fixture({
			libraries: [library("playlists", "playlists"), library("custom", "unknown")],
			items: { custom: [episode("unmatched")] },
		});
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ scopeKeys: ["library:custom"], rows: [{ nativeId: "unmatched" }] }],
		});
		expect(f.getNativeEpisodeItemsWithCoverage).not.toHaveBeenCalledWith("playlists");
	});
	it.each([[], [library("empty", "books")]])(
		"publishes only verified empty discovery or folders",
		async (...libraries) => {
			const f = fixture({ libraries, items: {} });
			expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
				complete: true,
				snapshots: [{ rows: [] }],
			});
			expect(f.getNativeMediaFolders).toHaveBeenCalledTimes(3);
		},
	);
	it("retains unmatched episodes with unknown coordinates", async () => {
		const f = fixture({ items: { "library-1": [episode("unmatched", { name: "" })] } });
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "unmatched", title: "", ...unknownCoordinates }] }],
		});
	});
	it("makes conflicting coordinates across folders unknown", async () => {
		const f = fixture({
			libraries: [library("one"), library("two"), library("three")],
			items: {
				one: [episode("shared", coordinates)],
				two: [episode("shared", { ...coordinates, seriesId: "other-series" })],
				three: [episode("shared", coordinates)],
			},
		});
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "shared", ...unknownCoordinates }] }],
		});
	});
	it("keeps coordinates unknown when they change between matching membership passes", async () => {
		const f = fixture();
		f.getNativeEpisodeItemsWithCoverage
			.mockResolvedValueOnce(page([episode("same")]))
			.mockResolvedValue(page([episode("same", coordinates)]));
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "same", ...unknownCoordinates }] }],
		});
	});
	it("converges on the third pass after a native episode is added", async () => {
		const f = fixture();
		f.getNativeEpisodeItemsWithCoverage
			.mockResolvedValueOnce(page([episode("existing")]))
			.mockResolvedValue(page([episode("existing", coordinates), episode("added")]));
		const result = await collectJellyfinNativeEpisodeInventory(f.client);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [
				{
					rows: [
						{ nativeId: "added" },
						{ nativeId: "existing", parentNativeId: "series-1", seasonNumber: 1, episodeNumber: 1 },
					],
				},
			],
		});
		expect(f.getNativeEpisodeItemsWithCoverage).toHaveBeenCalledTimes(3);
	});
	it("uses only two matching final passes after removal or replacement", async () => {
		const f = fixture();
		f.getNativeEpisodeItemsWithCoverage
			.mockResolvedValueOnce(page([episode("removed")]))
			.mockResolvedValue(page([episode("replacement")]));
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "replacement" }] }],
		});
		expect(f.getNativeEpisodeItemsWithCoverage).toHaveBeenCalledTimes(3);
	});
	it.each(["continual change", "nonconsecutive agreement"])(
		"bounds %s without publishing a union",
		async (scenario) => {
			const f = fixture();
			f.getNativeEpisodeItemsWithCoverage
				.mockResolvedValueOnce(page([episode("first")]))
				.mockResolvedValueOnce(page([episode("second")]))
				.mockResolvedValue(
					page([episode(scenario === "nonconsecutive agreement" ? "first" : "third")]),
				);
			expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
				complete: false,
				reason: "coverage-incomplete",
			});
			expect(f.getNativeEpisodeItemsWithCoverage).toHaveBeenCalledTimes(3);
		},
	);
	it("requires two complete passes of the new scopes after rediscovery changes", async () => {
		const f = fixture({ items: { "library-1": [episode("old")], "library-2": [episode("new")] } });
		f.getNativeMediaFolders
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValue([library("library-2")]);
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ scopeKeys: ["library:library-2"], rows: [{ nativeId: "new" }] }],
		});
		expect(f.getNativeEpisodeItemsWithCoverage.mock.calls).toEqual([
			["library-1"],
			["library-2"],
			["library-2"],
		]);
	});
	it("withholds publication after final scope drift even when item membership matched", async () => {
		const f = fixture();
		f.getNativeMediaFolders
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValueOnce([library("library-1")])
			.mockResolvedValue([library("library-2")]);
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});
	it("bounds continual scope changes", async () => {
		const f = fixture();
		let discovery = 0;
		f.getNativeMediaFolders.mockImplementation(async () => [library(`library-${++discovery}`)]);
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(f.getNativeEpisodeItemsWithCoverage).toHaveBeenCalledTimes(3);
	});
	it.each([
		{ libraries: [library("same"), library("same")] },
		{ libraries: [library("")] },
		{ libraries: [library("bad\0id")] },
	])("rejects ambiguous folder identity", async (options) => {
		const f = fixture(options);
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(f.getNativeEpisodeItemsWithCoverage).not.toHaveBeenCalled();
	});
	it.each(["duplicate", "wrong type", "empty identity", "incomplete"])(
		"rejects %s page evidence",
		async (defect) => {
			const f = fixture();
			const result = page(
				defect === "duplicate"
					? [episode("same"), episode("same")]
					: [episode(defect === "empty identity" ? "" : "same")],
			);
			if (defect === "wrong type")
				result.items = [
					{ ...episode("same"), type: "Movie" } as unknown as JellyfinNativeEpisodeItem,
				];
			if (defect === "incomplete") result.expectedRawCount = 2;
			f.getNativeEpisodeItemsWithCoverage.mockResolvedValueOnce(result);
			expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
				complete: false,
				reason: "coverage-incomplete",
			});
		},
	);
	it.each(["getNativeMediaFolders", "getNativeEpisodeItemsWithCoverage"] as const)(
		"fails closed on %s errors without falling back to user views",
		async (method) => {
			const f = fixture();
			f[method].mockRejectedValueOnce(new Error("private provider failure"));
			expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
				complete: false,
				reason: "provider-unavailable",
			});
			expect(f.getUsers).not.toHaveBeenCalled();
			expect(f.getLibraries).not.toHaveBeenCalled();
		},
	);
	it("allows a later complete attempt after failed coverage", async () => {
		const f = fixture();
		f.getNativeEpisodeItemsWithCoverage.mockResolvedValueOnce({
			...page([episode("same")]),
			expectedRawCount: 2,
		});
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
		expect(await collectJellyfinNativeEpisodeInventory(f.client)).toMatchObject({ complete: true });
	});
});
