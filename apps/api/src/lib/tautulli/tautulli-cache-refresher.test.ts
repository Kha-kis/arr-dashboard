import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../prisma.js";
import {
	clearTautulliCacheRefreshSingleFlightsForTests,
	evictStaleRows,
	refreshTautulliCache,
	STALE_EVICTION_CHUNK_SIZE,
} from "./tautulli-cache-refresher.js";
import type { TautulliClient } from "./tautulli-client.js";

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;

const expectedConnection = { service: "TAUTULLI" as const, connectionGeneration: 7 };

afterEach(() => {
	clearTautulliCacheRefreshSingleFlightsForTests();
	vi.clearAllMocks();
});

function historyRow(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		row_id: 1,
		rating_key: "movie-1",
		parent_rating_key: "",
		grandparent_rating_key: "",
		title: "A movie",
		grandparent_title: "",
		media_type: "movie",
		user: "alice",
		date: 1_700_000_000,
		...overrides,
	};
}

function completeClient(options?: {
	snapshot?: {
		items: ReturnType<typeof historyRow>[];
		recordsFiltered: number;
		recordsTotal: number;
		complete: boolean;
		incompleteReason?: "page_limit_reached";
	};
	metadata?: { guids: string[]; media_type: string; title: string };
}) {
	const snapshot = options?.snapshot ?? {
		items: [historyRow(), historyRow({ row_id: 2, user: "bob", date: 1_700_000_100 })],
		recordsFiltered: 2,
		recordsTotal: 2,
		complete: true,
	};
	return {
		getLibraries: vi
			.fn()
			.mockResolvedValue([
				{ section_id: "movies", section_name: "Movies", section_type: "movie", count: "2" },
			]),
		getHistorySnapshot: vi.fn().mockResolvedValue(snapshot),
		getMetadata: vi
			.fn()
			.mockResolvedValue(
				options?.metadata ?? { guids: ["tmdb://42"], media_type: "movie", title: "A movie" },
			),
	} as unknown as TautulliClient;
}

function makeAtomicPrisma(options?: {
	current?: { service: "TAUTULLI" | "PLEX"; enabled: boolean; connectionGeneration: number } | null;
	failPublication?: boolean;
}) {
	const state: {
		rows: Array<Record<string, unknown>>;
		status: Record<string, unknown>;
	} = {
		rows: [{ tmdbId: 99, mediaType: "movie", watchCount: 4 }],
		status: {
			lastResult: "success",
			generationId: "previous-generation",
			itemCount: 1,
			lastAttemptResult: "success",
		},
	};
	const current =
		options?.current === undefined
			? { service: "TAUTULLI" as const, enabled: true, connectionGeneration: 7 }
			: options.current;
	let failPublication = options?.failPublication ?? false;

	const prisma = {
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
			const nextRows = [...state.rows];
			let nextStatus = { ...state.status };
			const tx = {
				serviceInstance: { findUnique: vi.fn().mockResolvedValue(current) },
				tautulliCache: {
					deleteMany: vi.fn(async () => {
						nextRows.length = 0;
						return { count: state.rows.length };
					}),
					createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
						if (failPublication) {
							failPublication = false;
							throw new Error("database write failed");
						}
						nextRows.push(...data);
						return { count: data.length };
					}),
				},
				cacheRefreshStatus: {
					upsert: vi.fn(async ({ create, update }: { create: object; update: object }) => {
						nextStatus = { ...nextStatus, ...(Object.keys(state.status).length ? update : create) };
						return {};
					}),
				},
			};
			const value = await callback(tx);
			state.rows = nextRows;
			state.status = nextStatus;
			return value;
		}),
	};

	return { prisma: prisma as unknown as PrismaClient, state };
}

