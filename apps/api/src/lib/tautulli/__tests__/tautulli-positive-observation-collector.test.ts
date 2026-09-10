import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import { decodeTautulliObservationMetadata } from "../tautulli-observation-metadata.js";
import {
	collectTautulliPositiveObservations,
	TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE,
	TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS,
	TAUTULLI_OBSERVATION_MAX_RAW_ROWS,
	TAUTULLI_OBSERVATION_METADATA_BATCH_SIZE,
	TAUTULLI_OBSERVATION_METADATA_DEADLINE_MS,
	TAUTULLI_OBSERVATION_WINDOW_MS,
	type TautulliPositiveObservationClient,
	type TautulliPositiveObservationOptions,
} from "../tautulli-positive-observation-collector.js";

const INSTANCE_ID = "instance-synthetic";
const ATTEMPT_STARTED_AT = new Date("2026-09-03T11:45:00.000Z");
const WINDOW_ENDED_AT = new Date("2026-09-03T12:00:00.000Z");
const WINDOW_STARTED_AT = new Date(WINDOW_ENDED_AT.getTime() - TAUTULLI_OBSERVATION_WINDOW_MS);

function library(section_id = "1", section_type: string = "movie") {
	return { section_id, section_name: `Library ${section_id}`, section_type };
}

function movie(overrides: Record<string, unknown> = {}) {
	return {
		row_id: 20,
		rating_key: "movie-key",
		parent_rating_key: "",
		grandparent_rating_key: "",
		title: "Movie",
		grandparent_title: "",
		media_type: "movie",
		user: "Alice",
		date: Math.floor(new Date("2026-09-03T11:55:00.000Z").getTime() / 1000),
		play_count: 1,
		group_count: 1,
		...overrides,
	};
}

function episode(overrides: Record<string, unknown> = {}) {
	return {
		row_id: 19,
		rating_key: "episode-key",
		parent_rating_key: "parent-key",
		grandparent_rating_key: "show-key",
		title: "Episode",
		grandparent_title: "Show",
		media_type: "episode",
		user: "Bob",
		date: Math.floor(new Date("2026-09-03T11:56:00.000Z").getTime() / 1000),
		play_count: 1,
		group_count: 1,
		...overrides,
	};
}

function history(data: unknown[], overrides: Record<string, unknown> = {}) {
	return { data, recordsFiltered: data.length, recordsTotal: data.length, ...overrides };
}

function pagedHistory(
	rows: unknown[],
	params: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	const start = Number(params.start ?? 0);
	const page = rows.slice(start, start + TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE);
	return history(page, { recordsFiltered: rows.length, recordsTotal: rows.length, ...overrides });
}

function metadata(tmdbId = 42, overrides: Record<string, unknown> = {}) {
	return { guids: [`tmdb://${tmdbId}`], media_type: "movie", ...overrides };
}

function client(
	options: {
		libraries?: unknown;
		history?: unknown[];
		metadataByKey?: Record<string, unknown>;
		getHistory?: (params: Record<string, unknown>) => unknown;
		getMetadata?: (ratingKey: string, signal: AbortSignal) => unknown;
	} = {},
): TautulliPositiveObservationClient & {
	getLibraries: ReturnType<typeof vi.fn>;
	getHistory: ReturnType<typeof vi.fn>;
	getMetadata: ReturnType<typeof vi.fn>;
} {
	const libraries = options.libraries ?? [library()];
	const historyRows = options.history ?? [movie()];
	return {
		getLibraries: vi.fn().mockResolvedValue(libraries),
		getHistory: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
			if (options.getHistory) return options.getHistory(params);
			return history(historyRows);
		}),
		getMetadata: vi.fn().mockImplementation(async (ratingKey: string, signal: AbortSignal) => {
			if (options.getMetadata) return options.getMetadata(ratingKey, signal);
			return options.metadataByKey?.[ratingKey] ?? metadata();
		}),
	};
}

