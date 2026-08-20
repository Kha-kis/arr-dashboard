import { describe, expect, it, vi } from "vitest";

type SelectedEpisodeRowsReader = (
	prisma: unknown,
	instanceId: string,
	showTmdbIds: number[],
	expectedConnectionGeneration: number,
	expectedIdentityGeneration: number,
) => Promise<
	Array<{ id: string; showTmdbId: number; seasonNumber: number; episodeNumber: number }>
>;

describe("Plex episode cache storage selection", () => {
	it("reads deduplicated show ids in generation-bound batches without unrelated rows", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const listRows = storage.listPlexEpisodeRowsForShows as SelectedEpisodeRowsReader | undefined;
		expect(listRows).toBeTypeOf("function");

		const findMany = vi.fn(async ({ where }: { where: { showTmdbId: { in: number[] } } }) =>
			where.showTmdbId.in.map((showTmdbId) => ({
				id: `row-${showTmdbId}`,
				showTmdbId,
				seasonNumber: 1,
				episodeNumber: 1,
			})),
		);
		const ids = [2, 1, 2, ...Array.from({ length: 500 }, (_, index) => index + 3)];

		const rows = await listRows!({ plexEpisodeCache: { findMany } }, "plex-1", ids, 4, 9);

		expect(findMany).toHaveBeenCalledTimes(3);
		expect(findMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: {
					instanceId: "plex-1",
					connectionGeneration: 4,
					identityGeneration: 9,
					showTmdbId: { in: [2, 1, ...Array.from({ length: 248 }, (_, index) => index + 3)] },
				},
			}),
		);
		expect(rows.map((row) => row.showTmdbId)).toEqual(
			Array.from({ length: 502 }, (_, index) => index + 1),
		);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects an unsafe selected show id (%s) before querying",
		async (showTmdbId) => {
			const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
			const listRows = storage.listPlexEpisodeRowsForShows as SelectedEpisodeRowsReader | undefined;
			expect(listRows).toBeTypeOf("function");
			const findMany = vi.fn();

			await expect(
				listRows!({ plexEpisodeCache: { findMany } }, "plex-1", [showTmdbId], 4, 9),
			).rejects.toThrow("positive safe integers");
			expect(findMany).not.toHaveBeenCalled();
		},
	);
});