describe("refreshTautulliCache", () => {
	it("publishes a complete staged generation and success attempt atomically", async () => {
		const { prisma, state } = makeAtomicPrisma();

		const result = await refreshTautulliCache(
			completeClient(),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(state.rows).toEqual([
			expect.objectContaining({ tmdbId: 42, mediaType: "movie", watchCount: 2 }),
		]);
		expect(JSON.parse(String(state.rows[0]?.watchedByUsers))).toEqual(["alice", "bob"]);
		expect(state.status).toMatchObject({
			lastResult: "success",
			itemCount: 1,
			lastAttemptResult: "success",
		});
		expect(state.status.generationId).not.toBe("previous-generation");
		expect(JSON.parse(String(state.status.generationMetadata))).toEqual({
			sections: [
				{
					id: "movies",
					name: "Movies",
					type: "movie",
					recordsFiltered: 2,
					recordsTotal: 2,
				},
			],
		});
	});

	it("keeps the previous generation when given an incomplete client snapshot", async () => {
		const { prisma, state } = makeAtomicPrisma();

		const result = await refreshTautulliCache(
			completeClient({
				snapshot: {
					items: [historyRow()],
					recordsFiltered: 2,
					recordsTotal: 2,
					complete: false,
					incompleteReason: "page_limit_reached",
				},
			}),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status).toMatchObject({
			lastResult: "success",
			generationId: "previous-generation",
			lastAttemptResult: "error",
		});
	});

	it("rejects a complete row-count snapshot whose frozen total is below its filtered total", async () => {
		const { prisma, state } = makeAtomicPrisma();

		const result = await refreshTautulliCache(
			completeClient({
				snapshot: {
					items: [historyRow()],
					recordsFiltered: 1,
					recordsTotal: 0,
					complete: true,
				},
			}),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result.errorMessages).toEqual([
			"Tautulli history declared total is below filtered total for library movies",
		]);
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status).toMatchObject({
			generationId: "previous-generation",
			lastAttemptResult: "error",
		});
	});

	it.each([
		["a duplicate stable row", [historyRow(), historyRow({ row_id: 1, user: "bob" })]],
		["a grouped history row", [historyRow({ group_count: 2 })]],
		["a sparse history row", [historyRow({ user: "" })]],
	])("rejects %s before any cache mutation", async (_reason, items) => {
		const { prisma, state } = makeAtomicPrisma();

		const result = await refreshTautulliCache(
			completeClient({
				snapshot: {
					items,
					recordsFiltered: items.length,
					recordsTotal: items.length,
					complete: true,
				},
			}),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result.complete).toBe(false);
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status.lastAttemptResult).toBe("error");
	});

	it("treats sparse metadata as incomplete evidence without publishing", async () => {
		const { prisma, state } = makeAtomicPrisma();

		const result = await refreshTautulliCache(
			completeClient({ metadata: { guids: [], media_type: "unknown", title: "" } }),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status.lastAttemptResult).toBe("error");
	});

	it("rejects a complete valid-row-count snapshot that exceeds the aggregate history cap", async () => {
		const { prisma, state } = makeAtomicPrisma();
		const rows = Array.from({ length: 100_001 }, (_, index) =>
			historyRow({ row_id: index + 1, rating_key: `movie-${index}` }),
		);
		const tooLargeHistory = completeClient({
			snapshot: {
				items: rows,
				recordsFiltered: rows.length,
				recordsTotal: rows.length,
				complete: true,
			},
		});

		const historyResult = await refreshTautulliCache(
			tooLargeHistory,
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);
		expect(historyResult.errorMessages).toEqual([
			"Tautulli history exceeds the safe 100000-row refresh limit",
		]);
		expect(tooLargeHistory.getMetadata).not.toHaveBeenCalled();
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status).toMatchObject({
			generationId: "previous-generation",
			lastAttemptResult: "error",
		});
	});

	it("enforces the metadata inventory cap before publishing", async () => {
		const { prisma: metadataPrisma } = makeAtomicPrisma();
		const metadataRows = Array.from({ length: 501 }, (_, index) =>
			historyRow({ row_id: index + 1, rating_key: `movie-${index}` }),
		);
		const tooMuchMetadata = completeClient({
			snapshot: {
				items: metadataRows,
				recordsFiltered: metadataRows.length,
				recordsTotal: metadataRows.length,
				complete: true,
			},
		});

		const metadataResult = await refreshTautulliCache(
			tooMuchMetadata,
			metadataPrisma,
			"tautulli-2",
			log,
			expectedConnection,
		);
		expect(metadataResult.complete).toBe(false);
		expect(tooMuchMetadata.getMetadata).not.toHaveBeenCalled();
	});

	it("normalizes a connection refusal into non-sensitive failure text", async () => {
		const { prisma } = makeAtomicPrisma();
		const client = completeClient();
		vi.mocked(client.getLibraries).mockRejectedValueOnce(
			new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }),
		);

		const result = await refreshTautulliCache(
			client,
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result.errorMessages).toEqual([
			"Connection refused by the configured host (ECONNREFUSED)",
		]);
		expect(result.errorMessages.join(" ")).not.toContain("fetch failed");
	});

	it("coalesces overlapping refreshes for the same provider generation", async () => {
		const { prisma } = makeAtomicPrisma();
		const client = completeClient();
		let release: (() => void) | undefined;
		vi.mocked(client.getLibraries).mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return [{ section_id: "movies", section_name: "Movies", section_type: "movie", count: "2" }];
		});

		const first = refreshTautulliCache(client, prisma, "tautulli-1", log, expectedConnection);
		const second = refreshTautulliCache(client, prisma, "tautulli-1", log, expectedConnection);

		expect(first).toBe(second);
		expect(client.getLibraries).toHaveBeenCalledTimes(1);
		release?.();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it.each([
		["deleted", null],
		["disabled", { service: "TAUTULLI" as const, enabled: false, connectionGeneration: 7 }],
		["service changed", { service: "PLEX" as const, enabled: true, connectionGeneration: 7 }],
		[
			"generation changed",
			{ service: "TAUTULLI" as const, enabled: true, connectionGeneration: 8 },
		],
	])(
		"fails closed without recording stale failure status when the instance was %s",
		async (_reason, current) => {
			const { prisma, state } = makeAtomicPrisma({ current });

			const result = await refreshTautulliCache(
				completeClient(),
				prisma,
				"tautulli-1",
				log,
				expectedConnection,
			);

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(state).toEqual({
				rows: [{ tmdbId: 99, mediaType: "movie", watchCount: 4 }],
				status: {
					lastResult: "success",
					generationId: "previous-generation",
					itemCount: 1,
					lastAttemptResult: "success",
				},
			});
		},
	);

	it("keeps the last successful generation when the atomic publication rolls back", async () => {
		const { prisma, state } = makeAtomicPrisma({ failPublication: true });

		const result = await refreshTautulliCache(
			completeClient(),
			prisma,
			"tautulli-1",
			log,
			expectedConnection,
		);

		expect(result.complete).toBe(false);
		expect(state.rows).toEqual([{ tmdbId: 99, mediaType: "movie", watchCount: 4 }]);
		expect(state.status).toMatchObject({
			lastResult: "success",
			generationId: "previous-generation",
			lastAttemptResult: "error",
		});
	});
});

describe("evictStaleRows", () => {
	it("deletes stale rows in bounded id chunks without a notIn filter", async () => {
		const existingIds = Array.from({ length: 1_201 }, (_, index) => `row-${index}`);
		const calls: string[][] = [];
		const prisma = {
			tautulliCache: {
				findMany: vi.fn().mockResolvedValue(existingIds.map((id) => ({ id }))),
				deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
					calls.push(where.id.in);
					return { count: where.id.in.length };
				}),
			},
		} as unknown as PrismaClient;

		await expect(evictStaleRows(prisma, "tautulli-1", ["row-0"])).resolves.toBe(1_200);
		expect(calls).toHaveLength(3);
		expect(calls.flat()).toHaveLength(1_200);
		for (const ids of calls) {
			expect(ids).toHaveLength(Math.min(ids.length, STALE_EVICTION_CHUNK_SIZE));
			expect(ids.length).toBeLessThan(999);
		}
	});
});
