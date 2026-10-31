import { describe, expect, it, vi } from "vitest";
import { createJellyfinNativeLibraryJobAdapter } from "../jellyfin-native-inventory.js";

describe("Jellyfin durable native library adapter", () => {
	it("keeps filtered containers in raw coverage while staging only native media", async () => {
		const getNativeMediaFolders = vi.fn().mockResolvedValue([
			{ id: "library-1", name: "Synthetic library", collectionType: "movies" },
			{ id: "playlist-1", name: "Synthetic playlist", collectionType: "playlists" },
		]);
		const readNativeInventoryPage = vi.fn().mockResolvedValue({
			status: "page",
			domain: "library",
			startIndex: 0,
			totalRecordCount: 2,
			items: [
				{ id: "movie-1", type: "Movie", name: "Synthetic movie", externalIds: { tmdb: [101] } },
				{ id: "box-1", type: "BoxSet", name: "Synthetic box" },
			],
		});
		const adapter = createJellyfinNativeLibraryJobAdapter({
			getNativeMediaFolders,
			readNativeInventoryPage,
		});
		const deadlineAt = Date.now() + 5_000;
		const discovery = await adapter.discoverScopes(deadlineAt);
		expect(discovery).toEqual({
			status: "ready",
			catalogIdentity: '[["library:library-1","movies"]]',
			scopes: [{ libraryId: "library-1", collectionType: "movies", scopeKey: "library:library-1" }],
		});
		if (discovery.status !== "ready") return;
		const result = await adapter.readPage(discovery.scopes[0]!, 0, 2, deadlineAt);
		expect(result).toEqual({
			status: "page",
			domain: "library",
			scopeKey: "library:library-1",
			startIndex: 0,
			totalRecordCount: 2,
			rawNativeIds: ["movie-1", "box-1"],
			comparisonKeys: ['["Movie",[]]', null],
			rows: [
				{
					nativeId: "movie-1",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Synthetic movie",
					externalIds: { tmdb: [101] },
				},
			],
		});
		expect(getNativeMediaFolders).toHaveBeenCalledTimes(1);
		expect(readNativeInventoryPage).toHaveBeenCalledWith({
			domain: "library",
			libraryId: "library-1",
			includeItemTypes: "Movie",
			startIndex: 0,
			limit: 2,
			deadlineAt,
		});
	});
});
