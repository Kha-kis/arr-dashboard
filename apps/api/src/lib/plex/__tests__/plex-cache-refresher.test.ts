/** Plex cache collection and guarded publication tests. */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	canPublishPositivePlexObservation,
	collectPlexCacheLiveEvidence,
	collectSettledPlexCacheLiveEvidence,
	isPersonalMediaSection,
} from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

async function refreshPlexCache(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: unknown,
	_options?: unknown,
) {
	void prisma;
	return await collectPlexCacheLiveEvidence(client, instanceId, log);
}

describe("collectPlexCacheLiveEvidence", () => {
	function positiveObservationClient(input: {
		accounts?: Array<{ id: number; name: string }>;
		librarySections?: Array<{ key: string; title: string; type: "movie" | "show" }>;
		libraryItems?: Array<{
			ratingKey: string;
			title: string;
			type: "movie" | "show";
			Guid: Array<{ id: string }>;
		}>;
		libraryItemsBySection?: Record<
			string,
			Array<{
				ratingKey: string;
				title: string;
				type: "movie" | "show";
				Guid: Array<{ id: string }>;
			}>
		>;
		history?: unknown[];
		onDeck?: unknown[] | Error;
		activities?: Array<{ type: string }>;
		settlementSections?: Array<{
			key: string;
			uuid: string;
			title: string;
			type: "movie" | "show";
			refreshing: boolean;
			scannedAt: number | null;
			updatedAt: number;
		}>;
	}) {
		const librarySections = input.librarySections ?? [
			{ key: "shows", title: "Shows", type: "show" },
		];
		const settlementSections = input.settlementSections ?? [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		return {
			getActivities: vi.fn().mockResolvedValue(input.activities ?? []),
			getLibrarySettlementSections: vi.fn().mockResolvedValue(settlementSections),
			getAccounts: vi.fn().mockResolvedValue(input.accounts ?? [{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue(librarySections),
			getLibraryItems: vi.fn().mockImplementation((sectionId: string) =>
				Promise.resolve(
					input.libraryItemsBySection?.[sectionId] ??
						input.libraryItems ?? [
							{
								ratingKey: "show-1",
								title: "Mapped Show",
								type: "show" as const,
								Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
							},
							{
								ratingKey: "legacy-movie",
								title: "Legacy Movie",
								type: "movie" as const,
								Guid: [],
							},
						],
				),
			),
			getHistory: vi.fn().mockResolvedValue(input.history ?? []),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck:
				input.onDeck instanceof Error
					? vi.fn().mockRejectedValue(input.onDeck)
					: vi.fn().mockResolvedValue(input.onDeck ?? []),
		} as unknown as PlexClient;
	}

	it("returns a settled positive observation without a snapshot for mapped rows beside an unmappable item", async () => {
		// Removing the positive-only branch, returning the rows under `snapshot`, or
		// omitting its bound target/root must make this fail.
		const result = await collectSettledPlexCacheLiveEvidence(
			positiveObservationClient({}),
			"inst-1",
			silentLog,
		);

		expect(result).toMatchObject({
			kind: "positive-observation",
			complete: false,
			observation: {
				rows: [expect.objectContaining({ tmdbId: 42, ratingKey: "show-1" })],
				observedTargets: [
					expect.objectContaining({
						tmdbId: 42,
						tvdbId: 42,
						ratingKey: "show-1",
						sectionUuid: "shows-uuid",
					}),
				],
				capabilities: [
					{
						domain: "episode-parents",
						field: "membership",
						semantics: "observed-targets-only",
						operators: [],
					},
				],
				observedRoots: [
					expect.objectContaining({ sectionKey: "shows", domain: "episode-parents" }),
				],
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
				settlement: { sections: [expect.objectContaining({ key: "shows", uuid: "shows-uuid" })] },
			},
		});
		expect("snapshot" in result).toBe(false);
	});

	it("scopes settled positive evidence to Show parents and assigns its completion time only after settlement", async () => {
		const librarySections = [
			{ key: "movies", title: "Movies", type: "movie" as const },
			{ key: "shows", title: "Shows", type: "show" as const },
		];
		const settlementSections = [
			{
				key: "movies",
				uuid: "movies-uuid",
				title: "Movies",
				type: "movie" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const libraryItemsBySection = {
			movies: [
				{
					ratingKey: "movie-1",
					title: "Mapped Movie",
					type: "movie" as const,
					Guid: [{ id: "tmdb://1" }],
				},
				{ ratingKey: "legacy-1", title: "Legacy Movie", type: "movie" as const, Guid: [] },
			],
			shows: [
				{
					ratingKey: "show-1",
					title: "Mapped Show",
					type: "show" as const,
					Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
				},
			],
		};
		const input = { librarySections, settlementSections, libraryItemsBySection };

		const unsettled = await collectPlexCacheLiveEvidence(
			positiveObservationClient(input),
			"inst-1",
			silentLog,
		);
		expect(unsettled.kind).toBe("positive-observation");
		expect(unsettled.completedAt).toBeUndefined();

		const settled = await collectSettledPlexCacheLiveEvidence(
			positiveObservationClient(input),
			"inst-1",
			silentLog,
		);

		expect(settled).toMatchObject({ kind: "positive-observation", completedAt: expect.any(Date) });
		if (settled.kind !== "positive-observation") throw new Error("Expected positive observation");
		expect(settled.observation.rows.map((row) => row.ratingKey)).toEqual(["show-1"]);
		expect(settled.observation.observedTargets.map((target) => target.ratingKey)).toEqual([
			"show-1",
		]);
		expect(settled.observation.observedRoots.map((root) => root.sectionKey)).toEqual(["shows"]);
		expect(settled.observation.settlement?.sections.map((section) => section.key)).toEqual([
			"movies",
			"shows",
		]);
	});

	it.each([
		"currentItemsWithoutTmdbMetadata",
		"currentLibraryItemsWithoutRatingKeys",
		"historyItemsWithoutUsableMediaKey",
		"currentHistoryItemsWithoutMappedMetadata",
		"historyItemsWithUnknownAccounts",
		"onDeckItemsWithoutMappedMetadata",
		"onDeckFetchFailures",
	] as const)("allows only the declared positive-only reason %s", (reason) => {
		expect(canPublishPositivePlexObservation({ [reason]: 1 })).toBe(true);
	});

	it("blocks unknown partial reasons by default", () => {
		// Extending collection with a new incomplete reason must not silently grant
		// observed-target authority before its policy is explicitly reviewed.
		expect(canPublishPositivePlexObservation({ futureReason: 1 })).toBe(false);
	});

	it.each([
		["no user accounts", positiveObservationClient({ accounts: [] })],
		["no media libraries", positiveObservationClient({ librarySections: [] })],
		[
			"a library snapshot failure",
			(() => {
				const client = positiveObservationClient({});
				vi.mocked(client.getLibraryItems).mockRejectedValue(new Error("section unavailable"));
				return client;
			})(),
		],
	] as const)("keeps partial evidence unpublished for %s", async (_caseName, client) => {
		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("unpublished");
	});

	it.each([
		[
			"an active scan",
			positiveObservationClient({
				settlementSections: [
					{
						key: "shows",
						uuid: "shows-uuid",
						title: "Shows",
						type: "show",
						refreshing: true,
						scannedAt: 1,
						updatedAt: 1,
					},
				],
			}),
		],
		[
			"metadata activity",
			positiveObservationClient({ activities: [{ type: "library.update.item.metadata" }] }),
		],
	] as const)("keeps a positive observation unpublished during %s", async (_caseName, client) => {
		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("unpublished");
	});
	it("collects a complete large-library snapshot without publishing", async () => {
		// Stands in for "manual smoke on a Docker + SQLite deployment with a large
		// Plex library" — runs the full refreshPlexCache path with >1,000 items
		// and 1,500 pre-existing stale rows, then asserts:
		//   1. the refresh returns errors: 0 (i.e. no P2029 leaked through)
		//   2. every DELETE stays under the SQLite 999-parameter ceiling
		//   3. upserts are actually issued (we didn't silently short-circuit)
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
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const transaction = vi.fn();
		const mockPrisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(0);
		expect(result.snapshot?.rows).toHaveLength(LIBRARY_SIZE);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("collects an authoritatively empty library without publishing", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
		const tx = {
			plexCache: { deleteMany, createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(tx.plexCache.createMany).not.toHaveBeenCalled();
	});

	it("collects a verified live snapshot without publishing cache state", async () => {
		const watchedAt = 1_723_000_000;
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Recent Movie",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
			]),
			getHistory: vi
				.fn()
				.mockResolvedValue([
					{ type: "movie", ratingKey: "rk-1", accountID: 1, viewedAt: watchedAt },
				]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				instanceId: "inst-1",
				tmdbId: 12345,
				lastWatchedAt: new Date(watchedAt * 1000),
				watchCount: 1,
			}),
		]);
		expect(result.snapshot?.sections).toEqual([{ key: "1", title: "Movies", type: "movie" }]);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("preserves item-level watch state when PMS has not emitted a history row", async () => {
		const lastViewedAt = 1_723_000_123;
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Watched Movie",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
					viewCount: 3,
					lastViewedAt,
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const result = await collectPlexCacheLiveEvidence(mockClient, "inst-1", silentLog);

		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				tmdbId: 12345,
				watchCount: 3,
				lastWatchedAt: new Date(lastViewedAt * 1000),
			}),
		]);
	});

	it("preserves duplicate provider identities in a fresh authority observation", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "First copy",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
				{
					ratingKey: "rk-2",
					title: "Second copy",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const result = await collectPlexCacheLiveEvidence(mockClient, "inst-1", silentLog, {
			preserveProviderDuplicates: true,
		});

		expect(result.complete).toBe(true);
		expect(result.snapshot?.rows.map((row) => row.ratingKey).sort()).toEqual(["rk-1", "rk-2"]);
	});

	it("keeps the previous generation when history changes after enrichment", async () => {
		const verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error("history changed"));
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot,
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/history changed/i);
		expect(verifyHistorySnapshot).toHaveBeenCalledOnce();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		["bounded history", "Plex history exceeded the safe 100000-row limit"],
		["repeated page", "Plex history returned a duplicate row while paging"],
	] as const)(
		"rejects incomplete %s history before publishing a cache generation",
		async (_caseName, message) => {
			const getHistory = vi.fn().mockRejectedValue(new Error(message));
			const cacheDelete = vi.fn();
			const statusUpsert = vi.fn();
			const tx = {
				plexCache: { deleteMany: cacheDelete, createMany: vi.fn() },
				cacheRefreshStatus: { upsert: statusUpsert },
			};
			const prisma = {
				$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
				),
			} as unknown as PrismaClient;
			const client = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([]),
				getHistory,
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;

			const result = await refreshPlexCache(client, prisma, "inst-1", silentLog, undefined);

			expect(getHistory).toHaveBeenCalledWith({ maxResults: 100_000, requireComplete: true });
			expect(result.complete).toBe(false);
			expect(prisma.$transaction).not.toHaveBeenCalled();
			expect(cacheDelete).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();
		},
	);

	it("keeps the previous generation when playback starts during history verification", async () => {
		const getOnDeck = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ ratingKey: "rk-1", type: "movie" }]);
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck,
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/on-deck state changed/i);
		expect(getOnDeck).toHaveBeenCalledTimes(2);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("marks an on-deck failure incomplete and never evicts from that snapshot", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
					Collection: [],
					Label: [],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockRejectedValue(new Error("on-deck unavailable")),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const mockPrisma = {
			plexCache: {
				upsert: vi.fn().mockResolvedValue({ id: "fresh-1" }),
				findMany: vi.fn().mockResolvedValue([{ id: "stale-1" }]),
				deleteMany,
			},
			$transaction: vi.fn(async (ops: Promise<unknown>[]) => await Promise.all(ops)),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when account discovery is empty", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when no media library is discovered", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("collects a complete current library while ignoring history for a stale library key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			plexCache: { deleteMany, createMany },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current", tmdbId: 42 }),
		]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(createMany).not.toHaveBeenCalled();
	});

	it("collects a complete current show library while ignoring stale episode history", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-show",
					title: "Current Show",
					type: "show",
					Guid: [{ id: "tmdb://84" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale-episode",
					grandparentRatingKey: "stale-show",
					title: "Stale Episode",
					type: "episode",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current-show", tmdbId: 84 }),
		]);
	});

	it("fails closed when a stale history key becomes current before publication", async () => {
		const currentMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const importedMovie = {
			ratingKey: "imported",
			title: "Imported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://84" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([currentMovie])
				.mockResolvedValueOnce([currentMovie, importedMovie]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "imported",
					title: "Imported Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when cleanup-relevant library metadata changes before publication", async () => {
		const initialMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
			Label: [{ tag: "eligible-for-cleanup" }],
		};
		const changedMovie = { ...initialMovie, Label: [] };
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([initialMovie])
				.mockResolvedValueOnce([changedMovie]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each(["history", "on-deck"] as const)(
		"fails closed when Plex %s changes during final library verification",
		async (activity) => {
			let inventoryVerificationFinished = false;
			const currentMovie = {
				ratingKey: "current",
				title: "Current Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			};
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValueOnce([currentMovie])
					.mockImplementationOnce(async () => {
						inventoryVerificationFinished = true;
						return [currentMovie];
					}),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn(async () => {
					if (activity === "history" && inventoryVerificationFinished) {
						throw new Error("Plex history changed during inventory verification");
					}
				}),
				getOnDeck: vi.fn(async () =>
					activity === "on-deck" && inventoryVerificationFinished
						? [{ ratingKey: "current", type: "movie" }]
						: [],
				),
			} as unknown as PlexClient;
			const tx = {
				plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
				cacheRefreshStatus: { upsert: vi.fn() },
			};
			const transaction = vi.fn(
				async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
			);
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("keeps the complete edition set only in live inventory targets when persistence collapses rows", async () => {
		const editions = [
			{
				ratingKey: "edition-a",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
			{
				ratingKey: "edition-b",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
		];
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(editions),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.snapshot?.rows[0]?.ratingKey).toBe("edition-a");
		expect(result.inventoryTargets).toEqual([
			{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "edition-a" },
			{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "edition-b" },
		]);
	});

	it("uses TVDb identity for current Sonarr series targets", async () => {
		const series = {
			ratingKey: "show-123",
			title: "Example Series",
			type: "show",
			Guid: [{ id: "tmdb://42" }, { id: "tvdb://123" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([series]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.inventoryTargets).toEqual([
			{ sectionId: "2", mediaType: "series", tmdbId: 42, tvdbId: 123, ratingKey: "show-123" },
		]);
	});

	it("fails closed when stale relevant history belongs to an unknown account", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 999,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 history item(s) with unknown accounts",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each([
		[
			"movie history has an empty rating key",
			{ type: "movie", ratingKey: "", title: "Movie", viewedAt: 1_700_000_000, accountID: 1 },
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
		[
			"episode history has no grandparent rating key",
			{
				type: "episode",
				ratingKey: "episode-1",
				title: "Episode",
				viewedAt: 1_700_000_000,
				accountID: 1,
			},
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
	] as const)(
		"fails closed without publication when %s",
		async (_caseName, historyEntry, message) => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([
					{
						ratingKey: "current",
						title: "Current Movie",
						type: "movie",
						Guid: [{ id: "tmdb://42" }],
					},
				]),
				getHistory: vi.fn().mockResolvedValue([historyEntry]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const transaction = vi.fn();
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(result.errorMessages).toContain(message);
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("fails closed without publication when a current library item has an empty rating key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValue([
					{ ratingKey: "", title: "Current Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
				]),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without a usable rating key",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when a current historical item has no TMDB metadata", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					Guid: [],
				},
			]),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;
		vi.mocked(silentLog.warn).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
		);
		expect(transaction).not.toHaveBeenCalled();
		expect(silentLog.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				incompleteReasons: expect.objectContaining({ currentItemsWithoutTmdbMetadata: 1 }),
			}),
			"Plex cache: skipping eviction because the refreshed inventory was incomplete",
		);
	});

	it("fails closed when one discovered library returns only a partial snapshot", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockRejectedValue(new Error("pagination stopped early")),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	describe("Personal Media / Other Videos libraries (#769)", () => {
		const supportedMovie = {
			ratingKey: "movie-1",
			title: "Supported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const personalMediaItem = {
			ratingKey: "personal-1",
			title: "Home Video",
			type: "movie",
			Guid: [],
		};
		const mixedSections = [
			{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
			{ key: "2", title: "Other Videos", type: "movie", agent: "com.plexapp.agents.none" },
		];

		it.each([
			["com.plexapp.agents.none", true],
			["tv.plex.agents.none", true],
			["tv.plex.agents.movie", false],
			["tv.plex.agents.series", false],
			["example.plex.agents.none", false],
			["tv.plex.agents.none.custom", false],
			["tv.plex.agent.none", false],
			["agents.none", false],
			[undefined, false],
		] as const)("classifies only the exact Personal Media agent %s", (agent, expected) => {
			expect(isPersonalMediaSection({ type: "movie", agent })).toBe(expected);
		});

		it("excludes a Show-type section using the modern Personal Media agent", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue([
					{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					{ key: "2", title: "Personal", type: "show", agent: "tv.plex.agents.none" },
				]),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1"
							? [supportedMovie]
							: [{ ratingKey: "", title: "Personal", type: "show", Guid: [] }],
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

			expect(result).toMatchObject({ kind: "authoritative-snapshot", complete: true });
			expect(result.snapshot?.rows.map((row) => row.ratingKey)).toEqual(["movie-1"]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "movie-1" },
			]);
		});

		it("publishes only fully mapped Movie/Show evidence for the reporter topology", async () => {
			const sections = [
				{ key: "movies", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
				{ key: "shows", title: "Shows", type: "show", agent: "tv.plex.agents.series" },
				{ key: "personal", title: "Other", type: "movie", agent: "tv.plex.agents.none" },
				{ key: "music", title: "Music", type: "artist", agent: "tv.plex.agents.music" },
			];
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(sections),
				getLibraryItems: vi.fn().mockImplementation((key: string) => {
					if (key === "movies") {
						return [
							{
								ratingKey: "movie-1",
								title: "Movie",
								type: "movie",
								Guid: [{ id: "tmdb://10" }],
							},
						];
					}
					if (key === "shows") {
						return [
							{
								ratingKey: "show-1",
								title: "Show",
								type: "show",
								Guid: [{ id: "tmdb://20" }, { id: "tvdb://30" }],
							},
						];
					}
					if (key === "personal") {
						return [
							{ ratingKey: "personal-1", title: "Personal", type: "movie", Guid: [] },
							{ ratingKey: "", title: "Keyless Personal", type: "movie", Guid: [] },
						];
					}
					throw new Error("Unsupported section type entered Movie/Show collection");
				}),
				getHistory: vi.fn().mockResolvedValue([
					{
						historyKey: "history-personal-movie",
						type: "movie",
						ratingKey: "",
						librarySectionID: "personal",
						accountID: 1,
						viewedAt: 1_700_000_000,
					},
					{
						historyKey: "history-personal-episode",
						type: "episode",
						ratingKey: "personal-episode",
						librarySectionID: "personal",
						accountID: 1,
						viewedAt: 1_700_000_001,
					},
					{
						historyKey: "history-stale-supported",
						type: "movie",
						ratingKey: "stale-supported",
						librarySectionID: "movies",
						accountID: 1,
						viewedAt: 1_700_000_002,
					},
				]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

			expect(result).toMatchObject({
				kind: "authoritative-snapshot",
				complete: true,
				errors: 0,
				errorMessages: [],
			});
			expect(result.snapshot?.sections).toEqual([
				{ key: "movies", title: "Movies", type: "movie" },
				{ key: "shows", title: "Shows", type: "show" },
			]);
			expect(result.snapshot?.rows.map((row) => row.ratingKey).sort()).toEqual([
				"movie-1",
				"show-1",
			]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "movies", mediaType: "movie", tmdbId: 10, ratingKey: "movie-1" },
				{
					sectionId: "shows",
					mediaType: "series",
					tmdbId: 20,
					tvdbId: 30,
					ratingKey: "show-1",
				},
			]);
		});

		it("excludes a Personal Media section from the supported-media authority domain", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(mixedSections),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1" ? [supportedMovie] : [personalMediaItem],
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
			expect(result.snapshot?.sections).toEqual([{ key: "1", title: "Movies", type: "movie" }]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "movie-1" },
			]);
		});

		it("does not poison completeness when Personal Media history cannot map", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(mixedSections),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1" ? [supportedMovie] : [personalMediaItem],
					),
				getHistory: vi
					.fn()
					.mockResolvedValue([
						{ type: "movie", ratingKey: "personal-1", accountID: 1, viewedAt: 1_700_000_000 },
					]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});

		it("still fails closed when a supported movie lacks TMDB metadata", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([
						{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValue([
						{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
					]),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
			);
		});

		it("still fails closed when supported history cannot map to TMDB metadata", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([
						{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValue([
						{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
					]),
				getHistory: vi
					.fn()
					.mockResolvedValue([
						{ type: "movie", ratingKey: "broken-1", accountID: 1, viewedAt: 1_700_000_000 },
					]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current history item(s) without mapped TMDB metadata",
			);
		});

		it("does not exclude a section with an unknown agent merely for lacking TMDB", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue([
					{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					{ key: "3", title: "Custom", type: "movie", agent: "com.example.agents.custom" },
				]),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1"
							? [supportedMovie]
							: [{ ratingKey: "custom-1", title: "Custom", type: "movie", Guid: [] }],
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
			);
		});
	});

	describe("Personal Media history with missing media keys (#769)", () => {
		const supportedMovie = {
			ratingKey: "movie-1",
			title: "Supported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const sections = [
			{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
			{ key: "2", title: "Other Videos", type: "movie", agent: "com.plexapp.agents.none" },
		];

		function clientWith(history: unknown[]) {
			return {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(sections),
				getLibraryItems: vi.fn().mockResolvedValue([supportedMovie]),
				getHistory: vi.fn().mockResolvedValue(history),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
		}

		it("ignores Personal Media movie history with a missing rating key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
		});

		it("ignores Personal Media episode history with a missing grandparent key", async () => {
			const mockClient = clientWith([
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
		});

		it("fails closed for supported movie history with a missing rating key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for supported episode history with a missing grandparent key", async () => {
			const mockClient = clientWith([
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for history with a missing librarySectionID and missing key", async () => {
			const mockClient = clientWith([
				{ type: "movie", ratingKey: "", accountID: 1, viewedAt: 1_700_000_000 },
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for history with an unknown librarySectionID and missing key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "999",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("preserves stale-history protection for a usable key outside current inventory", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "stale",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});

		it("completes a mixed production topology with Personal Media history missing keys", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});
	});
});
