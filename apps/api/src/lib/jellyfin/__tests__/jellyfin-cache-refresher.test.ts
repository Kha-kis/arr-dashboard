/**
 * Jellyfin Cache Refresher Tests
 *
 * Validates the aggregation logic inside refreshJellyfinCache, with a focus
 * on the partially-watched series fix: lastWatchedAt should be set whenever
 * lastPlayedDate is present, even if item.played === false.
 */

import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	collectJellyfinCacheLiveEvidence,
	JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE,
	JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
	refreshJellyfinCache as refreshGuardedJellyfinCache,
} from "../jellyfin-cache-refresher.js";
import type {
	JellyfinClient,
	JellyfinItem,
	JellyfinLibrary,
	JellyfinUser,
} from "../jellyfin-client.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../jellyfin-generation-metadata.js";

const publication = vi.hoisted(() => ({ client: undefined as JellyfinClient | undefined }));

vi.mock("../jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.client) throw new Error("Jellyfin test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

vi.mock("../../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: vi.fn(
			async (
				prisma: {
					$transaction: (
						callback: (tx: unknown) => Promise<unknown>,
						options?: unknown,
					) => Promise<unknown>;
				},
				_instance: unknown,
				_log: unknown,
				collect: () => Promise<unknown>,
				publish: (tx: unknown, snapshot: unknown) => Promise<unknown>,
				options: unknown,
			) => {
				const snapshot = await collect();
				if ((snapshot as { complete?: boolean }).complete !== true) return snapshot;
				return await prisma.$transaction(async (tx) => await publish(tx, snapshot), {
					isolationLevel: "Serializable",
					...(options as object),
				});
			},
		),
	};
});

async function refreshJellyfinCache(
	client: JellyfinClient,
	prisma: never,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: string,
	options?: { publish?: boolean; service?: "JELLYFIN" | "EMBY" },
) {
	ensureCoverageMethod(client);
	if (options?.publish === false) {
		return await collectJellyfinCacheLiveEvidence(client, instanceId, log);
	}
	publication.client = client;
	return await refreshGuardedJellyfinCache({
		prisma,
		instance: {
			id: instanceId,
			userId: "user-1",
			service: options?.service ?? "JELLYFIN",
			label: "Jellyfin",
			baseUrl: "https://jellyfin-current.example.com",
			apiKey: "key",
			httpAuthHeaders: {},
			enabled: true,
			encryptedApiKey: "current-key",
			encryptionIv: "current-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: "jellyfin-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 7,
			identityGeneration: 3,
		},
		log,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeSeriesItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
	return {
		id: "jf-series-1",
		name: "Amadeus",
		type: "Series",
		tmdbId: 99999,
		played: false,
		playCount: 0,
		lastPlayedDate: null,
		isFavorite: false,
		imageTags: {},
		...overrides,
	};
}

function makeMovieItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
	return makeSeriesItem({
		id: "jf-movie-1",
		name: "Amadeus",
		type: "Movie",
		tmdbId: 279,
		...overrides,
	});
}

function makeBoxSetItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
	return makeSeriesItem({
		id: "jf-boxset-1",
		name: "Favorites",
		type: "BoxSet",
		tmdbId: undefined,
		...overrides,
	});
}

const oneUser: JellyfinUser[] = [{ id: "user-1", name: "Alice" }];
const oneLibrary: JellyfinLibrary[] = [
	{ id: "lib-1", name: "TV Shows", collectionType: "tvshows" },
];

/**
 * Build a minimal mock JellyfinClient that serves the given library items.
 */
function makeMockClient(items: JellyfinItem[]): JellyfinClient {
	return {
		getUsers: vi.fn().mockResolvedValue(oneUser),
		getLibraries: vi.fn().mockResolvedValue(oneLibrary),
		getLibraryItems: vi.fn().mockResolvedValue(items),
		getLibraryItemsWithCoverage: vi.fn(async function (
			this: JellyfinClient,
			...args: Parameters<JellyfinClient["getLibraryItems"]>
		) {
			const result = await this.getLibraryItems(...args);
			return {
				items: result,
				expectedRawCount: result.length,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: result.length,
				reason: null,
			};
		}),
		getResumeItems: vi.fn().mockResolvedValue([]),
		getNextUp: vi.fn().mockResolvedValue([]),
	} as unknown as JellyfinClient;
}

