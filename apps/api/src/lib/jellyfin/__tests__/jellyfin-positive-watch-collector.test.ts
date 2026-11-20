import { describe, expect, it } from "vitest";
import type { JellyfinEpisodeItemsPage } from "../jellyfin-client.js";

const episode = (id: string, playCount = 1) => ({
	id,
	type: "Episode" as const,
	seriesId: "series-a",
	seasonNumber: 1,
	episodeNumber: id === "episode-a" ? 1 : 2,
	name: "Synthetic episode",
	played: true,
	playCount,
	lastPlayedDate: "2026-09-25T10:00:00Z",
});

const page = (
	items: JellyfinEpisodeItemsPage["items"],
	startIndex = 0,
	totalRecordCount = items.length,
): JellyfinEpisodeItemsPage => ({ items, startIndex, totalRecordCount });

async function collector() {
	const module = await import("../jellyfin-positive-watch-collector.js").catch(() => null);
	expect(module?.collectJellyfinPositiveWatchCandidates).toEqual(expect.any(Function));
	return module!.collectJellyfinPositiveWatchCandidates;
}

describe("Jellyfin watched-positive collector", () => {
	it("publishes only stable watched rows across two filtered passes", async () => {
		const collect = await collector();
		let calls = 0;
		const client = {
			getPlayedEpisodeItemsPageWithCoverage: async () => {
				calls += 1;
				return calls === 1
					? page([episode("episode-a"), episode("episode-b")])
					: page([episode("episode-a"), episode("episode-b", 2)]);
			},
		};
		const result = await collect(client, [{ userId: "user-a", libraryId: "library-a" }]);
		expect(result.scopeCount).toBe(1);
		expect(result.candidates).toEqual([
			expect.objectContaining({
				jellyfinId: "episode-a",
				libraryId: "library-a",
				played: true,
				playCount: 1,
			}),
		]);
		expect(calls).toBe(2);
	});

	it("accepts an empty positive set without claiming an unwatched row", async () => {
		const collect = await collector();
		const client = { getPlayedEpisodeItemsPageWithCoverage: async () => page([]) };
		const result = await collect(client, [{ userId: "user-a", libraryId: "library-a" }]);
		expect(result.candidates).toEqual([]);
		expect(result.scopeCount).toBe(1);
	});

	it("rejects a duplicate ID across filtered pages", async () => {
		const collect = await collector();
		const client = {
			getPlayedEpisodeItemsPageWithCoverage: async (
				_userId: string,
				_libraryId: string,
				startIndex: number,
			) => page([episode("episode-a")], startIndex, 2),
		};
		await expect(
			collect(client, [{ userId: "user-a", libraryId: "library-a" }], { pageSize: 1 }),
		).rejects.toThrow(/duplicate/i);
	});

	it("rejects a false played flag even if an injected client violates its filter contract", async () => {
		const collect = await collector();
		const client = {
			getPlayedEpisodeItemsPageWithCoverage: async () =>
				page([{ ...episode("episode-a"), played: false }]),
		};
		await expect(collect(client, [{ userId: "user-a", libraryId: "library-a" }])).rejects.toThrow(
			/unplayed/i,
		);
	});

	it("counts excluded raw positions against the cross-scope work bound", async () => {
		const collect = await collector();
		const client = {
			getPlayedEpisodeItemsPageWithCoverage: async (_userId: string, libraryId: string) =>
				libraryId === "library-a"
					? page([
							{ id: "excluded-a", type: "Episode", excludedReason: "missing-episode-metadata" },
						])
					: page([episode("episode-a")]),
		};
		await expect(
			collect(
				client,
				[
					{ userId: "user-a", libraryId: "library-a" },
					{ userId: "user-a", libraryId: "library-b" },
				],
				{ maxRowsPerPass: 1 },
			),
		).rejects.toThrow(/coverage|bound/i);
	});
});
