import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillInfoHashForRow } from "../../library-sync/infohash-backfill.js";

const { mockListQuiInstances, mockCreateQuiClient } = vi.hoisted(() => ({
	mockListQuiInstances: vi.fn(),
	mockCreateQuiClient: vi.fn(),
}));

vi.mock("../instance-helpers.js", () => ({
	listQuiInstances: mockListQuiInstances,
}));

vi.mock("../client-factory.js", () => ({
	createQuiClient: mockCreateQuiClient,
}));

import { withQuiObservationTopologyGuard } from "../observation-topology-guard.js";
import { runQuiTorrentStateSync } from "../torrent-state-sync.js";

const silentLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => silentLog),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeApp(overrides: Record<string, unknown> = {}) {
	const libraryCacheUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
	const libraryCacheUpdate = vi.fn().mockResolvedValue({});
	const episodeFileCacheUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
	const libraryCacheFindMany = vi.fn().mockResolvedValue([]);
	const episodeFileCacheFindMany = vi.fn().mockResolvedValue([]);
	const serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
	const serviceInstanceFindFirst = vi.fn().mockResolvedValue(null);
	const executeRaw = vi.fn().mockResolvedValue(1);
	const prisma = {
		libraryCache: {
			update: libraryCacheUpdate,
			updateMany: libraryCacheUpdateMany,
			findMany: libraryCacheFindMany,
		},
		episodeFileCache: {
			updateMany: episodeFileCacheUpdateMany,
			findMany: episodeFileCacheFindMany,
		},
		serviceInstance: {
			findFirst: serviceInstanceFindFirst,
			findMany: serviceInstanceFindMany,
		},
		$executeRaw: executeRaw,
		$transaction: vi.fn(),
	};
	prisma.$transaction.mockImplementation(
		async (operation: (tx: typeof prisma) => Promise<unknown>) => await operation(prisma),
	);
	return {
		log: silentLog,
		prisma,
		__libraryCacheUpdateMany: libraryCacheUpdateMany,
		__libraryCacheUpdate: libraryCacheUpdate,
		__episodeFileCacheUpdateMany: episodeFileCacheUpdateMany,
		__libraryCacheFindMany: libraryCacheFindMany,
		__episodeFileCacheFindMany: episodeFileCacheFindMany,
		__serviceInstanceFindMany: serviceInstanceFindMany,
		__serviceInstanceFindFirst: serviceInstanceFindFirst,
		__executeRaw: executeRaw,
		...overrides,
	} as any;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function instance(id: string, userId = "user-1") {
	return { id, userId, label: id, baseUrl: `http://${id}` };
}

function completeInventory(
	torrents: Array<{ hash: string; state: string; ratio: number; instanceId?: number }>,
) {
	return {
		listTorrentInventory: vi.fn().mockResolvedValue({ torrents, complete: true }),
	};
}

function configureOneUser(app: ReturnType<typeof makeApp>, instances = [instance("qui-1")]) {
	app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
	mockListQuiInstances.mockResolvedValue(instances);
}

function infoHashWrites(mock: ReturnType<typeof vi.fn>) {
	return mock.mock.calls.filter(
		(call) => call[0]?.strings !== undefined || Array.isArray(call[0]?.where?.infoHash?.in),
	);
}

function userWideClears(mock: ReturnType<typeof vi.fn>) {
	return mock.mock.calls.filter(
		(call) =>
			call[0]?.where?.instance !== undefined &&
			call[0]?.where?.infoHash === undefined &&
			call[0]?.where?.id === undefined &&
			call[0]?.data?.torrentState === null &&
			call[0]?.data?.torrentRatio === null,
	);
}

describe("runQuiTorrentStateSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("no-ops when no users have enabled qUI instances", async () => {
		const app = makeApp();

		const result = await runQuiTorrentStateSync(app);

		expect(result).toMatchObject({ usersScanned: 0, instancesScanned: 0 });
		expect(mockListQuiInstances).not.toHaveBeenCalled();
		expect(app.__libraryCacheUpdateMany).not.toHaveBeenCalled();
	});

	it("normalizes complete inventory states and scopes every hash write by user", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(
			completeInventory([
				{ hash: "AAAA", state: "stalledUP", ratio: 1.5 },
				{ hash: "BBBB", state: "stalledDL", ratio: 0.1 },
			]),
		);

		const result = await runQuiTorrentStateSync(app);

		expect(result).toMatchObject({ torrentsSeen: 2, rowsUpdated: 2, errors: 0 });
		expect(app.__executeRaw).toHaveBeenCalledTimes(2);
		expect(app.__executeRaw.mock.calls[0]?.[0].values).toEqual(
			expect.arrayContaining(["aaaa", "seeding", "bbbb", "stalled_dl", "user-1"]),
		);
		expect(app.__executeRaw.mock.calls[0]?.[0].strings.join("")).toContain(
			'LOWER(cache."infoHash")',
		);
		expect(app.__executeRaw.mock.calls[0]?.[0].strings.join("")).toContain("CAST( AS REAL)");
	});

	it("types nullable staged ratios for both supported database providers", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(
			completeInventory([{ hash: "AAAA", state: "uploading", ratio: Number.NaN }]),
		);

		await runQuiTorrentStateSync(app);

		const statement = app.__executeRaw.mock.calls[0]?.[0];
		expect(statement.strings.join("")).toContain("CAST( AS REAL)");
		expect(statement.values).toContain(null);
	});

	it("requires the complete list fallback when the inventory API is unavailable", async () => {
		const app = makeApp();
		configureOneUser(app);
		const listAllTorrents = vi
			.fn()
			.mockResolvedValue([{ hash: "AAAA", state: "pausedUP", ratio: 1 }]);
		mockCreateQuiClient.mockReturnValue({ listAllTorrents });

		await runQuiTorrentStateSync(app);

		expect(listAllTorrents).toHaveBeenCalledWith({ requireComplete: true });
		expect(infoHashWrites(app.__executeRaw)).toHaveLength(2);
	});

	it.each([
		["active first", ["qui-active", "qui-paused"]],
		["paused first", ["qui-paused", "qui-active"]],
	] as const)(
		"aggregates A=active and B=paused conservatively regardless of input order (%s)",
		async (_label, order) => {
			const app = makeApp();
			configureOneUser(
				app,
				order.map((id) => instance(id)),
			);
			mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
				selected.id === "qui-active"
					? completeInventory([{ hash: "AAAA", state: "uploading", ratio: 2, instanceId: 1 }])
					: completeInventory([{ hash: "AAAA", state: "pausedUP", ratio: 1, instanceId: 2 }]),
			);

			await runQuiTorrentStateSync(app);

			expect(infoHashWrites(app.__executeRaw)).toHaveLength(2);
			expect(app.__executeRaw.mock.calls[0]?.[0].values).toEqual(
				expect.arrayContaining(["aaaa", "seeding", null, "user-1"]),
			);
		},
	);

	it("lets transitional or unknown state outrank paused instead of publishing inactivity", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-paused"), instance("qui-unknown")]);
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
			selected.id === "qui-paused"
				? completeInventory([{ hash: "AAAA", state: "pausedUP", ratio: 1 }])
				: completeInventory([{ hash: "AAAA", state: "futureState", ratio: 1 }]),
		);

		await runQuiTorrentStateSync(app);

		expect(app.__executeRaw.mock.calls[0]?.[0].values).toEqual(
			expect.arrayContaining(["aaaa", "unknown", null, "user-1"]),
		);
	});

	it("fetches every enabled inventory before publishing any durable observation", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-a"), instance("qui-b")]);
		const secondStarted = deferred();
		const releaseSecond = deferred();
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
			selected.id === "qui-a"
				? completeInventory([{ hash: "AAAA", state: "uploading", ratio: 1 }])
				: {
						listTorrentInventory: vi.fn().mockImplementation(async () => {
							secondStarted.resolve();
							await releaseSecond.promise;
							return { torrents: [], complete: true };
						}),
					},
		);

		const sync = runQuiTorrentStateSync(app);
		await secondStarted.promise;
		expect(app.__libraryCacheUpdateMany).not.toHaveBeenCalled();
		releaseSecond.resolve();
		await sync;

		expect(infoHashWrites(app.__executeRaw)).toHaveLength(2);
	});

	it("keeps every staged row non-fresh until the final publication stamp commits", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(
			completeInventory([
				{ hash: "AAAA", state: "uploading", ratio: 1 },
				{ hash: "BBBB", state: "pausedUP", ratio: 1 },
			]),
		);
		const firstHashStaged = deferred();
		const releaseStaging = deferred();
		const visible = new Map<string, { torrentState: string | null; torrentSyncedAt: Date | null }>([
			[
				"aaaa",
				{
					torrentState: "paused",
					torrentSyncedAt: new Date("2026-07-31T00:00:00.000Z"),
				},
			],
			[
				"bbbb",
				{
					torrentState: "seeding",
					torrentSyncedAt: new Date("2026-07-31T00:00:00.000Z"),
				},
			],
		]);
		app.__executeRaw.mockImplementation(async (query: { strings?: string[] }) => {
			if (query.strings?.join("").includes('"library_cache"')) {
				visible.set("aaaa", { torrentState: "seeding", torrentSyncedAt: null });
				visible.set("bbbb", { torrentState: "paused", torrentSyncedAt: null });
				firstHashStaged.resolve();
				await releaseStaging.promise;
				return 2;
			}
			return 0;
		});
		app.prisma.$transaction.mockImplementation(
			async (operation: (tx: typeof app.prisma) => Promise<unknown>) => {
				const staged = new Map([...visible.entries()].map(([hash, value]) => [hash, { ...value }]));
				const tx = {
					...app.prisma,
					libraryCache: {
						...app.prisma.libraryCache,
						updateMany: vi.fn(
							async (args: {
								where: { infoHash?: { not: null } };
								data: { torrentSyncedAt?: Date | null };
							}) => {
								for (const [hash, current] of staged) {
									staged.set(hash, {
										...current,
										torrentSyncedAt: args.data.torrentSyncedAt ?? null,
									});
								}
								return { count: 1 };
							},
						),
					},
				};
				const result = await operation(tx);
				visible.clear();
				for (const [hash, value] of staged) visible.set(hash, value);
				return result;
			},
		);

		const sync = runQuiTorrentStateSync(app);
		await firstHashStaged.promise;

		// The state payload may be staged incrementally, but freshness is the
		// publication marker consumed by preview. Every row remains no_signal.
		expect(visible.get("aaaa")).toEqual({
			torrentState: "seeding",
			torrentSyncedAt: null,
		});
		expect(visible.get("bbbb")).toEqual({
			torrentState: "paused",
			torrentSyncedAt: null,
		});

		releaseStaging.resolve();
		await sync;
		expect(visible.get("aaaa")).toEqual({
			torrentState: "seeding",
			torrentSyncedAt: expect.any(Date),
		});
		expect(visible.get("bbbb")).toEqual({
			torrentState: "paused",
			torrentSyncedAt: expect.any(Date),
		});
	});

	it("serializes an infoHash writer after staged publication and leaves the new hash unobserved", async () => {
		const events: string[] = [];
		const app = makeApp({
			arrClientFactory: {
				rawRequest: vi.fn().mockResolvedValue({
					ok: true,
					status: 200,
					json: vi.fn().mockResolvedValue([{ downloadId: "a".repeat(40) }]),
				}),
			},
		});
		configureOneUser(app);
		app.__serviceInstanceFindFirst.mockResolvedValue({
			id: "radarr-1",
			userId: "user-1",
			service: "RADARR",
			label: "Radarr",
			baseUrl: "http://radarr.internal",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		});
		mockCreateQuiClient.mockReturnValue(
			completeInventory([{ hash: "BBBB", state: "uploading", ratio: 1 }]),
		);
		const stageStarted = deferred();
		const releaseStage = deferred();
		let stageObserved = false;
		app.__executeRaw.mockImplementation(async (query: { strings?: string[] }) => {
			if (!stageObserved && query.strings?.join("").includes('"library_cache"')) {
				stageObserved = true;
				events.push("stage");
				stageStarted.resolve();
				await releaseStage.promise;
			}
			return 1;
		});
		app.prisma.$transaction.mockImplementation(
			async (operation: (tx: typeof app.prisma) => Promise<unknown>) => {
				const tx = {
					...app.prisma,
					libraryCache: {
						...app.prisma.libraryCache,
						updateMany: vi.fn(async (args: { data?: { torrentSyncedAt?: Date | null } }) => {
							if (args.data?.torrentSyncedAt instanceof Date) events.push("publish");
							return { count: 1 };
						}),
					},
				};
				return operation(tx);
			},
		);
		app.__libraryCacheUpdate.mockImplementation(async () => {
			events.push("writer");
			return {};
		});

		const sync = runQuiTorrentStateSync(app);
		await stageStarted.promise;
		const writer = backfillInfoHashForRow({
			app,
			cacheRowId: "movie-1",
			userId: "user-1",
			arrInstanceId: "radarr-1",
			itemType: "movie",
			arrItemId: 101,
		});
		await Promise.resolve();
		expect(app.__libraryCacheUpdate).not.toHaveBeenCalled();

		releaseStage.resolve();
		await sync;
		await expect(writer).resolves.toBe("a".repeat(40));

		expect(events).toEqual(["stage", "publish", "writer"]);
		expect(app.__libraryCacheUpdate).toHaveBeenCalledWith({
			where: { id: "movie-1" },
			data: {
				infoHash: "a".repeat(40),
				torrentState: null,
				torrentRatio: null,
				torrentSyncedAt: null,
			},
		});
	});

	it("stages a large inventory outside the two short publication transactions", async () => {
		const app = makeApp();
		configureOneUser(app);
		const torrents = Array.from({ length: 1001 }, (_, index) => ({
			hash: `hash-${index}`,
			state: "uploading",
			ratio: 1,
		}));
		mockCreateQuiClient.mockReturnValue(completeInventory(torrents));
		const transactionStatementCounts: number[] = [];
		app.prisma.$transaction.mockImplementation(
			async (operation: (tx: typeof app.prisma) => Promise<unknown>) => {
				let statements = 0;
				const tx = {
					...app.prisma,
					libraryCache: {
						...app.prisma.libraryCache,
						updateMany: vi.fn(async () => {
							statements++;
							return { count: 1 };
						}),
					},
					episodeFileCache: {
						...app.prisma.episodeFileCache,
						updateMany: vi.fn(async () => {
							statements++;
							return { count: 0 };
						}),
					},
				};
				const result = await operation(tx);
				transactionStatementCounts.push(statements);
				return result;
			},
		);

		await runQuiTorrentStateSync(app);

		expect(infoHashWrites(app.__executeRaw)).toHaveLength(8);
		expect(transactionStatementCounts).toEqual([2, 2]);
	});

	it("clears prior state and publishes no hash when A=paused and B errors", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-paused"), instance("qui-error")]);
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
			selected.id === "qui-paused"
				? completeInventory([{ hash: "AAAA", state: "pausedUP", ratio: 1 }])
				: { listTorrentInventory: vi.fn().mockRejectedValue(new Error("offline")) },
		);

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		expect(infoHashWrites(app.__libraryCacheUpdateMany)).toHaveLength(0);
		expect(userWideClears(app.__libraryCacheUpdateMany)).toHaveLength(1);
		expect(app.__libraryCacheUpdateMany).toHaveBeenCalledWith({
			where: { instance: { userId: "user-1" } },
			data: { torrentState: null, torrentRatio: null, torrentSyncedAt: null },
		});
	});

	it("clears prior state and publishes no hash when any inventory is incomplete", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-paused"), instance("qui-partial")]);
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
			selected.id === "qui-paused"
				? completeInventory([{ hash: "AAAA", state: "pausedUP", ratio: 1 }])
				: {
						listTorrentInventory: vi.fn().mockResolvedValue({
							torrents: [{ hash: "AAAA", state: "pausedUP", ratio: 2 }],
							complete: false,
						}),
					},
		);

		const result = await runQuiTorrentStateSync(app);

		expect(result).toMatchObject({ torrentsSeen: 2, errors: 1 });
		expect(infoHashWrites(app.__libraryCacheUpdateMany)).toHaveLength(0);
		expect(userWideClears(app.__libraryCacheUpdateMany)).toHaveLength(1);
	});

	it("persists complete absence with a fresh timestamp and honest null ratio", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(completeInventory([]));
		app.__libraryCacheFindMany.mockImplementation((args: { select?: { title?: boolean } }) =>
			Promise.resolve(args.select?.title ? [] : [{ id: "movie-1", infoHash: "aaaa" }]),
		);
		app.__episodeFileCacheFindMany.mockResolvedValue([{ id: "episode-1", infoHash: "bbbb" }]);
		app.__episodeFileCacheUpdateMany.mockResolvedValue({ count: 1 });

		const result = await runQuiTorrentStateSync(app);

		expect(result).toMatchObject({ torrentsSeen: 0, rowsCleared: 2, errors: 0 });
		expect(app.__libraryCacheUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ["movie-1"] }, instance: { userId: "user-1" } },
			data: {
				torrentState: null,
				torrentRatio: null,
				torrentSyncedAt: null,
			},
		});
		expect(app.__episodeFileCacheUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ["episode-1"] }, instance: { userId: "user-1" } },
			data: {
				torrentState: null,
				torrentRatio: null,
				torrentSyncedAt: null,
			},
		});
		expect(app.__libraryCacheUpdateMany).toHaveBeenCalledWith({
			where: {
				instance: { userId: "user-1" },
				infoHash: { not: null },
			},
			data: { torrentSyncedAt: expect.any(Date) },
		});
	});

	it("chunks complete-absence publication below the SQLite parameter cap", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(completeInventory([]));
		const absentRows = Array.from({ length: 1072 }, (_, index) => ({
			id: `absent-${index}`,
			infoHash: `hash-${index}`,
		}));
		app.__libraryCacheFindMany.mockImplementation((args: { select?: { title?: boolean } }) =>
			Promise.resolve(args.select?.title ? [] : absentRows),
		);

		await runQuiTorrentStateSync(app);

		const idWrites = app.__libraryCacheUpdateMany.mock.calls.filter(
			(call: [{ where?: { id?: { in: string[] } } }]) => call[0]?.where?.id?.in,
		);
		expect(
			idWrites.map((call: [{ where: { id: { in: string[] } } }]) => call[0].where.id.in.length),
		).toEqual([500, 500, 72]);
	});

	it("serializes an old-topology complete publish before a queued topology clear", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-old")]);
		const inventoryStarted = deferred();
		const releaseInventory = deferred();
		mockCreateQuiClient.mockReturnValue({
			listTorrentInventory: vi.fn().mockImplementation(async () => {
				inventoryStarted.resolve();
				await releaseInventory.promise;
				return {
					torrents: [{ hash: "AAAA", state: "uploading", ratio: 1 }],
					complete: true,
				};
			}),
		});

		const sync = runQuiTorrentStateSync(app);
		await inventoryStarted.promise;
		const topologyClear = withQuiObservationTopologyGuard("user-1", () =>
			app.__libraryCacheUpdateMany({
				where: { instance: { userId: "user-1" } },
				data: { torrentState: null, torrentRatio: null, torrentSyncedAt: null },
			}),
		);
		expect(app.__libraryCacheUpdateMany).not.toHaveBeenCalled();
		releaseInventory.resolve();
		await sync;
		await topologyClear;

		expect(app.__libraryCacheUpdateMany).toHaveBeenLastCalledWith({
			where: { instance: { userId: "user-1" } },
			data: { torrentState: null, torrentRatio: null, torrentSyncedAt: null },
		});
	});

	it("keeps failure invalidation and successful publication isolated per user", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([
			{ userId: "user-a" },
			{ userId: "user-b" },
		]);
		mockListQuiInstances.mockImplementation((_app: unknown, userId: string) =>
			Promise.resolve([instance(`qui-${userId}`, userId)]),
		);
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { userId: string }) =>
			selected.userId === "user-a"
				? { listTorrentInventory: vi.fn().mockRejectedValue(new Error("offline")) }
				: completeInventory([{ hash: "BBBB", state: "uploading", ratio: 1 }]),
		);

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		expect(app.__libraryCacheUpdateMany).toHaveBeenCalledWith({
			where: { instance: { userId: "user-a" } },
			data: { torrentState: null, torrentRatio: null, torrentSyncedAt: null },
		});
		expect(
			app.__executeRaw.mock.calls.some(
				(call: [{ values?: unknown[] }]) =>
					call[0]?.values?.includes("user-b") && call[0]?.values?.includes("seeding"),
			),
		).toBe(true);
	});

	it("invalidates any partial publish when a durable write fails", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(
			completeInventory([
				{ hash: "AAAA", state: "uploading", ratio: 1 },
				{ hash: "BBBB", state: "pausedUP", ratio: 1 },
			]),
		);
		app.__libraryCacheUpdateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 })
			.mockRejectedValueOnce(new Error("write failed"))
			.mockResolvedValueOnce({ count: 1 });
		app.__executeRaw.mockRejectedValueOnce(new Error("write failed"));

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		expect(app.__libraryCacheUpdateMany).toHaveBeenLastCalledWith({
			where: { instance: { userId: "user-1" } },
			data: { torrentState: null, torrentRatio: null, torrentSyncedAt: null },
		});
		expect(app.prisma.$transaction).toHaveBeenCalledTimes(2);
	});

	it("rolls back user-wide invalidation when either cache-table clear fails", async () => {
		const app = makeApp();
		configureOneUser(app, [instance("qui-error")]);
		mockCreateQuiClient.mockReturnValue({
			listTorrentInventory: vi.fn().mockRejectedValue(new Error("offline")),
		});
		const visible = {
			libraryTimestamp: new Date("2026-07-31T00:00:00.000Z"),
			episodeTimestamp: new Date("2026-07-31T00:00:00.000Z"),
		};
		app.prisma.$transaction.mockImplementation(
			async (operation: (tx: typeof app.prisma) => Promise<unknown>) => {
				const staged = { ...visible };
				const tx = {
					...app.prisma,
					libraryCache: {
						...app.prisma.libraryCache,
						updateMany: vi.fn(async () => {
							staged.libraryTimestamp = null as unknown as Date;
							return { count: 1 };
						}),
					},
					episodeFileCache: {
						...app.prisma.episodeFileCache,
						updateMany: vi.fn().mockRejectedValue(new Error("episode clear failed")),
					},
				};
				const result = await operation(tx);
				Object.assign(visible, staged);
				return result;
			},
		);

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(2);
		expect(visible.libraryTimestamp).toEqual(new Date("2026-07-31T00:00:00.000Z"));
		expect(visible.episodeTimestamp).toEqual(new Date("2026-07-31T00:00:00.000Z"));
	});

	it("emits one transition notification from the aggregated hash state", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({ notificationService: { notify } });
		configureOneUser(app, [instance("qui-active"), instance("qui-paused")]);
		mockCreateQuiClient.mockImplementation((_app: unknown, selected: { id: string }) =>
			selected.id === "qui-active"
				? completeInventory([{ hash: "AAAA", state: "uploading", ratio: 1 }])
				: completeInventory([{ hash: "AAAA", state: "pausedUP", ratio: 1 }]),
		);
		app.__libraryCacheFindMany.mockImplementation((args: { select?: { title?: boolean } }) =>
			Promise.resolve(
				args.select?.title
					? [{ infoHash: "aaaa", torrentState: "downloading", title: "Example" }]
					: [],
			),
		);

		await runQuiTorrentStateSync(app);

		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("coerces a non-finite single-torrent ratio to null", async () => {
		const app = makeApp();
		configureOneUser(app);
		mockCreateQuiClient.mockReturnValue(
			completeInventory([{ hash: "EEEE", state: "uploading", ratio: Number.POSITIVE_INFINITY }]),
		);

		await runQuiTorrentStateSync(app);

		expect(app.__executeRaw.mock.calls[0]?.[0].values).toEqual(
			expect.arrayContaining(["eeee", null, "user-1"]),
		);
	});
});