function ensureCoverageMethod(client: JellyfinClient): JellyfinClient {
	const candidate = client as JellyfinClient & {
		getLibraryItemsWithCoverage?: JellyfinClient["getLibraryItemsWithCoverage"];
	};
	if (!candidate.getLibraryItemsWithCoverage) {
		candidate.getLibraryItemsWithCoverage = vi.fn(async function (
			this: JellyfinClient,
			...args: Parameters<JellyfinClient["getLibraryItems"]>
		) {
			const result = await this.getLibraryItems(...args);
			return {
				items: result,
				expectedRawCount: result.length,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: result.length,
				reason: null,
			};
		});
	}
	return client;
}

/**
 * Build a minimal Prisma stub that captures upsert payloads.
 */
function makeMockPrisma() {
	const upserts: unknown[] = [];
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: {
			findUnique: vi.fn().mockResolvedValue({
				service: "JELLYFIN",
				baseUrl: "https://jellyfin-current.example.com",
				encryptedApiKey: "current-key",
				encryptionIv: "current-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: true,
				connectionGeneration: 7,
			}),
		},
		jellyfinCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				for (const row of data) upserts.push({ create: row });
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
	};
	const stub = {
		jellyfinCache: tx.jellyfinCache,
		cacheRefreshStatus: tx.cacheRefreshStatus,
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	};
	return { stub, upserts, tx };
}

