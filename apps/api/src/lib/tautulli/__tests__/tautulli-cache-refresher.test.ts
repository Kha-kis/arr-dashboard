import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectTautulliCacheLiveEvidence } from "../tautulli-cache-refresher.js";
import type { TautulliClient } from "../tautulli-client.js";

const logWarn = vi.fn();
const log = {
	warn: logWarn,
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

const scope = { generationId: "generation-1", connectionGeneration: 4, identityGeneration: 2 };
const libraries = [{ section_id: "1", section_name: "Movies", section_type: "movie", count: "2" }];
const catalog = [
	{
		section_id: "1",
		rating_key: "100",
		media_type: "movie",
		play_count: 2,
		last_played: 1_777_000_000,
	},
	{ section_id: "1", rating_key: "101", media_type: "movie", play_count: 0, last_played: null },
];
const history = [
	{
		row_id: 1,
		rating_key: "100",
		parent_rating_key: "",
		grandparent_rating_key: "",
		title: "Sensitive",
		grandparent_title: "",
		media_type: "movie",
		user: "alice",
		date: 1_777_000_000,
		play_count: 1,
	},
	{
		row_id: 2,
		rating_key: "history-only",
		parent_rating_key: "",
		grandparent_rating_key: "",
		title: "History only",
		grandparent_title: "",
		media_type: "movie",
		user: "mallory",
		date: 1_777_000_001,
		play_count: 1,
	},
];

function client(overrides: Record<string, unknown> = {}): TautulliClient {
	return {
		getLibraries: vi.fn().mockResolvedValue(libraries),
		refreshLibraryMediaInfo: vi.fn().mockResolvedValue(undefined),
		getLibraryMediaInfo: vi.fn().mockResolvedValue({
			data: catalog,
			recordsFiltered: 2,
			recordsTotal: 2,
			last_refreshed: 1_777_000_100,
		}),
		getMetadata: vi.fn(async (ratingKey: string) => ({
			rating_key: ratingKey,
			section_id: "1",
			media_type: "movie",
			guid: `plex://movie/${ratingKey}`,
			guids: [`tmdb://${ratingKey === "100" ? 55 : 56}`],
			title: "",
		})),
		getHistory: vi.fn().mockResolvedValue({ data: history, recordsFiltered: 2, recordsTotal: 2 }),
		...overrides,
	} as unknown as TautulliClient;
}

describe("Tautulli exact-evidence refresh collection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("publishes catalog targets and ignores history-only target existence", async () => {
		const result = await collectTautulliCacheLiveEvidence(client(), "tautulli-1", log, scope);
		expect(result).toMatchObject({ complete: true, errors: 0, generationId: "generation-1" });
		expect(result.snapshot?.exactObservations.map((row) => row.ratingKey)).toEqual(["100", "101"]);
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				tmdbId: 55,
				watchCount: 2,
				watchedByUsers: '["alice"]',
				generationId: "generation-1",
			}),
			expect.objectContaining({
				tmdbId: 56,
				watchCount: 0,
				watchedByUsers: "[]",
				generationId: "generation-1",
			}),
		]);
		expect(JSON.stringify(result.snapshot)).not.toContain("mallory");
	});

	it("collapses duplicate TMDB targets only in the aggregate while preserving exact rows", async () => {
		const duplicateCatalog = [catalog[0]!, { ...catalog[1]!, rating_key: "102", play_count: 3 }];
		const result = await collectTautulliCacheLiveEvidence(
			client({
				getLibraryMediaInfo: vi.fn().mockResolvedValue({
					data: duplicateCatalog,
					recordsFiltered: 2,
					recordsTotal: 2,
					last_refreshed: 1,
				}),
				getMetadata: vi.fn(async (ratingKey: string) => ({
					rating_key: ratingKey,
					section_id: "1",
					media_type: "movie",
					guid: `plex://movie/${ratingKey}`,
					guids: ["tmdb://55"],
				})),
			}),
			"tautulli-1",
			log,
			scope,
		);
		expect(result.snapshot?.exactObservations).toHaveLength(2);
		expect(result.snapshot?.rows).toEqual([expect.objectContaining({ tmdbId: 55, watchCount: 5 })]);
	});

	it("fails closed with a bounded reason when exact metadata is unmapped", async () => {
		const result = await collectTautulliCacheLiveEvidence(
			client({
				getMetadata: vi.fn(async (ratingKey: string) => ({
					rating_key: ratingKey,
					section_id: "1",
					media_type: "movie",
					guid: `plex://movie/${ratingKey}`,
					guids: [],
				})),
			}),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({
			complete: false,
			errors: 1,
			reasonCodes: ["metadata_tmdb_unmapped"],
			errorMessages: ["metadata_tmdb_unmapped"],
		});
		expect(JSON.stringify(result)).not.toContain("100");
		expect(JSON.stringify(logWarn.mock.calls)).not.toMatch(
			/100|plex:\/\/movie|Sensitive|tmdb:\/\//,
		);
	});

	it("returns an inert positive-only snapshot without turning missing rows into zero", async () => {
		const partialCatalog = [
			{ ...catalog[0]!, play_count: 2 },
			{ ...catalog[1]!, play_count: 0 },
		];
		const result = await collectTautulliCacheLiveEvidence(
			client({
				getLibraryMediaInfo: vi.fn().mockResolvedValue({
					data: partialCatalog,
					recordsFiltered: 2,
					recordsTotal: 2,
					last_refreshed: 1,
				}),
				getMetadata: vi.fn(async (ratingKey: string) => ({
					rating_key: ratingKey,
					section_id: "1",
					media_type: "movie",
					guid: `plex://movie/${ratingKey}`,
					guids: ratingKey === "100" ? ["tmdb://55"] : [],
				})),
			}),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({
			complete: false,
			publicationLevel: "positive-only",
			reasonCodes: ["metadata_tmdb_unmapped"],
		});
		expect(result.snapshot?.exactObservations).toEqual([
			expect.objectContaining({ ratingKey: "100", observedWatchCount: 2 }),
		]);
		expect(JSON.stringify(result.snapshot)).not.toContain('"ratingKey":"101"');
	});

	it("rejects history churn between the two verification passes", async () => {
		const getHistory = vi
			.fn()
			.mockResolvedValueOnce({ data: history, recordsFiltered: 2, recordsTotal: 2 })
			.mockResolvedValueOnce({
				data: [{ ...history[0]!, user: "changed" }, history[1]],
				recordsFiltered: 2,
				recordsTotal: 2,
			});
		const result = await collectTautulliCacheLiveEvidence(
			client({ getHistory }),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({ complete: false, reasonCodes: ["history_changed"] });
	});

	it("paginates reporter-scale history without an unbounded read", async () => {
		const rows = Array.from({ length: 7_787 }, (_, index) => ({
			...history[0]!,
			row_id: index + 1,
			date: 1_777_000_000 + index,
		}));
		const getHistory = vi.fn(async ({ start, length }: { start: number; length: number }) => ({
			data: rows.slice(start, start + length),
			recordsFiltered: rows.length,
			recordsTotal: rows.length,
		}));
		const result = await collectTautulliCacheLiveEvidence(
			client({ getHistory }),
			"tautulli-1",
			log,
			scope,
		);
		expect(result.complete).toBe(true);
		expect(getHistory).toHaveBeenCalledTimes(Math.ceil(rows.length / 200) * 2);
		expect(getHistory).toHaveBeenCalledWith(
			expect.objectContaining({ length: 200, grouping: 0, order_column: "row_id" }),
		);
	});

	it("rejects grouped or unstable history rows without raw details", async () => {
		const invalid = [
			{ ...history[0]!, row_id: 1 },
			{ ...history[1]!, row_id: 1 },
		];
		const result = await collectTautulliCacheLiveEvidence(
			client({
				getHistory: vi
					.fn()
					.mockResolvedValue({ data: invalid, recordsFiltered: 2, recordsTotal: 2 }),
			}),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({ complete: false, reasonCodes: ["history_changed"] });
	});

	it.each([
		["unsupported media type", { ...history[0]!, media_type: "track" }],
		["missing movie key", { ...history[0]!, rating_key: "" }],
		[
			"missing episode parent key",
			{
				...history[0]!,
				media_type: "episode",
				rating_key: "episode-1",
				parent_rating_key: "",
				grandparent_rating_key: "100",
			},
		],
	])("rejects %s with a bounded history reason", async (_name, malformed) => {
		const result = await collectTautulliCacheLiveEvidence(
			client({
				getHistory: vi.fn().mockResolvedValue({
					data: [malformed],
					recordsFiltered: 1,
					recordsTotal: 1,
				}),
			}),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({ complete: false, reasonCodes: ["history_partial"] });
	});
});
