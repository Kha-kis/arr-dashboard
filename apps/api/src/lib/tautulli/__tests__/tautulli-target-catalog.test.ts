import { describe, expect, it, vi } from "vitest";
import {
	collectStableTautulliTargetCatalog,
	TautulliEvidenceError,
} from "../tautulli-target-catalog.js";

const scope = {
	instanceId: "tautulli-1",
	generationId: "generation-1",
	connectionGeneration: 4,
	identityGeneration: 2,
};
const row = {
	section_id: "1",
	rating_key: "100",
	media_type: "movie",
	play_count: 0,
	last_played: null,
};
const metadata = {
	rating_key: "100",
	section_id: "1",
	media_type: "movie",
	guid: "plex://movie/provider-object-a",
	guids: ["tmdb://55"],
};

function client(overrides: Record<string, unknown> = {}) {
	return {
		getLibraries: vi
			.fn()
			.mockResolvedValue([
				{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
			]),
		refreshLibraryMediaInfo: vi.fn().mockResolvedValue(undefined),
		getLibraryMediaInfo: vi.fn().mockResolvedValue({
			data: [row],
			recordsFiltered: 1,
			recordsTotal: 1,
			last_refreshed: 1_777_000_000,
		}),
		getMetadata: vi.fn().mockResolvedValue(metadata),
		...overrides,
	};
}

describe("Tautulli target catalog", () => {
	it("collects two stable passes and never consults history for target membership", async () => {
		const upstream = client();
		const result = await collectStableTautulliTargetCatalog(upstream, scope);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			sectionId: "1",
			ratingKey: "100",
			tmdbId: 55,
			observedWatchCount: 0,
		});
		expect(upstream.refreshLibraryMediaInfo).toHaveBeenCalledTimes(2);
		expect(upstream.getLibraryMediaInfo).toHaveBeenCalledTimes(2);
		expect(result.sections).toEqual([{ sectionId: "1", sectionType: "movie", declaredCount: 1 }]);
		expect(upstream.getLibraries).toHaveBeenCalledTimes(2);
		expect(upstream).not.toHaveProperty("getHistory");
	});

	it.each([
		["stable truncation", "10", 9],
		["media total above declaration", "1", 2],
		["malformed declaration", "many", 1],
		["negative declaration", "-1", 1],
		["unsafe declaration", String(Number.MAX_SAFE_INTEGER + 1), 1],
	])("rejects %s before target-bound publication", async (_label, declaredCount, mediaTotal) => {
		const rows = Array.from({ length: mediaTotal }, (_, index) => ({
			...row,
			rating_key: String(100 + index),
		}));
		await expect(
			collectStableTautulliTargetCatalog(
				client({
					getLibraries: vi.fn().mockResolvedValue([
						{
							section_id: "1",
							section_name: "Movies",
							section_type: "movie",
							count: declaredCount,
						},
					]),
					getLibraryMediaInfo: vi.fn().mockResolvedValue({
						data: rows,
						recordsFiltered: mediaTotal,
						recordsTotal: mediaTotal,
						last_refreshed: 1,
					}),
					getMetadata: vi.fn(async (ratingKey: string) => ({
						...metadata,
						rating_key: ratingKey,
						guid: `plex://movie/${ratingKey}`,
						guids: [`tmdb://${ratingKey}`],
					})),
				}),
				scope,
			),
		).rejects.toMatchObject({ code: "catalog_total_mismatch" });
	});

	it("accepts an empty supported section only when declaration and media total are both zero", async () => {
		const upstream = client({
			getLibraries: vi.fn().mockResolvedValue([
				{
					section_id: "3",
					section_name: "Empty Movies",
					section_type: "movie",
					count: "0",
				},
			]),
			getLibraryMediaInfo: vi.fn().mockResolvedValue({
				data: [],
				recordsFiltered: 0,
				recordsTotal: 0,
				last_refreshed: null,
			}),
		});

		const result = await collectStableTautulliTargetCatalog(upstream, scope);

		expect(result.publicationLevel).toBe("authoritative");
		expect(result.observations).toEqual([]);
		expect(result.sections).toEqual([{ sectionId: "3", sectionType: "movie", declaredCount: 0 }]);
	});

	it("rejects a declared-count change without replacing the frozen manifest", async () => {
		const getLibraries = vi
			.fn()
			.mockResolvedValueOnce([
				{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
			])
			.mockResolvedValueOnce([
				{ section_id: "1", section_name: "Movies", section_type: "movie", count: "2" },
			]);

		await expect(
			collectStableTautulliTargetCatalog(client({ getLibraries }), scope),
		).rejects.toMatchObject({ code: "catalog_changed" });
	});

	it("rejects a second-pass media total that no longer matches the frozen declaration", async () => {
		const getLibraryMediaInfo = vi
			.fn()
			.mockResolvedValueOnce({
				data: [row],
				recordsFiltered: 1,
				recordsTotal: 1,
				last_refreshed: 1,
			})
			.mockResolvedValueOnce({
				data: [],
				recordsFiltered: 0,
				recordsTotal: 0,
				last_refreshed: 2,
			});

		await expect(
			collectStableTautulliTargetCatalog(client({ getLibraryMediaInfo }), scope),
		).rejects.toMatchObject({ code: "catalog_total_mismatch" });
	});

	it.each([null, undefined, "", -1, "not-a-count"])(
		"treats unavailable play count %s as UNKNOWN instead of zero",
		async (playCount) => {
			const unknownRow = { ...row, play_count: playCount };
			const upstream = client({
				getLibraryMediaInfo: vi.fn().mockResolvedValue({
					data: [unknownRow],
					recordsFiltered: 1,
					recordsTotal: 1,
					last_refreshed: 1,
				}),
			});

			await expect(
				collectStableTautulliTargetCatalog(upstream as never, scope),
			).rejects.toMatchObject({
				code: "observation_count_unavailable",
			});
		},
	);

	it("publishes only explicit positives when another mapped target count is unknown", async () => {
		const rows = [
			{ ...row, rating_key: "100", play_count: 2 },
			{ ...row, rating_key: "101", play_count: null },
		];
		const upstream = client({
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "2" },
				]),
			getLibraryMediaInfo: vi.fn().mockResolvedValue({
				data: rows,
				recordsFiltered: 2,
				recordsTotal: 2,
				last_refreshed: 1,
			}),
			getMetadata: vi.fn(async (ratingKey: string) => ({
				...metadata,
				rating_key: ratingKey,
				guid: `plex://movie/${ratingKey}`,
				guids: [`tmdb://${ratingKey}`],
			})),
		});

		const result = await collectStableTautulliTargetCatalog(upstream, scope);

		expect(result.publicationLevel).toBe("positive-only");
		expect(result.partialReasons).toEqual([{ code: "observation_count_unavailable", count: 1 }]);
		expect(result.observations).toEqual([
			expect.objectContaining({ ratingKey: "100", observedWatchCount: 2 }),
		]);
	});

	it.each([
		["duplicate", { data: [row, row], recordsFiltered: 2, recordsTotal: 2, last_refreshed: 1 }],
		[
			"wrong section",
			{
				data: [{ ...row, section_id: "2" }],
				recordsFiltered: 1,
				recordsTotal: 1,
				last_refreshed: 1,
			},
		],
		[
			"missing timestamp",
			{ data: [row], recordsFiltered: 1, recordsTotal: 1, last_refreshed: null },
		],
	])("rejects %s catalog pages", async (_name, page) => {
		await expect(
			collectStableTautulliTargetCatalog(
				client({ getLibraryMediaInfo: vi.fn().mockResolvedValue(page) }),
				scope,
			),
		).rejects.toBeInstanceOf(TautulliEvidenceError);
	});

	it("rejects changed rating keys and GUID fingerprints between passes", async () => {
		const upstream = client({
			getLibraryMediaInfo: vi
				.fn()
				.mockResolvedValueOnce({
					data: [row],
					recordsFiltered: 1,
					recordsTotal: 1,
					last_refreshed: 1,
				})
				.mockResolvedValueOnce({
					data: [{ ...row, rating_key: "101" }],
					recordsFiltered: 1,
					recordsTotal: 1,
					last_refreshed: 2,
				}),
			getMetadata: vi
				.fn()
				.mockResolvedValueOnce(metadata)
				.mockResolvedValueOnce({
					...metadata,
					rating_key: "101",
					guid: "plex://movie/provider-object-b",
				}),
		});
		await expect(collectStableTautulliTargetCatalog(upstream, scope)).rejects.toMatchObject({
			code: "catalog_changed",
		});
	});

	it("rejects provider GUID reuse for the same rating key between passes", async () => {
		const upstream = client({
			getMetadata: vi
				.fn()
				.mockResolvedValueOnce(metadata)
				.mockResolvedValueOnce({ ...metadata, guid: "plex://movie/reused-object" }),
		});

		await expect(collectStableTautulliTargetCatalog(upstream, scope)).rejects.toMatchObject({
			code: "catalog_changed",
		});
	});

	it("rejects canonical catalog content churn between passes", async () => {
		const upstream = client({
			getLibraryMediaInfo: vi
				.fn()
				.mockResolvedValueOnce({
					data: [row],
					recordsFiltered: 1,
					recordsTotal: 1,
					last_refreshed: 1,
				})
				.mockResolvedValueOnce({
					data: [{ ...row, play_count: 1 }],
					recordsFiltered: 1,
					recordsTotal: 1,
					last_refreshed: 2,
				}),
		});

		await expect(collectStableTautulliTargetCatalog(upstream, scope)).rejects.toMatchObject({
			code: "catalog_changed",
		});
	});

	it.each([
		["page total", { recordsFiltered: 252, recordsTotal: 252, last_refreshed: 1 }],
		["cache timestamp", { recordsFiltered: 251, recordsTotal: 251, last_refreshed: 2 }],
	])("rejects changed %s across catalog pages", async (_name, secondPage) => {
		const rows = Array.from({ length: 251 }, (_, index) => ({
			...row,
			rating_key: String(10_000 + index),
		}));
		const getLibraryMediaInfo = vi
			.fn()
			.mockResolvedValueOnce({
				data: rows.slice(0, 250),
				recordsFiltered: 251,
				recordsTotal: 251,
				last_refreshed: 1,
			})
			.mockResolvedValueOnce({ data: rows.slice(250), ...secondPage });

		await expect(
			collectStableTautulliTargetCatalog(client({ getLibraryMediaInfo }), scope),
		).rejects.toBeInstanceOf(TautulliEvidenceError);
	});

	it("rejects a catalog above the inclusive 20,000-target bound", async () => {
		await expect(
			collectStableTautulliTargetCatalog(
				client({
					getLibraryMediaInfo: vi.fn().mockResolvedValue({
						data: [],
						recordsFiltered: 20_001,
						recordsTotal: 20_001,
						last_refreshed: 1,
					}),
				}),
				scope,
			),
		).rejects.toMatchObject({ code: "catalog_total_mismatch" });
	});

	it("uses bounded metadata concurrency", async () => {
		const rows = Array.from({ length: 20 }, (_, index) => ({
			...row,
			rating_key: String(100 + index),
		}));
		let active = 0;
		let peak = 0;
		const upstream = client({
			getLibraries: vi.fn().mockResolvedValue([
				{
					section_id: "1",
					section_name: "Movies",
					section_type: "movie",
					count: String(rows.length),
				},
			]),
			getLibraryMediaInfo: vi.fn().mockResolvedValue({
				data: rows,
				recordsFiltered: rows.length,
				recordsTotal: rows.length,
				last_refreshed: 1,
			}),
			getMetadata: vi.fn(async (ratingKey: string) => {
				active++;
				peak = Math.max(peak, active);
				await Promise.resolve();
				active--;
				return {
					...metadata,
					rating_key: ratingKey,
					guid: `plex://movie/${ratingKey}`,
					guids: [`tmdb://${ratingKey}`],
				};
			}),
		});
		await collectStableTautulliTargetCatalog(upstream, scope);
		expect(peak).toBeLessThanOrEqual(6);
	});

	it("collects a stable 433-target reporter-class catalog across bounded pages", async () => {
		const rows = Array.from({ length: 433 }, (_, index) => ({
			...row,
			rating_key: String(10_000 + index),
		}));
		const getLibraryMediaInfo = vi.fn(
			async ({ start, length }: { start: number; length: number }) => ({
				data: rows.slice(start, start + length),
				recordsFiltered: rows.length,
				recordsTotal: rows.length,
				last_refreshed: 1_777_000_000,
			}),
		);
		const getMetadata = vi.fn(async (ratingKey: string) => ({
			...metadata,
			rating_key: ratingKey,
			guid: `plex://movie/${ratingKey}`,
			guids: [`tmdb://${ratingKey}`],
		}));
		const upstream = client({
			getLibraries: vi.fn().mockResolvedValue([
				{
					section_id: "1",
					section_name: "Movies",
					section_type: "movie",
					count: String(rows.length),
				},
			]),
			getLibraryMediaInfo,
			getMetadata,
		});

		const result = await collectStableTautulliTargetCatalog(upstream, scope);

		expect(result.publicationLevel).toBe("authoritative");
		expect(result.observations).toHaveLength(433);
		expect(getLibraryMediaInfo).toHaveBeenCalledTimes(4);
		expect(getLibraryMediaInfo).toHaveBeenNthCalledWith(1, {
			sectionId: "1",
			start: 0,
			length: 250,
		});
		expect(getLibraryMediaInfo).toHaveBeenNthCalledWith(2, {
			sectionId: "1",
			start: 250,
			length: 250,
		});
		expect(getMetadata).toHaveBeenCalledTimes(866);
	});

	it("retains only proven positive observations when one target is unmapped", async () => {
		const rows = [
			{ ...row, rating_key: "100", play_count: 2 },
			{ ...row, rating_key: "101", play_count: 0 },
		];
		const upstream = client({
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "2" },
				]),
			getLibraryMediaInfo: vi.fn().mockResolvedValue({
				data: rows,
				recordsFiltered: 2,
				recordsTotal: 2,
				last_refreshed: 1,
			}),
			getMetadata: vi.fn(async (ratingKey: string) =>
				ratingKey === "100"
					? { ...metadata, rating_key: ratingKey }
					: { ...metadata, rating_key: ratingKey, guid: `plex://movie/${ratingKey}`, guids: [] },
			),
		});

		const result = await collectStableTautulliTargetCatalog(upstream, scope);

		expect(result.publicationLevel).toBe("positive-only");
		expect(result.partialReasons).toEqual([{ code: "metadata_tmdb_unmapped", count: 1 }]);
		expect(result.observations).toEqual([
			expect.objectContaining({ ratingKey: "100", observedWatchCount: 2 }),
		]);
	});

	it("retains only proven positive observations when one metadata request is unavailable", async () => {
		const rows = [
			{ ...row, rating_key: "100", play_count: 2 },
			{ ...row, rating_key: "101", play_count: 0 },
		];
		const upstream = client({
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ section_id: "1", section_name: "Movies", section_type: "movie", count: "2" },
				]),
			getLibraryMediaInfo: vi.fn().mockResolvedValue({
				data: rows,
				recordsFiltered: 2,
				recordsTotal: 2,
				last_refreshed: 1,
			}),
			getMetadata: vi.fn(async (ratingKey: string) => {
				if (ratingKey === "101") throw new Error("private upstream detail");
				return { ...metadata, rating_key: ratingKey };
			}),
		});

		const result = await collectStableTautulliTargetCatalog(upstream, scope);

		expect(result.publicationLevel).toBe("positive-only");
		expect(result.partialReasons).toEqual([{ code: "metadata_unavailable", count: 1 }]);
		expect(result.observations).toEqual([
			expect.objectContaining({ ratingKey: "100", observedWatchCount: 2 }),
		]);
	});
});