const quiSyncPostgresUrl = process.env.QUI_SYNC_POSTGRES_URL;
const describePostgres = quiSyncPostgresUrl ? describe : describe.skip;

describePostgres("runQuiTorrentStateSync PostgreSQL staging", () => {
	it("executes numeric and null staged ratios against PostgreSQL", async () => {
		const client = new pg.Client({ connectionString: quiSyncPostgresUrl });
		await client.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`CREATE TEMP TABLE "ServiceInstance" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL) ON COMMIT DROP`,
			);
			for (const tableName of ["library_cache", "episode_file_cache"]) {
				await client.query(
					`CREATE TEMP TABLE "${tableName}" (
						"id" TEXT PRIMARY KEY,
						"instanceId" TEXT NOT NULL,
						"infoHash" TEXT,
						"torrentState" TEXT,
						"torrentRatio" REAL,
						"torrentSyncedAt" TIMESTAMP(3)
					) ON COMMIT DROP`,
				);
			}
			await client.query(
				`INSERT INTO "ServiceInstance" ("id", "userId") VALUES ('qui-1', 'user-1')`,
			);
			await client.query(
				`INSERT INTO "library_cache"
					("id", "instanceId", "infoHash", "torrentState", "torrentRatio")
				 VALUES
					('numeric', 'qui-1', 'AAAA', 'paused', 0),
					('nullable', 'qui-1', 'BBBB', 'paused', 0)`,
			);

			const app = makeApp();
			configureOneUser(app);
			app.__executeRaw.mockImplementation(
				async (statement: { text: string; values: unknown[] }) => {
					const result = await client.query(statement.text, statement.values);
					return result.rowCount ?? 0;
				},
			);
			mockCreateQuiClient.mockReturnValue(
				completeInventory([
					{ hash: "AAAA", state: "uploading", ratio: 1.5 },
					{ hash: "BBBB", state: "stalledDL", ratio: Number.NaN },
				]),
			);

			await runQuiTorrentStateSync(app);

			const rows = await client.query<{
				id: string;
				torrentState: string | null;
				torrentRatio: number | null;
			}>(`SELECT "id", "torrentState", "torrentRatio" FROM "library_cache" ORDER BY "id"`);
			expect(rows.rows).toEqual([
				{ id: "nullable", torrentState: "stalled_dl", torrentRatio: null },
				{ id: "numeric", torrentState: "seeding", torrentRatio: 1.5 },
			]);
		} finally {
			await client.query("ROLLBACK").catch(() => undefined);
			await client.end();
		}
	});
});