async function collect(
	service: TautulliPositiveObservationClient,
	options: TautulliPositiveObservationOptions & { now?: () => Date; attemptStartedAt?: Date } = {},
) {
	return collectTautulliPositiveObservations(service, {
		instanceId: INSTANCE_ID,
		attemptStartedAt: options.attemptStartedAt ?? ATTEMPT_STARTED_AT,
		now: options.now ?? (() => WINDOW_ENDED_AT),
		metadataBatchSize: options.metadataBatchSize,
		metadataDeadlineMs: options.metadataDeadlineMs,
		monotonicNow: options.monotonicNow,
	});
}

describe("collectTautulliPositiveObservations", () => {
	it("collects one recent movie into one conserved positive-only unit", async () => {
		const tautulli = client();
		const result = await collect(tautulli);

		expect(result.rows).toEqual([
			{
				instanceId: INSTANCE_ID,
				tmdbId: 42,
				mediaType: "movie",
				lastWatchedAt: new Date("2026-09-03T11:55:00.000Z"),
				watchCount: 1,
				watchedByUsers: '["Alice"]',
			},
		]);
		expect(result.rows[0]?.watchedByUsers.length).toBeLessThanOrEqual(100_000);
		expect(result.windowStartedAt).toEqual(WINDOW_STARTED_AT);
		expect(result.windowEndedAt).toEqual(WINDOW_ENDED_AT);
		expect(result.receipt).toMatchObject({
			version: 1,
			provider: "tautulli",
			evidence: "positive-only",
			attemptStartedAt: ATTEMPT_STARTED_AT.toISOString(),
			observedAt: WINDOW_ENDED_AT.toISOString(),
			publishedCanonicalEntities: 1,
			units: [
				{
					scopeKey: "library:1",
					expectedRawCount: null,
					rawObserved: 1,
					sourceBindings: 1,
					canonicalEntities: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					fatalCount: 0,
				},
			],
		});
		expect(evaluateProviderCoverageReceipt(result.receipt)).toMatchObject({
			valid: true,
			evidence: "positive-only",
		});
	});

	it("aggregates plays deterministically across libraries and canonical keys", async () => {
		const tautulli = client({
			libraries: [library("2", "show"), library("3"), library("1")],
			getHistory: (params) =>
				params.section_id === "1"
					? history([
							movie({
								row_id: 30,
								user: "Bob",
								date: Math.floor(new Date("2026-09-03T11:58:00.000Z").getTime() / 1000),
							}),
							movie({ row_id: 29, user: "Alice" }),
						])
					: params.section_id === "2"
						? history([episode({ row_id: 18, user: "Alice" })])
						: history([movie({ row_id: 17, user: "Carol", rating_key: "movie-key-2" })]),
			metadataByKey: {
				"movie-key": metadata(42),
				"movie-key-2": metadata(42),
				"show-key": metadata(42),
			},
		});

		const result = await collect(tautulli);

		expect(result.rows).toHaveLength(2);
		expect(result.rows).toEqual([
			expect.objectContaining({
				mediaType: "movie",
				tmdbId: 42,
				watchCount: 3,
				watchedByUsers: '["Alice","Bob","Carol"]',
			}),
			expect.objectContaining({
				mediaType: "series",
				tmdbId: 42,
				watchCount: 1,
				watchedByUsers: '["Alice"]',
			}),
		]);
		expect(
			result.receipt.units.map((unit) => [
				unit.scopeKey,
				unit.canonicalEntities,
				unit.sourceBindings,
			]),
		).toEqual([
			["library:1", 1, 2],
			["library:2", 1, 1],
			["library:3", 1, 1],
		]);
	});

	it("returns a valid zero-row result only after querying a supported library", async () => {
		const tautulli = client({ history: [] });
		const result = await collect(tautulli);

		expect(result.rows).toEqual([]);
		expect(result.receipt.publishedCanonicalEntities).toBe(0);
		expect(result.receipt.units).toHaveLength(1);
		expect(result.receipt.units[0]).toMatchObject({
			rawObserved: 0,
			sourceBindings: 0,
			canonicalEntities: 0,
		});
	});

	it("uses one clock capture and fixed newest-first requests", async () => {
		const tautulli = client({ history: [] });
		const now = vi.fn(() => WINDOW_ENDED_AT);
		await collect(tautulli, { now });

		expect(now).toHaveBeenCalledOnce();
		expect(tautulli.getHistory).toHaveBeenCalledWith({
			section_id: "1",
			length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE,
			start: 0,
			order_column: "row_id",
			order_dir: "desc",
			grouping: 0,
			include_activity: 0,
		});
	});

	it("uses first-page high-water ids and deduplicates overlap without cross-library collision", async () => {
		const tautulli = client({
			libraries: [library("1"), library("2")],
			getHistory: (params) =>
				params.start === 0
					? history(
							[
								movie({ row_id: 20 }),
								...Array.from({ length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE - 1 }, () =>
									movie({ row_id: 19 }),
								),
							],
							{ recordsFiltered: 5, recordsTotal: 5 },
						)
					: history([movie({ row_id: 22 }), movie({ row_id: 20 }), movie({ row_id: 18 })], {
							recordsTotal: 5,
						}),
		});
		const result = await collect(tautulli);

		expect(result.receipt.units).toHaveLength(2);
		expect(result.receipt.units.map((unit) => unit.rawObserved)).toEqual([3, 3]);
		expect(tautulli.getHistory).toHaveBeenCalledTimes(4);
	});

	it("rejects whitespace and duplicate supported library sections", async () => {
		await expect(
			collect(client({ libraries: [library(" 2 "), library("1")] })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () => history([movie({ row_id: 20 }), movie({ row_id: 20, group_count: 2 })]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(client({ libraries: [library("1"), library("1", "show")] })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("accepts changing totals and ignores rows outside the fixed event window", async () => {
		const tautulli = client({
			getHistory: () =>
				history(
					[
						movie({ date: Math.floor(WINDOW_STARTED_AT.getTime() / 1000), row_id: 30 }),
						movie({ date: Math.floor(WINDOW_ENDED_AT.getTime() / 1000), row_id: 29 }),
						movie({ date: Math.floor(WINDOW_STARTED_AT.getTime() / 1000) - 1, row_id: 28 }),
					],
					{ recordsFiltered: 99, recordsTotal: 101 },
				),
		});
		const result = await collect(tautulli);
		expect(result.rows[0]).toMatchObject({ watchCount: 2 });
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 2, sourceBindings: 2 });
	});

	it("ignores finite old and future rows before stable-id classification", async () => {
		const old = Math.floor(new Date("2026-09-03T11:44:59.000Z").getTime() / 1000);
		const future = Math.floor(new Date("2026-09-03T12:00:01.000Z").getTime() / 1000);
		const result = await collect(
			client({
				history: [
					movie({ row_id: undefined, date: old }),
					movie({ row_id: undefined, date: future }),
				],
			}),
		);
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 0, sourceBindings: 0 });
	});

	it("counts a malformed-date missing-id row as an unsupported object", async () => {
		const result = await collect(
			client({ history: [movie({ row_id: undefined, date: Number.NaN })] }),
		);
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 1, sourceBindings: 0 });
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "unsupported-provider-object",
			count: 1,
		});
	});

	it.each([
		["missing stable identity", movie({ row_id: undefined })],
		["unsupported media", movie({ media_type: "artist" })],
		["grouped play", movie({ group_count: 2 })],
		["non-single play", movie({ play_count: 2 })],
		["malformed user", movie({ user: " " })],
		["malformed date", movie({ date: Number.NaN })],
	])("accounts for %s with a conserved accepted skip", async (_label, item) => {
		const tautulli = client({
			history: [item],
			getMetadata: () => metadata(42),
		});
		const result = await collect(tautulli);
		const unit = result.receipt.units[0]!;
		expect(unit.rawObserved).toBe(
			unit.sourceBindings + unit.acceptedSkips.reduce((sum, skip) => sum + skip.count, 0),
		);
	});

	it("uses explicit known-container skips and rejects non-canonical row text", async () => {
		const container = await collect(client({ history: [movie({ media_type: "show" })] }));
		expect(container.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "known-container",
			count: 1,
		});
		const paddedKey = await collect(client({ history: [movie({ rating_key: " movie-key" })] }));
		expect(paddedKey.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "missing-stable-key",
			count: 1,
		});
		const paddedUser = await collect(client({ history: [movie({ user: " Alice" })] }));
		expect(paddedUser.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "unsupported-provider-object",
			count: 1,
		});
	});

	it("classifies missing stable identity for every repeated occurrence", async () => {
		const tautulli = client({
			history: [movie({ row_id: undefined }), movie({ row_id: undefined, user: "Bob" })],
		});
		const result = await collect(tautulli);
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 2, sourceBindings: 0 });
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "missing-stable-key",
			count: 2,
		});
	});

	it("classifies a missing supported mapping without metadata leakage", async () => {
		const result = await collect(client({ getMetadata: () => metadata(42, { guids: [] }) }));
		expect(result.rows).toEqual([]);
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 1, sourceBindings: 0 });
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "missing-supported-mapping",
			count: 1,
		});
	});

	it("fails closed when aggregated usernames exceed the output JSON bound", async () => {
		const rows = Array.from({ length: 201 }, (_, index) =>
			movie({
				row_id: 201 - index,
				user: `${String(index).padStart(3, "0")}${"u".repeat(497)}`,
			}),
		);
		await expect(
			collect(client({ getHistory: (params) => pagedHistory(rows, params) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("maps metadata through fixed-width ordered batches without an arbitrary lookup cutoff", async () => {
		const rows = Array.from({ length: 501 }, (_, index) =>
			movie({
				row_id: 502 - index,
				rating_key: `key-${index}`,
				date: Math.floor(new Date("2026-09-03T11:59:00.000Z").getTime() / 1000) - index,
			}),
		);
		const tautulli = client({
			getHistory: (params) => pagedHistory(rows, params),
			getMetadata: (ratingKey) => metadata(Number(ratingKey.replace("key-", "")) + 1),
		});
		const result = await collect(tautulli);

		expect(tautulli.getMetadata).toHaveBeenCalledTimes(501);
		expect(tautulli.getMetadata.mock.calls.slice(0, 3).map(([key]) => key)).toEqual([
			"key-0",
			"key-1",
			"key-2",
		]);
		expect(result.receipt.units[0]).toMatchObject({
			rawObserved: rows.length,
			sourceBindings: 501,
		});
		expect(result.receipt.units[0]?.acceptedSkips).toEqual([]);
	});

	it("maps every reporter-shaped video key alongside accepted music rows", async () => {
		const videoRows = Array.from({ length: 597 }, (_, index) =>
			movie({
				row_id: 700 - index,
				rating_key: `reporter-video-${index}`,
				date: Math.floor(WINDOW_ENDED_AT.getTime() / 1000) - index,
			}),
		);
		const musicRows = [
			movie({ row_id: 102, media_type: "track", rating_key: "music-track" }),
			movie({ row_id: 101, media_type: "album", rating_key: "music-album" }),
			movie({ row_id: 100, media_type: "artist", rating_key: "music-artist" }),
		];
		const tautulli = client({
			getHistory: (params) => pagedHistory([...videoRows, ...musicRows], params),
			getMetadata: (ratingKey) =>
				metadata(10_000 + Number(ratingKey.replace("reporter-video-", ""))),
		});

		const result = await collect(tautulli);

		expect(result.rows).toHaveLength(597);
		expect(new Set(result.rows.map((row) => row.tmdbId))).toEqual(
			new Set(Array.from({ length: 597 }, (_, index) => 10_000 + index)),
		);
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "unsupported-provider-object",
			count: 3,
		});
	});

	it("stops starting batches at the injected deadline and conserves unstarted candidates", async () => {
		const rows = Array.from({ length: 5 }, (_, index) =>
			movie({ row_id: 10 - index, rating_key: `deadline-${index}` }),
		);
		const tautulli = client({
			getHistory: (params) => pagedHistory(rows, params),
			getMetadata: (ratingKey) => metadata(Number(ratingKey.replace("deadline-", "")) + 1),
		});
		const result = await collect(tautulli, {
			metadataBatchSize: 2,
			metadataDeadlineMs: 10,
			monotonicNow: vi
				.fn()
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(9)
				.mockReturnValueOnce(10),
		});

		expect(tautulli.getMetadata).toHaveBeenCalledTimes(2);
		expect(result.receipt.units[0]).toMatchObject({ rawObserved: 5, sourceBindings: 2 });
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "bounded-window-truncation",
			count: 3,
		});
	});

	it("fails closed when an in-flight metadata batch settles after the absolute deadline", async () => {
		vi.useFakeTimers();
		try {
			const rows = [
				movie({ row_id: 20, rating_key: "in-flight-0" }),
				movie({ row_id: 19, rating_key: "in-flight-1" }),
			];
			let metadataStarted = 0;
			let metadataAborted = 0;
			let metadataSettled = 0;
			const settleMetadata: Array<() => void> = [];
			const tautulli = client({
				getHistory: (params) => pagedHistory(rows, params),
				getMetadata: (_ratingKey, signal) =>
					new Promise((resolve) => {
						metadataStarted += 1;
						settleMetadata.push(() => {
							metadataSettled += 1;
							resolve(metadata());
						});
						signal.addEventListener(
							"abort",
							() => {
								metadataAborted += 1;
							},
							{ once: true },
						);
					}),
			});

			const pending = collect(tautulli, {
				metadataBatchSize: 2,
				metadataDeadlineMs: 10,
				monotonicNow: () => 0,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(metadataStarted).toBe(2);

			const failure = expect(pending).rejects.toMatchObject({ code: "provider-unavailable" });
			await vi.advanceTimersByTimeAsync(11);
			expect(metadataAborted).toBe(2);
			expect(metadataSettled).toBe(0);
			for (const settle of settleMetadata) settle();
			await vi.advanceTimersByTimeAsync(0);
			await failure;
			expect(metadataSettled).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps metadata application in candidate order with one bounded batch in flight", async () => {
		const rows = Array.from({ length: 6 }, (_, index) =>
			movie({ row_id: 20 - index, rating_key: `ordered-${index}` }),
		);
		let active = 0;
		let maximumActive = 0;
		const settledKeys: string[] = [];
		const tautulli = client({
			getHistory: (params) => pagedHistory(rows, params),
			getMetadata: async (ratingKey) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				const index = Number(ratingKey.replace("ordered-", ""));
				for (let delay = 0; delay < index % 3; delay += 1) await Promise.resolve();
				settledKeys.push(ratingKey);
				active -= 1;
				return metadata(index + 1);
			},
		});

		const result = await collect(tautulli, {
			metadataBatchSize: 2,
			monotonicNow: () => 0,
		});

		expect(maximumActive).toBe(2);
		expect(tautulli.getMetadata.mock.calls.map(([key]) => key)).toEqual([
			"ordered-0",
			"ordered-1",
			"ordered-2",
			"ordered-3",
			"ordered-4",
			"ordered-5",
		]);
		expect(settledKeys).not.toEqual(tautulli.getMetadata.mock.calls.map(([key]) => key));
		expect(result.rows.map((row) => row.tmdbId)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("stops at the raw-row bound with a conserved truncation", async () => {
		const rows = Array.from({ length: TAUTULLI_OBSERVATION_MAX_RAW_ROWS + 1 }, (_, index) =>
			movie({
				row_id: TAUTULLI_OBSERVATION_MAX_RAW_ROWS + 1 - index,
				rating_key: `key-${index}`,
				date: Math.floor(new Date("2026-09-03T11:59:00.000Z").getTime() / 1000) - (index % 600),
			}),
		);
		const tautulli = client({ getHistory: (params) => pagedHistory(rows, params) });
		const result = await collect(tautulli);
		const unit = result.receipt.units[0]!;

		expect(unit.rawObserved).toBe(TAUTULLI_OBSERVATION_MAX_RAW_ROWS);
		expect(unit.acceptedSkips).toContainEqual({
			reason: "bounded-window-truncation",
			count: 1,
		});
		expect(result.rows.length).toBeLessThanOrEqual(TAUTULLI_OBSERVATION_MAX_RAW_ROWS);
		expect(result.receipt.units[0]?.acceptedSkips.reduce((sum, skip) => sum + skip.count, 0)).toBe(
			unit.rawObserved - unit.sourceBindings,
		);
	});

	it("caps history requests when duplicate full pages never terminate", async () => {
		const outsideWindow = Math.floor(new Date("2026-09-03T11:44:00.000Z").getTime() / 1000);
		const tautulli = client({
			getHistory: () =>
				history(
					[
						movie({
							row_id: 20,
							date: Math.floor(new Date("2026-09-03T11:59:00.000Z").getTime() / 1000),
						}),
						movie({
							row_id: 19,
							date: Math.floor(new Date("2026-09-03T11:50:00.000Z").getTime() / 1000),
						}),
						...Array.from({ length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE - 2 }, (_, index) =>
							movie({ row_id: Math.max(0, 18 - index), date: outsideWindow }),
						),
					],
					{ recordsTotal: 99_999 },
				),
		});
		const result = await collect(tautulli);
		expect(tautulli.getHistory).toHaveBeenCalledTimes(TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS);
		expect(result.receipt.units[0]?.acceptedSkips).toContainEqual({
			reason: "bounded-window-truncation",
			count: 1,
		});
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.lastWatchedAt).toEqual(new Date("2026-09-03T11:59:00.000Z"));
	});

	it("fails at the request bound when no valid candidate can carry truncation", async () => {
		const outsideWindow = Math.floor(new Date("2026-09-03T11:44:00.000Z").getTime() / 1000);
		const tautulli = client({
			getHistory: () =>
				history(
					[
						movie({ row_id: 20, group_count: 2 }),
						movie({ row_id: 19, group_count: 2 }),
						...Array.from({ length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE - 2 }, (_, index) =>
							movie({ row_id: Math.max(0, 18 - index), date: outsideWindow, group_count: 2 }),
						),
					],
					{ recordsTotal: 99_999 },
				),
		});
		await expect(collect(tautulli)).rejects.toMatchObject({ code: "provider-limit" });
		expect(tautulli.getHistory).toHaveBeenCalledTimes(TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS);
	});

	it("fails with bounded provider-unavailable errors for upstream rejections", async () => {
		const secret = "synthetic-upstream-secret";
		const tautulli = client();
		tautulli.getHistory.mockRejectedValue(new Error(secret));
		const pending = collect(tautulli);
		await expect(pending).rejects.toMatchObject({ code: "provider-unavailable" });
		await expect(pending).rejects.not.toThrow(secret);
	});

	it("fails closed for malformed structures and ambiguous mappings", async () => {
		await expect(collect(client({ libraries: {} }))).rejects.toMatchObject({
			code: "rows-inconsistent",
		});
		await expect(
			collect(client({ getHistory: () => history([movie()], { recordsTotal: -1 }) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(client({ getMetadata: () => metadata(1, { guids: ["tmdb://1", "tmdb://2"] }) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () => ({ data: "not-an-array", recordsFiltered: 1, recordsTotal: 1 }),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () =>
						history(
							Array.from({ length: TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE + 1 }, () => movie()),
						),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("rejects conflicting duplicate identities and within-page ordering", async () => {
		await expect(
			collect(
				client({
					getHistory: () => history([movie({ row_id: 20 }), movie({ row_id: 20, user: "Bob" })]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () =>
						history([
							movie({ row_id: 20, parent_rating_key: undefined }),
							movie({ row_id: 20, parent_rating_key: null }),
						]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () =>
						history([
							movie({
								row_id: 20,
								date: Math.floor(new Date("2026-09-03T11:55:00.000Z").getTime() / 1000),
							}),
							movie({ row_id: 20, date: Number.POSITIVE_INFINITY }),
						]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(client({ getHistory: () => history([movie({ row_id: 2 }), movie({ row_id: 3 })]) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () => history([movie({ row_id: 20 }), movie({ row_id: 20, group_count: 2 })]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(
				client({
					getHistory: () =>
						history([
							movie({ row_id: 20, rating_key: "shared" }),
							episode({ row_id: 19, grandparent_rating_key: "shared" }),
						]),
				}),
			),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("fails closed for metadata rejection and malformed metadata", async () => {
		await expect(
			collect(client({ getMetadata: () => Promise.reject(new Error("secret")) })),
		).rejects.toMatchObject({ code: "provider-unavailable" });
		await expect(
			collect(client({ getMetadata: () => ({ guids: "not-an-array" }) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(client({ getMetadata: () => metadata(1, { guids: ["tmdb://0"] }) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		await expect(
			collect(client({ getMetadata: () => metadata(1, { guids: [42] }) })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("requires a supported library and ignores unsupported sections", async () => {
		const tautulli = client({ libraries: [library("1", "artist")] });
		await expect(collect(tautulli)).rejects.toMatchObject({ code: "provider-unavailable" });
		expect(tautulli.getHistory).not.toHaveBeenCalled();
		await expect(
			collect(client({ libraries: [library("1"), { section_id: 2, section_type: "show" }] })),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("bounds supported libraries", async () => {
		const libraries = Array.from({ length: 101 }, (_, index) => library(String(index + 1)));
		await expect(collect(client({ libraries }))).rejects.toMatchObject({ code: "provider-limit" });
	});

	it("round-trips the result receipt through the strict metadata codec", async () => {
		const result = await collect(client());
		const decoded = decodeTautulliObservationMetadata(
			JSON.stringify({
				version: 1,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: result.rows.length,
				windowStartedAt: result.windowStartedAt.toISOString(),
				windowEndedAt: result.windowEndedAt.toISOString(),
				coverageReceipt: result.receipt,
			}),
		);
		expect(decoded.ok).toBe(true);
	});

	it("contains no forbidden persistence or authority imports", async () => {
		const source = await readFile(
			path.resolve(process.cwd(), "src/lib/tautulli/tautulli-positive-observation-collector.ts"),
			"utf8",
		);
		expect(source).not.toMatch(
			/prisma|status-projection|cache-authority|repository|cleanup|route|scheduler|refresher/i,
		);
	});

	it("rejects invalid attempt and clock dates before upstream collection", async () => {
		const tautulli = client();
		await expect(
			collect(tautulli, { attemptStartedAt: new Date("invalid") }),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
		expect(tautulli.getLibraries).not.toHaveBeenCalled();
		await expect(collect(client(), { now: () => new Date("invalid") })).rejects.toMatchObject({
			code: "rows-inconsistent",
		});
		await expect(
			collect(client(), { attemptStartedAt: new Date("2026-09-03T12:01:00.000Z") }),
		).rejects.toMatchObject({ code: "rows-inconsistent" });
	});

	it("rejects overrides that exceed production bounds before provider I/O", async () => {
		const oversizedBatch = client();
		await expect(collect(oversizedBatch, { metadataBatchSize: 26 })).rejects.toMatchObject({
			code: "rows-inconsistent",
		});
		expect(oversizedBatch.getLibraries).not.toHaveBeenCalled();

		const oversizedDeadline = client();
		await expect(collect(oversizedDeadline, { metadataDeadlineMs: 10_001 })).rejects.toMatchObject({
			code: "rows-inconsistent",
		});
		expect(oversizedDeadline.getLibraries).not.toHaveBeenCalled();
	});

	it("exposes the fixed request bound constants", () => {
		expect(TAUTULLI_OBSERVATION_WINDOW_MS).toBe(900_000);
		expect(TAUTULLI_OBSERVATION_HISTORY_PAGE_SIZE).toBe(200);
		expect(TAUTULLI_OBSERVATION_MAX_RAW_ROWS).toBe(10_000);
		expect(TAUTULLI_OBSERVATION_MAX_HISTORY_REQUESTS).toBe(100);
		expect(TAUTULLI_OBSERVATION_METADATA_BATCH_SIZE).toBe(25);
		expect(TAUTULLI_OBSERVATION_METADATA_DEADLINE_MS).toBe(10_000);
	});
});