function receiptFrom(result: unknown):
	| {
			version: number;
			provider: string;
			evidence: string;
			units: Array<Record<string, unknown>>;
	  }
	| undefined {
	return (
		result as {
			receipt?: {
				version: number;
				provider: string;
				evidence: string;
				units: Array<Record<string, unknown>>;
			};
		}
	).receipt;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshJellyfinCache — lastWatchedAt aggregation", () => {
	it("publishes a large cache through bounded createMany calls", async () => {
		const itemCount = JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE * 2 + 17;
		const items = Array.from({ length: itemCount }, (_, index) =>
			makeSeriesItem({
				id: `jf-series-${index}`,
				name: `Series ${index}`,
				tmdbId: 100_000 + index,
			}),
		);
		const client = makeMockClient(items);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: itemCount });
		expect(tx.jellyfinCache.createMany).toHaveBeenCalledTimes(3);
		for (const [call] of tx.jellyfinCache.createMany.mock.calls) {
			expect(call.data.length).toBeLessThanOrEqual(JELLYFIN_CACHE_PUBLICATION_CHUNK_SIZE);
		}
		expect(stub.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS }),
		);
	});

	it("sets lastWatchedAt for a fully-watched series (item.played === true)", async () => {
		const item = makeSeriesItem({
			played: true,
			playCount: 2,
			lastPlayedDate: "2024-05-10T20:00:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-05-10T20:00:00Z"));
	});

	it("sets lastWatchedAt for a partially-watched series (played=false, lastPlayedDate set)", async () => {
		// This is the regression case: user watched 2/5 episodes but not all.
		// Jellyfin marks the Series item as played=false, but still sets lastPlayedDate.
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: "2024-06-15T18:30:00Z",
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null; watchCount: number } })
			.create;
		// lastWatchedAt must be set so the episode-cache refresher picks up this series
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-15T18:30:00Z"));
		// watchCount stays 0 — the series wasn't fully watched
		expect(payload.watchCount).toBe(0);
	});

	it("leaves lastWatchedAt null when neither played nor lastPlayedDate is set", async () => {
		const item = makeSeriesItem({
			played: false,
			playCount: 0,
			lastPlayedDate: null,
		});
		const client = makeMockClient([item]);
		const { stub, upserts } = makeMockPrisma();

		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toBeNull();
	});

	it("picks the most recent lastPlayedDate across multiple users for the same series", async () => {
		// Simulate the per-user iteration: same series returned for two users with
		// different lastPlayedDate values — we want the latest date to win.
		const olderItem = makeSeriesItem({ lastPlayedDate: "2024-03-01T10:00:00Z" });
		const newerItem = makeSeriesItem({ lastPlayedDate: "2024-06-20T22:00:00Z" });

		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];

		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			// First call (Alice) returns older, second call (Bob) returns newer
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([olderItem])
				.mockResolvedValueOnce([newerItem]),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;

		const { stub, upserts } = makeMockPrisma();
		await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(upserts).toHaveLength(1);
		const payload = (upserts[0] as { create: { lastWatchedAt: Date | null } }).create;
		expect(payload.lastWatchedAt).toEqual(new Date("2024-06-20T22:00:00Z"));
	});

	it("discovers and scans media libraries visible only to a later user", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const aliceLibrary: JellyfinLibrary = {
			id: "lib-alice",
			name: "Alice TV",
			collectionType: "tvshows",
		};
		const bobLibrary: JellyfinLibrary = {
			id: "lib-bob",
			name: "Bob Movies",
			collectionType: "movies",
		};
		const bobMovie = makeSeriesItem({
			id: "jf-movie-bob",
			name: "Bob's Recent Movie",
			type: "Movie",
			tmdbId: 4242,
			played: true,
			playCount: 1,
			lastPlayedDate: "2026-08-09T20:00:00Z",
		});
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn(async (userId: string) =>
				userId === "user-1" ? [aliceLibrary] : [bobLibrary],
			),
			getLibraryItems: vi.fn(async (userId: string, libraryId: string) => {
				if (userId === "user-2" && libraryId === "lib-bob") return [bobMovie];
				return [];
			}),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(client.getLibraries).toHaveBeenNthCalledWith(1, "user-1");
		expect(client.getLibraries).toHaveBeenNthCalledWith(2, "user-2");
		expect(client.getLibraryItems).toHaveBeenCalledWith(
			"user-2",
			"lib-bob",
			expect.objectContaining({ includeItemTypes: "Movie" }),
		);
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({
			create: {
				libraryId: "lib-bob",
				lastWatchedAt: new Date("2026-08-09T20:00:00Z"),
				watchCount: 1,
				watchedByUsers: '["Bob"]',
			},
		});
	});

	it("emits one source-conserving receipt unit for overlapping user/library visibility", async () => {
		const users: JellyfinUser[] = [
			{ id: "u1", name: "Alice" },
			{ id: "u2", name: "Bob" },
		];
		const libraries: JellyfinLibrary[] = [
			{ id: "l1", name: "Shared Library", collectionType: "CollectionFolder" },
		];
		const visibleItems = [
			makeMovieItem({ id: "source-a", tmdbId: 42, name: "Edition A" }),
			makeMovieItem({ id: "source-b", tmdbId: 42, name: "Edition B" }),
			makeSeriesItem({ id: "source-series", tmdbId: 84, name: "Series" }),
			makeBoxSetItem({ id: "container-1", name: "Favorites" }),
		];
		const client = {
			getUsers: vi.fn().mockResolvedValue(users),
			getLibraries: vi.fn().mockResolvedValue(libraries),
			getLibraryItems: vi.fn().mockResolvedValue(visibleItems),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		ensureCoverageMethod(client);

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);
		const receipt = receiptFrom(result);

		expect(receipt).toBeDefined();
		expect(receipt).toMatchObject({
			version: 2,
			provider: "jellyfin",
			evidence: "complete",
			units: expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:u1/library:l1",
					expectedRawCount: 4,
					rawObserved: 4,
					sourceBindings: 3,
					canonicalEntities: 2,
					acceptedSkips: [{ reason: "known-container", count: 1 }],
					fatalCount: 0,
				}),
				expect.objectContaining({
					scopeKey: "user:u2/library:l1",
					expectedRawCount: 4,
					rawObserved: 4,
					sourceBindings: 3,
					canonicalEntities: 2,
					acceptedSkips: [{ reason: "known-container", count: 1 }],
					fatalCount: 0,
				}),
			]),
			publishedCanonicalEntities: 2,
		});
		// The two provider editions share one canonical media/library identity, while
		// the receipt still accounts for both source bindings before deduplication.
		expect(result.snapshot?.rows).toHaveLength(2);
		expect(result.complete).toBe(true);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			valid: true,
			complete: false,
		});
	});

	it("selects the same representative fields regardless of source order", async () => {
		const higher = makeMovieItem({
			id: "source-z",
			name: "Zed Edition",
			dateCreated: "2024-01-01T00:00:00Z",
			imageTags: { Primary: "z-tag" },
		});
		const lower = makeMovieItem({
			id: "source-a",
			name: "Alpha Edition",
			dateCreated: "2025-01-01T00:00:00Z",
			imageTags: { Primary: "a-tag" },
		});
		const collect = async (items: JellyfinItem[]) =>
			await collectJellyfinCacheLiveEvidence(makeMockClient(items), "inst-1", silentLog, {
				attemptStartedAt: new Date("2026-01-01T00:00:00Z"),
				observedAt: new Date("2026-01-01T00:01:00Z"),
			});

		const forward = await collect([higher, lower]);
		const reverse = await collect([lower, higher]);
		expect(forward.snapshot?.rows).toEqual(reverse.snapshot?.rows);
		expect(forward.snapshot?.rows[0]).toMatchObject({
			jellyfinId: "source-a",
			title: "Alpha Edition",
			addedAt: new Date("2025-01-01T00:00:00Z"),
			thumb: "/Items/source-a/Images/Primary",
		});
		expect(evaluateProviderCoverageReceipt(forward.receipt)).toMatchObject({
			valid: true,
			complete: false,
		});
	});

	it("selects a stable library label across overlapping user visibility", async () => {
		const users: JellyfinUser[] = [
			{ id: "user-z", name: "Zed" },
			{ id: "user-a", name: "Alpha" },
		];
		const collect = async (orderedUsers: JellyfinUser[]) => {
			const client = {
				getUsers: vi.fn().mockResolvedValue(orderedUsers),
				getLibraries: vi.fn(async (userId: string) => [
					{
						id: "shared-library",
						name: userId === "user-z" ? "Zeta Library" : "Alpha Library",
						collectionType: "movies",
					},
				]),
				getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
					items: [makeMovieItem({ id: "shared-source", tmdbId: 42 })],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					reason: null,
				}),
				getResumeItems: vi.fn().mockResolvedValue([]),
				getNextUp: vi.fn().mockResolvedValue([]),
			} as unknown as JellyfinClient;
			return await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog, {
				attemptStartedAt: new Date("2026-01-01T00:00:00Z"),
				observedAt: new Date("2026-01-01T00:01:00Z"),
			});
		};

		const forward = await collect(users);
		const reverse = await collect([...users].reverse());

		expect(forward.snapshot?.rows).toEqual(reverse.snapshot?.rows);
		expect(forward.snapshot?.rows[0]?.libraryName).toBe("Alpha Library");
	});

	it("binds an EMBY service snapshot to an emby receipt", async () => {
		const client = makeMockClient([makeMovieItem()]);
		const { stub } = makeMockPrisma();
		const result = await refreshJellyfinCache(
			client,
			stub as never,
			"inst-1",
			silentLog,
			undefined,
			{ service: "EMBY" },
		);

		expect(result.complete).toBe(true);
		expect(result.receipt?.provider).toBe("emby");
	});

	it("fails closed when any user's library inventory is unavailable", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi
				.fn()
				.mockResolvedValueOnce(oneLibrary)
				.mockRejectedValueOnce(new Error("Bob's library inventory was truncated")),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const transaction = vi.fn();
		const stub = { jellyfinCache: { deleteMany }, $transaction: transaction };
		const warn = vi.fn();
		const error = vi.fn();
		const privacyLog = { warn, error } as unknown as FastifyBaseLogger;

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", privacyLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(result.errorMessages).toContain("library-discovery-failed");
		expect(JSON.stringify(result.errorMessages)).not.toContain(
			"Bob's library inventory was truncated",
		);
		const serializedLogCalls = JSON.stringify({ warn: warn.mock.calls, error: error.mock.calls });
		expect(serializedLogCalls).not.toContain("Bob's library inventory was truncated");
		expect(serializedLogCalls).not.toContain("Bob");
		const logArguments = [...warn.mock.calls, ...error.mock.calls].flat();
		expect(
			logArguments.some(
				(value) =>
					value instanceof Error ||
					(typeof value === "object" &&
						value !== null &&
						Object.values(value).some((nested) => nested instanceof Error)),
			),
		).toBe(false);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		const receipt = receiptFrom(result);
		expect(receipt).toMatchObject({
			version: 1,
			provider: "jellyfin",
			evidence: "unknown",
			units: expect.any(Array),
		});
	});

	it("evicts stale rows when a discovered library is authoritatively empty", async () => {
		const client = makeMockClient([]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
	});

	it("fails closed with unknown receipt evidence when user discovery is unavailable", async () => {
		const privateFailure = "private user endpoint detail";
		const client = {
			getUsers: vi.fn().mockRejectedValue(new Error(privateFailure)),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const transaction = vi.fn();
		const stub = { jellyfinCache: { deleteMany }, $transaction: transaction };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);
		const receipt = receiptFrom(result);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({
			version: 1,
			provider: "jellyfin",
			evidence: "unknown",
			units: [],
		});
		expect(JSON.stringify(receipt)).not.toContain(privateFailure);
	});

	it("fails closed without evicting when user discovery is empty", async () => {
		const client = {
			getUsers: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { deleteMany } };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
		const receipt = receiptFrom(result);
		expect(receipt).toMatchObject({
			version: 1,
			provider: "jellyfin",
			evidence: "unknown",
			units: [],
		});
	});

	it.each([
		[
			"duplicate user IDs",
			[
				{ id: "same-user", name: "Alice" },
				{ id: "same-user", name: "Bob" },
			],
		],
		["blank user IDs", [{ id: "", name: "Alice" }]],
	] as const)("fails closed for %s", async (_description, users) => {
		const client = {
			getUsers: vi.fn().mockResolvedValue(users),
		} as unknown as JellyfinClient;

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(evaluateProviderCoverageReceipt(result.receipt)).toMatchObject({
			valid: true,
			complete: false,
		});
		expect(JSON.stringify(result.errorMessages)).not.toContain("same-user");
	});

	it("fails closed for duplicate library IDs without an invalid receipt", async () => {
		const client = {
			getUsers: vi.fn().mockResolvedValue(oneUser),
			getLibraries: vi.fn().mockResolvedValue([
				{ id: "duplicate-library", name: "One", collectionType: "movies" },
				{ id: "duplicate-library", name: "Two", collectionType: "movies" },
			]),
		} as unknown as JellyfinClient;

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errorMessages).toContain("invalid-library-identity");
		expect(evaluateProviderCoverageReceipt(result.receipt)).toMatchObject({
			valid: true,
			complete: false,
		});
	});

	it("leaves the previous generation unchanged when atomic publication fails", async () => {
		const client = makeMockClient([]);
		const stub = {
			$transaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(result.errorMessages).toContainEqual(
			expect.stringContaining("Atomic cache publication failed"),
		);
	});

	it("aggregates on-deck evidence across every discovered user", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const item = makeSeriesItem();
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			getLibraryItems: vi.fn().mockResolvedValue([item]),
			getResumeItems: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{
						id: "episode-1",
						name: "Pilot",
						type: "Episode",
						seriesId: item.id,
						played: false,
						playCount: 0,
						lastPlayedDate: null,
						isFavorite: false,
					},
				]),
			getNextUp: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(true);
		expect(client.getResumeItems).toHaveBeenCalledTimes(2);
		expect((upserts[0] as { create: { onDeck: boolean } }).create.onDeck).toBe(true);
	});

	it("fails closed when any user's on-deck inventory is unavailable", async () => {
		const twoUsers: JellyfinUser[] = [
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		];
		const client = {
			getUsers: vi.fn().mockResolvedValue(twoUsers),
			getLibraries: vi.fn().mockResolvedValue(oneLibrary),
			getLibraryItems: vi.fn().mockResolvedValue([makeSeriesItem()]),
			getResumeItems: vi.fn().mockResolvedValue([]),
			getNextUp: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockRejectedValueOnce(new Error("next-up unavailable")),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = {
			jellyfinCache: {
				upsert: vi.fn().mockResolvedValue({ id: "fresh-1" }),
				findMany: vi.fn(),
				deleteMany,
			},
			$transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBe(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("publishes mapped library rows when on-deck independently fails", async () => {
		const mappedMovie = makeMovieItem({ id: "movie-mapped", tmdbId: 101 });
		const mappedSeries = makeSeriesItem({ id: "series-mapped", tmdbId: 202 });
		const missingMapping = makeMovieItem({ id: "movie-unmapped", tmdbId: undefined });
		const client = {
			getUsers: vi.fn().mockResolvedValue(oneUser),
			getLibraries: vi
				.fn()
				.mockResolvedValue([
					{ id: "library-1", name: "Library", collectionType: "CollectionFolder" },
				]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
				items: [mappedMovie, mappedSeries, missingMapping],
				expectedRawCount: 3,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 3,
				reason: null,
			}),
			getResumeItems: vi.fn().mockRejectedValue(new Error("on-deck unavailable")),
			getNextUp: vi.fn().mockRejectedValue(new Error("on-deck unavailable")),
		} as unknown as JellyfinClient;

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog, {
			attemptStartedAt: new Date("2026-09-06T12:00:00.000Z"),
			observedAt: new Date("2026-09-06T12:01:00.000Z"),
		});

		expect(result.snapshot?.rows).toHaveLength(2);
		expect(result.snapshot?.rows.map((row) => row.tmdbId).sort()).toEqual([101, 202]);
		expect(result.receipt.version).toBe(2);
		expect((result.receipt as { domains: unknown[] }).domains).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ domain: "library-inventory", valueSemantics: "exact" }),
				expect.objectContaining({ domain: "mapping", valueSemantics: "lower-bound" }),
				expect.objectContaining({ domain: "on-deck", valueSemantics: "unknown" }),
			]),
		);
	});

	it("keeps missing and invalid watch facts non-authoritative while retaining inventory", async () => {
		const client = makeMockClient([
			makeMovieItem({ id: "missing-watch", tmdbId: 301 }),
			makeMovieItem({
				id: "invalid-watch",
				tmdbId: 302,
				played: true,
				playCount: Number.NaN,
				lastPlayedDate: "not-a-date",
			}),
			makeMovieItem({
				id: "negative-watch",
				tmdbId: 303,
				played: true,
				playCount: -1,
				lastPlayedDate: "2026-09-06T12:00:00.000Z",
			}),
			makeMovieItem({
				id: "positive-watch",
				tmdbId: 304,
				played: true,
				playCount: 2,
				lastPlayedDate: "2026-09-06T12:00:00.000Z",
			}),
		]);

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog, {
			attemptStartedAt: new Date("2026-09-06T12:00:00.000Z"),
			observedAt: new Date("2026-09-06T12:01:00.000Z"),
		});

		expect(result.snapshot?.rows).toHaveLength(4);
		expect(result.snapshot?.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					jellyfinId: "missing-watch",
					watchCount: 0,
					lastWatchedAt: null,
				}),
				expect.objectContaining({
					jellyfinId: "invalid-watch",
					watchCount: 0,
					lastWatchedAt: null,
				}),
				expect.objectContaining({ jellyfinId: "negative-watch", watchCount: 0 }),
				expect.objectContaining({
					jellyfinId: "positive-watch",
					watchCount: 2,
					lastWatchedAt: new Date("2026-09-06T12:00:00.000Z"),
				}),
			]),
		);
		expect(result.receipt).toMatchObject({ evidence: "complete" });
		expect(result.receipt).toEqual(
			expect.objectContaining({
				domains: expect.arrayContaining([
					expect.objectContaining({
						domain: "watch-count",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
					}),
					expect.objectContaining({
						domain: "watch-attribution",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
					}),
				]),
			}),
		);
	});

	it("does not turn normalized missing watch data into exact zero evidence", async () => {
		const result = await collectJellyfinCacheLiveEvidence(
			makeMockClient([makeMovieItem({ id: "unwatched", tmdbId: 305 })]),
			"inst-1",
			silentLog,
		);

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.receipt).toEqual(
			expect.objectContaining({
				domains: expect.arrayContaining([
					expect.objectContaining({
						domain: "watch-count",
						evidence: "unknown",
						valueSemantics: "unknown",
					}),
					expect.objectContaining({
						domain: "watch-attribution",
						evidence: "unknown",
						valueSemantics: "unknown",
					}),
				]),
			}),
		);
	});

	it.each([
		[
			"positive-watch",
			makeMovieItem({
				id: "owned-positive-watch",
				tmdbId: 306,
				played: true,
				playCount: 2,
				lastPlayedDate: "2026-09-06T12:00:00.000Z",
			}),
		],
		["no-watch", makeMovieItem({ id: "owned-no-watch", tmdbId: 307 })],
	] as const)("encodes an owned V2 collection with %s watch facts", async (_label, item) => {
		const result = await collectJellyfinCacheLiveEvidence(
			makeMockClient([item]),
			"inst-1",
			silentLog,
			{
				attemptStartedAt: new Date("2026-09-06T12:00:00.000Z"),
				observedAt: new Date("2026-09-06T12:01:00.000Z"),
			},
		);
		const { snapshot, receipt } = result;
		if (!snapshot || !receipt) throw new Error("collection fixture did not publish");

		expect(() =>
			encodeJellyfinLibraryGenerationMetadata({
				version: 1,
				provider: "jellyfin",
				cacheType: "jellyfin",
				publicationLevel: "authoritative",
				completeness: "complete",
				canonicalizationVersion: 1,
				itemCount: snapshot.rows.length,
				connectionGeneration: 7,
				identityGeneration: 3,
				contentFingerprint: fingerprintJellyfinLibraryRows(snapshot.rows),
				coverageReceipt: receipt,
			}),
		).not.toThrow();
	});

	it("fails closed without evicting when media library discovery is empty", async () => {
		const client = {
			getUsers: vi.fn().mockResolvedValue(oneUser),
			getLibraries: vi.fn().mockResolvedValue([]),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { deleteMany } };

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(receiptFrom(result)).toMatchObject({
			version: 1,
			provider: "jellyfin",
			evidence: "unknown",
			units: expect.any(Array),
		});
	});

	it("fails closed without evicting when a library inventory is partial", async () => {
		const client = {
			...makeMockClient([]),
			getLibraryItems: vi.fn(() => {
				throw new Error("legacy array boundary must not be used");
			}),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
				items: [],
				expectedRawCount: 2_000,
				pagesAttempted: 2,
				pagesCompleted: 1,
				rawObserved: 1_000,
				reason: "page-failure",
			}),
		} as unknown as JellyfinClient;
		const deleteMany = vi.fn();
		const stub = { jellyfinCache: { findMany: vi.fn(), deleteMany }, $transaction: vi.fn() };
		const coverageClient = client as unknown as {
			getLibraryItemsWithCoverage: ReturnType<typeof vi.fn>;
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(coverageClient.getLibraryItemsWithCoverage).toHaveBeenCalledWith("user-1", "lib-1", {
			includeItemTypes: "Series",
		});
		expect(client.getLibraryItems).not.toHaveBeenCalled();
		expect(receiptFrom(result)).toMatchObject({
			version: 1,
			provider: "jellyfin",
			evidence: "unknown",
			units: expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/library:lib-1",
					expectedRawCount: 2_000,
					pagesAttempted: 2,
					pagesCompleted: 1,
					rawObserved: 1_000,
					sourceBindings: 0,
					canonicalEntities: 0,
					acceptedSkips: [],
					fatalCount: 1,
				}),
			]),
		});
		const receipt = receiptFrom(result);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			valid: true,
			complete: false,
		});
	});

	it("ignores a BoxSet alongside a Series without blocking cache publication", async () => {
		const client = makeMockClient([makeSeriesItem(), makeBoxSetItem()]);
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({ create: { jellyfinId: "jf-series-1" } });
		expect(receiptFrom(result)?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/library:lib-1",
					expectedRawCount: 2,
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [{ reason: "known-container", count: 1 }],
					fatalCount: 0,
				}),
			]),
		);
	});

	it("ignores a BoxSet alongside a Movie without blocking cache publication", async () => {
		const movieLibrary: JellyfinLibrary[] = [
			{ id: "lib-movies", name: "Movies", collectionType: "movies" },
		];
		const client = {
			...makeMockClient([]),
			getLibraries: vi.fn().mockResolvedValue(movieLibrary),
			getLibraryItems: vi.fn().mockResolvedValue([makeMovieItem(), makeBoxSetItem()]),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		expect(client.getLibraryItems).toHaveBeenCalledWith("user-1", "lib-movies", {
			includeItemTypes: "Movie",
		});
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({ create: { jellyfinId: "jf-movie-1" } });
	});

	it("publishes an authoritative empty cache when a library contains only BoxSets", async () => {
		const client = makeMockClient([
			makeBoxSetItem(),
			makeBoxSetItem({ id: "jf-boxset-2", name: "Favorites 2" }),
		]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).toHaveBeenCalledWith({ where: { instanceId: "inst-1" } });
		expect(tx.jellyfinCache.createMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
		expect(receiptFrom(result)?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/library:lib-1",
					expectedRawCount: 2,
					rawObserved: 2,
					sourceBindings: 0,
					canonicalEntities: 0,
					acceptedSkips: [{ reason: "known-container", count: 2 }],
					fatalCount: 0,
				}),
			]),
		);
	});

	it("ignores several BoxSets across independently scanned libraries", async () => {
		const libraries: JellyfinLibrary[] = [
			{ id: "lib-movies", name: "Movies", collectionType: "movies" },
			{ id: "lib-series", name: "Series", collectionType: "tvshows" },
		];
		const client = {
			...makeMockClient([]),
			getLibraries: vi.fn().mockResolvedValue(libraries),
			getLibraryItems: vi.fn(async (_userId: string, libraryId: string) =>
				libraryId === "lib-movies"
					? [
							makeMovieItem(),
							makeBoxSetItem(),
							makeBoxSetItem({ id: "jf-boxset-2", name: "Favorites 2" }),
						]
					: [makeSeriesItem(), makeBoxSetItem({ id: "jf-boxset-3", name: "Favorites 3" })],
			),
		} as unknown as JellyfinClient;
		const { stub, upserts } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 2 });
		expect(client.getLibraryItems).toHaveBeenCalledTimes(2);
		expect(upserts).toHaveLength(2);
		expect(upserts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ create: expect.objectContaining({ jellyfinId: "jf-movie-1" }) }),
				expect.objectContaining({ create: expect.objectContaining({ jellyfinId: "jf-series-1" }) }),
			]),
		);
	});

	it("continues to fail closed for unexpected non-BoxSet library item types", async () => {
		const unexpected = makeSeriesItem({
			id: "jf-playlist-1",
			name: "Unexpected playlist",
			type: "Playlist",
			tmdbId: undefined,
		});
		const client = makeMockClient([makeSeriesItem(), unexpected]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(stub.$transaction).not.toHaveBeenCalled();
		expect(receiptFrom(result)?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/library:lib-1",
					expectedRawCount: 2,
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [{ reason: "unsupported-provider-object", count: 1 }],
					fatalCount: 0,
				}),
			]),
		);
	});

	it("fails closed without evicting when a relevant item has no TMDb mapping", async () => {
		const client = makeMockClient([makeSeriesItem({ tmdbId: undefined })]);
		const deleteMany = vi.fn();
		const stub = {
			jellyfinCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		};

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0 });
		expect(deleteMany).not.toHaveBeenCalled();
		expect(receiptFrom(result)?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/library:lib-1",
					expectedRawCount: 1,
					rawObserved: 1,
					sourceBindings: 0,
					canonicalEntities: 0,
					acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
					fatalCount: 0,
				}),
			]),
		);
	});

	it("publishes a complete empty replacement in one transaction", async () => {
		const client = makeMockClient([]);
		const { stub, tx } = makeMockPrisma();

		const result = await refreshJellyfinCache(client, stub as never, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(tx.jellyfinCache.deleteMany).toHaveBeenCalledOnce();
		expect(tx.jellyfinCache.createMany).not.toHaveBeenCalled();
		expect(tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
		expect(stub.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
		});
	});

	it("collects a complete live snapshot without publishing cache state", async () => {
		const watchedAt = "2024-08-06T10:00:00Z";
		const client = makeMockClient([
			makeSeriesItem({ played: true, playCount: 1, lastPlayedDate: watchedAt }),
		]);
		const transaction = vi.fn();
		const stub = { $transaction: transaction };

		const result = await refreshJellyfinCache(
			client,
			stub as never,
			"inst-1",
			silentLog,
			undefined,
			{ publish: false },
		);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				instanceId: "inst-1",
				tmdbId: 99999,
				lastWatchedAt: new Date(watchedAt),
				watchCount: 1,
			}),
		]);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each([
		["unsupported provider objects", { type: "Playlist", tmdbId: undefined }],
		["missing stable keys", { id: "", tmdbId: 42 }],
		["missing supported mappings", { tmdbId: undefined }],
	] as const)(
		"retains safe rows for %s as a positive-only observation",
		async (_label, skipped) => {
			const client = makeMockClient([
				makeMovieItem({ id: "safe-row", tmdbId: 42 }),
				makeMovieItem(skipped),
			]);

			const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog, {
				attemptStartedAt: new Date("2026-01-01T00:00:00.000Z"),
				observedAt: new Date("2026-01-01T00:01:00.000Z"),
			});

			expect(result).toMatchObject({
				complete: false,
				errors: 0,
				completedAt: new Date("2026-01-01T00:01:00.000Z"),
			});
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.receipt).toMatchObject({
				evidence: "positive-only",
				publishedCanonicalEntities: 1,
			});
			expect(evaluateProviderCoverageReceipt(result.receipt)).toMatchObject({
				valid: true,
				complete: false,
				acceptedSkipCount: 1,
			});
		},
	);

	it("treats an unmatched on-deck relation as a conserved semantic omission", async () => {
		const client = makeMockClient([makeMovieItem({ id: "safe-row", tmdbId: 42 })]);
		(client.getResumeItems as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeMovieItem({ id: "not-in-library", tmdbId: undefined }),
		]);

		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 0 });
		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.receipt?.evidence).toBe("positive-only");
		expect(result.receipt?.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: "user:user-1/on-deck",
					rawObserved: 1,
					sourceBindings: 0,
					acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
				}),
			]),
		);
	});

	it("preserves no publication when semantic omissions produce no safe rows", async () => {
		const client = makeMockClient([makeMovieItem({ tmdbId: undefined })]);
		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 0 });
		expect(result.snapshot).toBeUndefined();
		expect(result.receipt?.evidence).toBe("unknown");
	});

	it("blocks publication on a source identity collision", async () => {
		const client = makeMockClient([
			makeMovieItem({ id: "same-source", tmdbId: 42 }),
			makeSeriesItem({ id: "same-source", tmdbId: 84 }),
		]);
		const result = await collectJellyfinCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result).toMatchObject({ complete: false, errors: 1 });
		expect(result.snapshot).toBeUndefined();
		expect(result.errorMessages).toContain("source-identity-conflict");
	});
});
