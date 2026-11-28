import { describe, expect, it, vi } from "vitest";
import { createJellyfinNativeEpisodeJobAdapter } from "../jellyfin-native-episode-inventory.js";

describe("Jellyfin durable native episode adapter", () => {
	it("stages native presence while leaving missing coordinates unknown", async () => {
		const getNativeMediaFolders = vi
			.fn()
			.mockResolvedValue([
				{ id: "library-1", name: "Synthetic library", collectionType: "tvshows" },
			]);
		const readNativeInventoryPage = vi.fn().mockResolvedValue({
			status: "page",
			domain: "episode",
			startIndex: 0,
			totalRecordCount: 2,
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "Synthetic 1",
					seriesId: "series-1",
					seasonNumber: 2,
					episodeNumber: 3,
				},
				{
					id: "episode-2",
					type: "Episode",
					name: "Synthetic 2",
					seriesId: "series-1",
					episodeNumber: 4,
				},
			],
		});
		const adapter = createJellyfinNativeEpisodeJobAdapter({
			getNativeMediaFolders,
			readNativeInventoryPage,
		});
		const deadlineAt = Date.now() + 5_000;
		const discovery = await adapter.discoverScopes(deadlineAt);
		expect(discovery).toEqual({
			status: "ready",
			catalogIdentity: '[["library:library-1","tvshows"]]',
			scopes: [
				{ libraryId: "library-1", collectionType: "tvshows", scopeKey: "library:library-1" },
			],
		});
		if (discovery.status !== "ready") return;
		expect(await adapter.readPage(discovery.scopes[0]!, 0, 2, deadlineAt)).toEqual({
			status: "page",
			domain: "episode",
			scopeKey: "library:library-1",
			startIndex: 0,
			totalRecordCount: 2,
			rawNativeIds: ["episode-1", "episode-2"],
			comparisonKeys: ["Episode", "Episode"],
			rows: [
				{
					nativeId: "episode-1",
					mediaType: "episode",
					libraryIds: ["library-1"],
					parentNativeId: "series-1",
					seasonNumber: 2,
					episodeNumber: 3,
					title: "Synthetic 1",
				},
				{
					nativeId: "episode-2",
					mediaType: "episode",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Synthetic 2",
				},
			],
		});
		expect(readNativeInventoryPage).toHaveBeenCalledWith({
			domain: "episode",
			libraryId: "library-1",
			startIndex: 0,
			limit: 2,
			deadlineAt,
		});
	});
});
