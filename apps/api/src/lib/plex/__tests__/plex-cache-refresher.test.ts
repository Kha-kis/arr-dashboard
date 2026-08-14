/**
 * Plex Cache Refresher — stale row eviction tests
 *
 * Regression for issue #323: `deleteMany({ id: { notIn: upsertedIds } })` was
 * exceeding SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999) for large
 * libraries, surfacing as Prisma P2029 and leaving the Plex cache in a
 * "errors, data may be outdated" state that neither manual nor scheduled
 * refreshes could clear.
 *
 * The fix replaces the oversized `notIn` query with a
 * read-then-diff-then-chunked-`in`-delete pattern. These tests pin that
 * behaviour so we don't regress it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearPlexCacheRefreshSingleFlightsForTests,
	evictStaleRows,
	PLEX_CACHE_PUBLICATION_CHUNK_SIZE,
	refreshPlexCache,
	STALE_EVICTION_CHUNK_SIZE,
} from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";
import type { PrismaClient } from "../../prisma.js";
import { providerConnectionIdentity } from "../../services/provider-connection-guard.js";
import type { FastifyBaseLogger } from "fastify";

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

const plexConnection = {
	userId: "user-1",
	service: "PLEX" as const,
	baseUrl: "https://plex.example.test",
	encryptedApiKey: "key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	enabled: true,
	connectionGeneration: 7,
};

afterEach(() => clearPlexCacheRefreshSingleFlightsForTests());

/**
 * Build a minimal Prisma stub that records every `deleteMany` call so tests
 * can assert on chunking behaviour without needing a real database.
 */
function makeMockPrisma(existingIds: string[]) {
	const deleteCalls: Array<{ idsInFilter: string[] }> = [];

	const stub = {
		plexCache: {
			findMany: vi.fn(async () => existingIds.map((id) => ({ id }))),
			deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
				deleteCalls.push({ idsInFilter: args.where.id.in });
				return { count: args.where.id.in.length };
			}),
		},
	} as unknown as PrismaClient;

	return { prisma: stub, deleteCalls };
}

