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

type PolicyBatchScanner = (
	prisma: unknown,
	instanceId: string,
	onBatch: (rows: ReadonlyArray<Record<string, unknown>>) => Promise<void> | void,
) => Promise<void>;

type EpisodeParentBatchScanner = (
	prisma: unknown,
	instanceId: string,
	onBatch: (rows: ReadonlyArray<Record<string, unknown>>) => Promise<void> | void,
) => Promise<void>;

type SelectedRowsReader = (
	prisma: unknown,
	instanceId: string,
	selection: { kind: "on-deck" | "recently-added"; limit: number },
) => Promise<Array<{ id: string }>>;

describe("Plex policy cache storage", () => {
	it("streams the fixed policy projection in id-cursor batches", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const scanRows = storage.scanPlexPolicyCacheRows as PolicyBatchScanner | undefined;
		expect(scanRows).toBeTypeOf("function");

		const firstBatch = Array.from({ length: 500 }, (_, index) => ({ id: `row-${index}` }));
		const secondBatch = [{ id: "row-500" }];
		const findMany = vi.fn().mockResolvedValueOnce(firstBatch).mockResolvedValueOnce(secondBatch);
		const received: Array<ReadonlyArray<Record<string, unknown>>> = [];
		await scanRows!({ plexCache: { findMany } }, "plex-1", (batch) => {
			received.push(batch);
		});

		expect(received).toEqual([firstBatch, secondBatch]);
		expect(findMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: { instanceId: "plex-1" },
				take: 500,
				orderBy: { id: "asc" },
				select: {
					id: true,
					instanceId: true,
					tmdbId: true,
					mediaType: true,
					sectionId: true,
					sectionTitle: true,
					ratingKey: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					collections: true,
					labels: true,
					addedAt: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			}),
		);
		expect(findMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: { instanceId: "plex-1" },
				take: 500,
				skip: 1,
				cursor: { id: "row-499" },
				orderBy: { id: "asc" },
			}),
		);
	});

	it("consumes a 20,000-row policy generation without retaining its rows", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const scanRows = storage.scanPlexPolicyCacheRows as PolicyBatchScanner | undefined;
		expect(scanRows).toBeTypeOf("function");

		let nextId = 0;
		const findMany = vi.fn(async () => {
			if (nextId >= 20_000) return [];
			return Array.from({ length: 500 }, () => ({ id: `row-${nextId++}` }));
		});
		let batchCount = 0;
		let observedRowCount = 0;
		let largestBatch = 0;
		await scanRows!({ plexCache: { findMany } }, "plex-1", (batch) => {
			batchCount += 1;
			observedRowCount += batch.length;
			largestBatch = Math.max(largestBatch, batch.length);
		});

		expect({ batchCount, observedRowCount, largestBatch }).toEqual({
			batchCount: 40,
			observedRowCount: 20_000,
			largestBatch: 500,
		});
	});

	it("streams watched series for episode-parent policy evidence with its fixed projection", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const scanRows = storage.scanPlexEpisodeParentPolicyRows as
			| EpisodeParentBatchScanner
			| undefined;
		expect(scanRows).toBeTypeOf("function");

		const findMany = vi.fn().mockResolvedValue([]);
		await scanRows!({ plexCache: { findMany } }, "plex-1", () => undefined);

		expect(findMany).toHaveBeenCalledWith({
			where: { instanceId: "plex-1", mediaType: "series", watchCount: { gt: 0 } },
			select: {
				id: true,
				instanceId: true,
				tmdbId: true,
				mediaType: true,
				ratingKey: true,
				lastWatchedAt: true,
				watchCount: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
			take: 500,
			orderBy: { id: "asc" },
		});
	});
});

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

describe("Plex bounded value selection", () => {
	it("applies the on-deck limit after canonical identity ordering", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const listRows = storage.listSelectedPlexCacheRows as SelectedRowsReader;
		const rows = [
			{ id: "db-a", sectionId: "2", mediaType: "movie", tmdbId: 2, ratingKey: "2", onDeck: true },
			{ id: "db-b", sectionId: "1", mediaType: "movie", tmdbId: 1, ratingKey: "1", onDeck: true },
		];
		const findMany = vi.fn().mockResolvedValueOnce(rows);

		const selected = await listRows({ plexCache: { findMany } }, "plex-1", {
			kind: "on-deck",
			limit: 1,
		});

		expect(selected.map((row) => row.id)).toEqual(["db-b"]);
		expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
	});

	it("uses canonical identity as the recently-added timestamp tie breaker", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const listRows = storage.listSelectedPlexCacheRows as SelectedRowsReader;
		const addedAt = new Date("2026-08-20T12:00:00.000Z");
		const rows = [
			{ id: "db-a", sectionId: "2", mediaType: "movie", tmdbId: 2, ratingKey: "2", addedAt },
			{ id: "db-b", sectionId: "1", mediaType: "movie", tmdbId: 1, ratingKey: "1", addedAt },
		];
		const findMany = vi.fn().mockResolvedValueOnce(rows);

		const selected = await listRows({ plexCache: { findMany } }, "plex-1", {
			kind: "recently-added",
			limit: 1,
		});

		expect(selected.map((row) => row.id)).toEqual(["db-b"]);
		expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
	});

	it("preserves newest-first recently-added response ordering", async () => {
		const storage = (await import("../plex-cache-storage.js")) as Record<string, unknown>;
		const listRows = storage.listSelectedPlexCacheRows as SelectedRowsReader;
		const rows = [
			{
				id: "older",
				sectionId: "1",
				mediaType: "movie",
				tmdbId: 1,
				ratingKey: "1",
				addedAt: new Date("2026-08-19T12:00:00.000Z"),
			},
			{
				id: "newer",
				sectionId: "2",
				mediaType: "movie",
				tmdbId: 2,
				ratingKey: "2",
				addedAt: new Date("2026-08-20T12:00:00.000Z"),
			},
		];
		const findMany = vi.fn().mockResolvedValueOnce(rows);

		const selected = await listRows({ plexCache: { findMany } }, "plex-1", {
			kind: "recently-added",
			limit: 2,
		});

		expect(selected.map((row) => row.id)).toEqual(["newer", "older"]);
	});
});
