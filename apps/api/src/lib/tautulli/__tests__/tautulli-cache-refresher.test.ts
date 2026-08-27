import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectTautulliCacheLiveEvidence,
	summarizeTautulliRefreshResultForLog,
	type TautulliCacheRefreshResult,
} from "../tautulli-cache-refresher.js";
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
		section_id: "1",
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
		section_id: "1",
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
		expect(result).toMatchObject({
			kind: "published-authoritative",
			complete: true,
			errors: 0,
			generationId: "generation-1",
		});
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
			kind: "published-positive",
			complete: false,
			publicationLevel: "positive-only",
			reasonCodes: ["metadata_tmdb_unmapped"],
		});
		expect(result.snapshot?.exactObservations).toEqual([
			expect.objectContaining({ ratingKey: "100", observedWatchCount: 2 }),
		]);
		expect(JSON.stringify(result.snapshot)).not.toContain('"ratingKey":"101"');
	});

	it("uses the catalog's frozen section manifest for both history passes", async () => {
		const frozenLibraries = [
			{ section_id: "1", section_name: "Movies", section_type: "movie", count: "1" },
			{ section_id: "2", section_name: "Shows", section_type: "show", count: "1" },
		];
		const laterIncompleteLibraries = [frozenLibraries[0]!];
		const getLibraries = vi
			.fn()
			.mockResolvedValueOnce(frozenLibraries)
			.mockResolvedValueOnce(frozenLibraries)
			.mockResolvedValue(laterIncompleteLibraries);
		const sectionRows = {
			"1": [catalog[0]!],
			"2": [
				{
					section_id: "2",
					rating_key: "200",
					media_type: "show",
					play_count: 1,
					last_played: null,
				},
			],
		};
		const getHistory = vi.fn(async ({ section_id }: { section_id: string }) => ({
			data:
				section_id === "1"
					? [{ ...history[0]!, section_id: "1" }]
					: [
							{
								...history[0]!,
								section_id: "2",
								row_id: 2,
								media_type: "episode",
								rating_key: "episode-200",
								parent_rating_key: "season-200",
								grandparent_rating_key: "200",
							},
						],
			recordsFiltered: 1,
			recordsTotal: 1,
		}));
		const upstream = client({
			getLibraries,
			getLibraryMediaInfo: vi.fn(async ({ sectionId }: { sectionId: "1" | "2" }) => ({
				data: sectionRows[sectionId],
				recordsFiltered: 1,
				recordsTotal: 1,
				last_refreshed: 1,
			})),
			getMetadata: vi.fn(async (ratingKey: string) => ({
				rating_key: ratingKey,
				section_id: ratingKey === "200" ? "2" : "1",
				media_type: ratingKey === "200" ? "show" : "movie",
				guid: `plex://${ratingKey === "200" ? "show" : "movie"}/${ratingKey}`,
				guids: [`tmdb://${ratingKey === "200" ? 77 : 55}`],
			})),
			getHistory,
		});

		const result = await collectTautulliCacheLiveEvidence(upstream, "tautulli-1", log, scope);

		expect(result.kind).toBe("published-authoritative");
		expect(getLibraries).toHaveBeenCalledTimes(2);
		expect(getHistory).toHaveBeenCalledTimes(4);
		expect(getHistory.mock.calls.map(([input]) => input.section_id)).toEqual(["1", "2", "1", "2"]);
		expect(result.snapshot?.exactObservations.map((item) => item.ratingKey)).toEqual([
			"100",
			"200",
		]);
	});

	it("fails closed when frozen-section history is unavailable", async () => {
		const getHistory = vi.fn().mockRejectedValue(new Error("private section failure"));
		const result = await collectTautulliCacheLiveEvidence(
			client({ getHistory }),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({ kind: "unpublished", reasonCodes: ["history_partial"] });
		expect(JSON.stringify(logWarn.mock.calls)).not.toContain("private section failure");
	});

	it("rejects history rows outside the frozen section instead of inferring empty users", async () => {
		const getHistory = vi.fn().mockResolvedValue({
			data: [{ ...history[0]!, section_id: "999" }],
			recordsFiltered: 1,
			recordsTotal: 1,
		});
		const result = await collectTautulliCacheLiveEvidence(
			client({ getHistory }),
			"tautulli-1",
			log,
			scope,
		);
		expect(result).toMatchObject({ kind: "unpublished", reasonCodes: ["history_partial"] });
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

describe("Tautulli refresh log projection", () => {
	it.each([
		["published-authoritative", "authoritative", true],
		["published-positive", "positive-only", false],
		["unpublished", undefined, false],
		["superseded", undefined, false],
	] as const)("projects %s through one bounded allowlist", (kind, publicationLevel, complete) => {
		const result = {
			kind,
			publicationLevel,
			complete,
			upserted: 1,
			errors: kind === "unpublished" ? 1 : 0,
			errorMessages: ["raw-upstream-error-canary"],
			reasonCodes: kind === "unpublished" ? ["unknown_failure"] : [],
			partialReasons:
				kind === "published-positive" ? [{ code: "observation_count_unavailable", count: 1 }] : [],
			superseded: kind === "superseded",
			snapshot: {
				rows: [
					{
						instanceId: "instance-canary",
						generationId: "generation-canary",
						tmdbId: 987_654,
						mediaType: "movie",
						lastWatchedAt: null,
						watchCount: 1,
						watchedByUsers: '["username-canary"]',
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				],
				exactObservations: [
					{
						instanceId: "instance-canary",
						generationId: "generation-canary",
						sectionId: "section-canary",
						ratingKey: "rating-key-canary",
						providerGuidFingerprint: "guid-canary",
						mediaType: "movie",
						tmdbId: 987_654,
						observedWatchCount: 1,
						lastWatchedAt: null,
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				],
			},
			providerPayload: {
				title: "title-canary",
				url: "https://url-canary.invalid",
				token: "token-canary",
			},
		} as TautulliCacheRefreshResult;

		const summary = summarizeTautulliRefreshResultForLog(result);

		expect(Object.keys(summary).sort()).toEqual(
			[
				"aggregateObservedCount",
				"complete",
				"errors",
				"partialReasonCount",
				"publicationLevel",
				"publishedObservationCount",
				"reasonCodes",
				"superseded",
				"terminalKind",
				"upserted",
			].sort(),
		);
		expect(JSON.stringify(summary)).not.toMatch(
			/title-canary|username-canary|section-canary|rating-key-canary|987654|guid-canary|url-canary|token-canary|raw-upstream-error-canary|generation-canary/,
		);
	});
});