describe("evictStaleRows", () => {
	it("returns 0 and issues no DELETE when nothing is stale", async () => {
		const keepIds = ["a", "b", "c"];
		const { prisma, deleteCalls } = makeMockPrisma(keepIds);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(0);
		expect(deleteCalls).toHaveLength(0);
	});

	it("deletes only rows whose id is not in keepIds", async () => {
		const existing = ["keep-1", "stale-1", "keep-2", "stale-2"];
		const keepIds = ["keep-1", "keep-2"];
		const { prisma, deleteCalls } = makeMockPrisma(existing);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(2);
		expect(deleteCalls).toHaveLength(1);
		// Order doesn't matter; membership does.
		expect(new Set(deleteCalls[0]!.idsInFilter)).toEqual(new Set(["stale-1", "stale-2"]));
	});

	it("chunks large stale sets so no single DELETE exceeds the SQLite parameter limit (#323)", async () => {
		// Simulate a library large enough that the old `notIn: upsertedIds` path
		// would have generated a single 5,000-parameter query (5x SQLite's
		// default 999-parameter ceiling).
		const TOTAL_EXISTING = 5_000;
		const existingIds = Array.from({ length: TOTAL_EXISTING }, (_, i) => `row-${i}`);
		// Keep none of them — every row is stale. This is the worst case for
		// parameter count.
		const keepIds: string[] = [];
		const { prisma, deleteCalls } = makeMockPrisma(existingIds);

		const deleted = await evictStaleRows(prisma, "inst-1", keepIds);

		expect(deleted).toBe(TOTAL_EXISTING);

		// Every DELETE must stay well under the SQLite limit. 999 is the
		// conservative ceiling; our chunk size is smaller by design.
		const SQLITE_PARAM_CEILING = 999;
		for (const call of deleteCalls) {
			expect(call.idsInFilter.length).toBeLessThanOrEqual(STALE_EVICTION_CHUNK_SIZE);
			expect(call.idsInFilter.length).toBeLessThan(SQLITE_PARAM_CEILING);
		}

		// And the chunks must cover the full stale set with no duplicates.
		const seen = new Set<string>();
		for (const call of deleteCalls) {
			for (const id of call.idsInFilter) {
				expect(seen.has(id)).toBe(false);
				seen.add(id);
			}
		}
		expect(seen.size).toBe(TOTAL_EXISTING);

		// Sanity: we actually did issue multiple statements (i.e. we chunked,
		// not just "happened to send one small query"). ceil(5000 / 500) = 10.
		expect(deleteCalls.length).toBe(Math.ceil(TOTAL_EXISTING / STALE_EVICTION_CHUNK_SIZE));
	});

	it("publishes a >999-item library with one replacement, avoiding parameter-bound stale eviction (#323 regression)", async () => {
		const LIBRARY_SIZE = 1_200;

		const libraryItems = Array.from({ length: LIBRARY_SIZE }, (_, i) => ({
			ratingKey: `rk-${i}`,
			title: `Movie ${i}`,
			type: "movie",
			Guid: [{ id: `tmdb://${10_000 + i}` }],
			userRating: null,
			addedAt: 1_700_000_000,
			thumb: null,
			Collection: [],
			Label: [],
		}));

		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(libraryItems),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const publishedRows: unknown[] = [];
		const deleteMany = vi.fn().mockResolvedValue({ count: 1_500 });
		const tx = {
			plexCache: {
				deleteMany,
				createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
					publishedRows.push(...data);
					return { count: data.length };
				}),
			},
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const mockPrisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(LIBRARY_SIZE);
		expect(deleteMany).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
		expect(publishedRows).toHaveLength(LIBRARY_SIZE);
		expect(tx.plexCache.createMany).toHaveBeenCalledTimes(
			Math.ceil(LIBRARY_SIZE / PLEX_CACHE_PUBLICATION_CHUNK_SIZE),
		);
		for (const [call] of tx.plexCache.createMany.mock.calls) {
			expect(call.data.length).toBeLessThanOrEqual(PLEX_CACHE_PUBLICATION_CHUNK_SIZE);
		}
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
		const statusWrite = tx.cacheRefreshStatus.upsert.mock.calls[0]![0];
		expect(statusWrite.create.generationId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(JSON.parse(statusWrite.create.generationMetadata)).toEqual({
			sections: [{ key: "1", title: "Movies", type: "movie" }],
		});
		expect(statusWrite.update).toMatchObject({
			generationId: statusWrite.create.generationId,
			generationMetadata: statusWrite.create.generationMetadata,
		});
	});

	it("keeps stale rows when Plex returns no media libraries", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-movie",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://123" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const { prisma, deleteCalls } = makeMockPrisma(["stale-1", "stale-2"]);

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
		expect(deleteCalls).toEqual([]);
	});

	it("does not evict cache rows after an incomplete library refresh", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi
				.fn()
				.mockResolvedValue([{ key: "1", title: "Unavailable", type: "show" }]),
			getLibraryItems: vi.fn().mockRejectedValue(new Error("Plex library unavailable")),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const { prisma, deleteCalls } = makeMockPrisma(["retained-1"]);

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

		expect(result.errors).toBe(1);
		expect(deleteCalls).toEqual([]);
	});

	it("marks history evidence incomplete when Plex exceeds the cache limit", async () => {
		const history = Array.from({ length: 5_001 }, (_, index) => ({
			ratingKey: `history-${index}`,
			title: `History ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-movie",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://123" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue(history),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const { prisma, deleteCalls } = makeMockPrisma(["retained-1"]);

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

		expect(mockClient.getHistory).toHaveBeenCalledWith({ maxResults: 5_001 });
		expect(result.errors).toBe(1);
		expect(result.errorMessages).toContainEqual(expect.stringContaining("history exceeded 5000"));
		expect(deleteCalls).toEqual([]);
	});

	it("marks on-deck evidence incomplete when Plex cannot return it", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-movie",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://123" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockRejectedValue(new Error("Plex on-deck unavailable")),
		} as unknown as PlexClient;
		const { prisma, deleteCalls } = makeMockPrisma(["retained-1"]);

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

		expect(result.errors).toBe(1);
		expect(result.errorMessages).toContainEqual(expect.stringContaining("on-deck items"));
		expect(deleteCalls).toEqual([]);
	});

	it("never uses `notIn` — the original P2029 trigger", async () => {
		// Guard against a future regression where someone re-introduces the
		// oversized `notIn` query. The mock's deleteMany only accepts `id.in`,
		// so any `notIn` call would surface here as a runtime error.
		const existingIds = Array.from({ length: 1_500 }, (_, i) => `row-${i}`);
		const { prisma, deleteCalls } = makeMockPrisma(existingIds);

		await evictStaleRows(prisma, "inst-1", []);

		for (const call of deleteCalls) {
			// `idsInFilter` comes from `args.where.id.in` — if the code ever
			// switched back to `notIn`, this array would be undefined.
			expect(Array.isArray(call.idsInFilter)).toBe(true);
		}
	});
});

function makeCompletePlexClient(): PlexClient {
	return {
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
		getLibrarySections: vi
			.fn()
			.mockResolvedValue([{ key: "movies", title: "Movies", type: "movie" }]),
		getLibraryItems: vi.fn().mockResolvedValue([
			{
				ratingKey: "movie-1",
				title: "The Current Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
				Collection: [],
				Label: [],
			},
		]),
		getHistory: vi.fn().mockResolvedValue([]),
		getOnDeck: vi.fn().mockResolvedValue([]),
	} as unknown as PlexClient;
}

function makeAtomicPlexPrisma(options?: {
	current?: (Omit<typeof plexConnection, "service"> & { service: "PLEX" | "JELLYFIN" }) | null;
	failNextPublication?: boolean;
}) {
	const state = {
		rows: [{ title: "Previous generation" }],
		status: "previous-success",
	};
	let failNextPublication = options?.failNextPublication ?? false;
	const current = options && "current" in options ? options.current : plexConnection;

	const prisma = {
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
			const nextRows = [...state.rows];
			let nextStatus = state.status;
			const tx = {
				serviceInstance: { findUnique: vi.fn().mockResolvedValue(current) },
				plexCache: {
					deleteMany: vi.fn(async () => {
						nextRows.length = 0;
						return { count: 1 };
					}),
					createMany: vi.fn(async ({ data }: { data: Array<{ title: string }> }) => {
						if (failNextPublication) {
							failNextPublication = false;
							throw new Error("database write failed");
						}
						nextRows.push(...data);
						return { count: data.length };
					}),
				},
				cacheRefreshStatus: {
					upsert: vi.fn(async () => {
						nextStatus = "fresh-success";
						return {};
					}),
				},
			};
			const result = await callback(tx);
			state.rows = nextRows;
			state.status = nextStatus;
			return result;
		}),
	};

	return { prisma: prisma as unknown as PrismaClient, state };
}

describe("refreshPlexCache atomic publication", () => {
	it("coalesces concurrent refreshes for the same provider generation", async () => {
		const { prisma } = makeAtomicPlexPrisma();
		const client = makeCompletePlexClient();
		let releaseAccounts: (() => void) | undefined;
		vi.mocked(client.getAccounts).mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				releaseAccounts = resolve;
			});
			return [{ id: 1, name: "Alice" }];
		});
		const expectedConnection = providerConnectionIdentity(plexConnection);

		const first = refreshPlexCache(client, prisma, "inst-1", silentLog, expectedConnection);
		const second = refreshPlexCache(client, prisma, "inst-1", silentLog, expectedConnection);

		expect(first).toBe(second);
		expect(client.getAccounts).toHaveBeenCalledTimes(1);
		releaseAccounts?.();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(secondResult).toEqual(firstResult);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it("replaces a complete generation and its success status in one transaction", async () => {
		const { prisma, state } = makeAtomicPlexPrisma();

		const result = await refreshPlexCache(
			makeCompletePlexClient(),
			prisma,
			"inst-1",
			silentLog,
			providerConnectionIdentity(plexConnection),
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(state.rows).toEqual([expect.objectContaining({ title: "The Current Movie" })]);
		expect(state.status).toBe("fresh-success");
	});

	it("keeps the previous generation when a library snapshot is incomplete", async () => {
		const { prisma, state } = makeAtomicPlexPrisma();
		const client = makeCompletePlexClient();
		vi.mocked(client.getLibraryItems).mockRejectedValueOnce(new Error("pagination stopped early"));

		const result = await refreshPlexCache(client, prisma, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errorMessages.join(" ")).toMatch(/pagination stopped early/i);
		expect(state).toEqual({ rows: [{ title: "Previous generation" }], status: "previous-success" });
	});

	it("keeps the previous generation when current history cannot be attributed", async () => {
		const { prisma, state } = makeAtomicPlexPrisma();
		const client = makeCompletePlexClient();
		vi.mocked(client.getHistory).mockResolvedValueOnce([
			{
				ratingKey: "missing-now",
				title: "Missing movie",
				type: "movie",
				accountID: 1,
				viewedAt: 1_700_000_000,
			},
		]);

		const result = await refreshPlexCache(client, prisma, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/history item could not be mapped/i);
		expect(state).toEqual({ rows: [{ title: "Previous generation" }], status: "previous-success" });
	});

	it("accepts exactly 5,000 Plex history rows when the one-row probe is not filled", async () => {
		const { prisma, state } = makeAtomicPlexPrisma();
		const client = makeCompletePlexClient();
		vi.mocked(client.getHistory).mockResolvedValueOnce(
			Array.from({ length: 5_000 }, (_, index) => ({
				ratingKey: `unmapped-${index}`,
				title: `Unmapped ${index}`,
				type: "other",
				accountID: 1,
				viewedAt: index,
			})),
		);

		const result = await refreshPlexCache(client, prisma, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(client.getHistory).toHaveBeenCalledWith({ maxResults: 5001 });
		expect(state).toEqual({
			rows: [expect.objectContaining({ title: "The Current Movie" })],
			status: "fresh-success",
		});
	});

	it("keeps the previous generation when on-deck evidence is unavailable", async () => {
		const { prisma, state } = makeAtomicPlexPrisma();
		const client = makeCompletePlexClient();
		vi.mocked(client.getOnDeck).mockRejectedValueOnce(new Error("on-deck unavailable"));

		const result = await refreshPlexCache(client, prisma, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errorMessages.join(" ")).toMatch(/on-deck unavailable/i);
		expect(state).toEqual({ rows: [{ title: "Previous generation" }], status: "previous-success" });
	});

	it.each([
		["deleted", null],
		["disabled", { ...plexConnection, enabled: false }],
		["service changed", { ...plexConnection, service: "JELLYFIN" }],
		["generation changed", { ...plexConnection, connectionGeneration: 8 }],
	] as const)(
		"does not publish when the originating connection was %s",
		async (_reason, current) => {
			const { prisma, state } = makeAtomicPlexPrisma({ current });

			const result = await refreshPlexCache(
				makeCompletePlexClient(),
				prisma,
				"inst-1",
				silentLog,
				providerConnectionIdentity(plexConnection),
			);

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(state).toEqual({
				rows: [{ title: "Previous generation" }],
				status: "previous-success",
			});
		},
	);

	it("preserves the old generation after a failed publication and succeeds on retry", async () => {
		const { prisma, state } = makeAtomicPlexPrisma({ failNextPublication: true });
		const client = makeCompletePlexClient();

		const failed = await refreshPlexCache(client, prisma, "inst-1", silentLog);
		expect(failed.complete).toBe(false);
		expect(failed.errorMessages.join(" ")).toMatch(/atomic plex cache publication failed/i);
		expect(state).toEqual({ rows: [{ title: "Previous generation" }], status: "previous-success" });

		const retried = await refreshPlexCache(client, prisma, "inst-1", silentLog);
		expect(retried).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(state.rows).toEqual([expect.objectContaining({ title: "The Current Movie" })]);
		expect(state.status).toBe("fresh-success");
	});
});
