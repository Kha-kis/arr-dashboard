import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";

const { mockCreateQuiClient, mockListQuiInstances } = vi.hoisted(() => ({
	mockCreateQuiClient: vi.fn(),
	mockListQuiInstances: vi.fn(),
}));

vi.mock("../client-factory.js", () => ({
	createQuiClient: mockCreateQuiClient,
}));

vi.mock("../instance-helpers.js", () => ({
	listQuiInstances: mockListQuiInstances,
}));

import { runQuiTorrentStateSync } from "../torrent-state-sync.js";

const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];

afterEach(async () => {
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		await rm(directory, { recursive: true, force: true });
	}
});

async function createDatabase(): Promise<{ observer: PrismaClient; prisma: PrismaClient }> {
	const directory = await mkdtemp(join(tmpdir(), "qui-sync-scale-"));
	const databasePath = join(directory, "scale.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	const prisma = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
	});
	const observer = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
	});
	await Promise.all([prisma.$connect(), observer.$connect()]);
	databases.push({ clients: [prisma, observer], directory });
	return { observer, prisma };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(),
	level: "info",
	silent: vi.fn(),
} as never;

describe("runQuiTorrentStateSync SQLite scale behavior", () => {
	it("keeps database reads available while a complete 15k-torrent generation is unpublished", async () => {
		const { observer, prisma } = await createDatabase();
		const userId = "scale-user";
		const quiId = "scale-qui";
		const oldGeneration = new Date("2026-08-01T00:00:00.000Z");
		await prisma.user.create({
			data: { id: userId, username: "qui-scale", hashedPassword: "test" },
		});
		await prisma.serviceInstance.create({
			data: {
				id: quiId,
				userId,
				service: "QUI",
				label: "Scale qui",
				baseUrl: "http://qui.invalid",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
			},
		});

		await prisma.libraryCache.createMany({
			data: Array.from({ length: 15_000 }, (_, index) => ({
				id: `library-${index}`,
				instanceId: quiId,
				arrItemId: index,
				itemType: "movie" as const,
				title: `Movie ${index}`,
				infoHash: `hash-${index}`,
				torrentState: "paused",
				torrentRatio: 0,
				torrentSyncedAt: oldGeneration,
				data: "{}",
			})),
		});
		await prisma.episodeFileCache.createMany({
			data: Array.from({ length: 5_000 }, (_, index) => ({
				id: `episode-${index}`,
				instanceId: quiId,
				arrEpisodeFileId: index,
				arrSeriesId: index,
				seasonNumber: 1,
				relativePath: `episode-${index}.mkv`,
				path: `/media/episode-${index}.mkv`,
				size: BigInt(1),
				infoHash: `hash-${index + 15_000}`,
				torrentState: "paused",
				torrentRatio: 0,
				torrentSyncedAt: oldGeneration,
			})),
		});

		mockListQuiInstances.mockResolvedValue([
			{ id: quiId, userId, label: "Scale qui", baseUrl: "http://qui.invalid" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listTorrentInventory: vi.fn().mockResolvedValue({
				torrents: Array.from({ length: 15_000 }, (_, index) => ({
					hash: `HASH-${index}`,
					state: "uploading",
					ratio: 1,
				})),
				complete: true,
			}),
		});

		const stagingStatementDurationsMs: number[] = [];
		const healthLatenciesMs: number[] = [];
		let healthProbePromises: Promise<void>[] | undefined;
		const executeRaw = prisma.$executeRaw.bind(prisma);
		const timedExecuteRaw = ((...args: Parameters<typeof prisma.$executeRaw>) => {
			healthProbePromises ??= Array.from({ length: 20 }, (_, index) => {
				const delayMs = 50 + index * 100;
				const dueAt = performance.now() + delayMs;
				return new Promise<void>((resolve) => {
					setTimeout(async () => {
						await observer.$queryRaw`SELECT 1`;
						healthLatenciesMs.push(performance.now() - dueAt);
						resolve();
					}, delayMs);
				});
			});
			const startedAt = performance.now();
			return executeRaw(...args).then((rowsUpdated) => {
				stagingStatementDurationsMs.push(performance.now() - startedAt);
				return rowsUpdated;
			}) as ReturnType<typeof prisma.$executeRaw>;
		}) as typeof prisma.$executeRaw;
		vi.spyOn(prisma, "$executeRaw").mockImplementation(timedExecuteRaw);

		const stagingPaused = deferred();
		const releaseStaging = deferred();
		type FindEpisodeCandidates = (
			args?: Parameters<typeof prisma.episodeFileCache.findMany>[0],
		) => Promise<Awaited<ReturnType<typeof prisma.episodeFileCache.findMany>>>;
		const episodeFileCache = prisma.episodeFileCache as unknown as {
			findMany: FindEpisodeCandidates;
		};
		const findEpisodeCandidates = episodeFileCache.findMany.bind(episodeFileCache);
		vi.spyOn(episodeFileCache, "findMany").mockImplementationOnce(async (args) => {
			stagingPaused.resolve();
			await releaseStaging.promise;
			return await findEpisodeCandidates(args);
		});

		const sync = runQuiTorrentStateSync({ prisma, log, dbProvider: "sqlite" } as never);
		await stagingPaused.promise;
		await Promise.all(healthProbePromises ?? []);
		const [healthRows, staged, absentBeforeCleanup, freshLibraryRows, freshEpisodeRows] =
			await Promise.all([
				observer.$queryRaw<Array<{ healthy: bigint }>>`SELECT 1 AS healthy`,
				observer.libraryCache.findUnique({ where: { id: "library-0" } }),
				observer.episodeFileCache.findUnique({ where: { id: "episode-0" } }),
				observer.libraryCache.count({ where: { torrentSyncedAt: { not: null } } }),
				observer.episodeFileCache.count({ where: { torrentSyncedAt: { not: null } } }),
			]);
		releaseStaging.resolve();
		const result = await sync;

		expect(healthRows).toEqual([{ healthy: 1n }]);
		expect(staged).toMatchObject({
			torrentState: "seeding",
			torrentRatio: 1,
			torrentSyncedAt: null,
		});
		expect(absentBeforeCleanup).toMatchObject({
			torrentState: "paused",
			torrentRatio: 0,
			torrentSyncedAt: null,
		});
		expect(freshLibraryRows).toBe(0);
		expect(freshEpisodeRows).toBe(0);
		expect(stagingStatementDurationsMs).toHaveLength(100);
		expect(Math.max(...stagingStatementDurationsMs)).toBeLessThan(2_000);
		expect(healthLatenciesMs).toHaveLength(20);
		expect(Math.max(...healthLatenciesMs)).toBeLessThan(2_000);
		expect(result).toMatchObject({
			torrentsSeen: 15_000,
			rowsUpdated: 15_000,
			errors: 0,
		});
		const published = await prisma.libraryCache.findUnique({ where: { id: "library-0" } });
		expect(published).toMatchObject({ torrentState: "seeding", torrentRatio: 1 });
		expect(published?.torrentSyncedAt).toBeInstanceOf(Date);
		const absent = await prisma.episodeFileCache.findUnique({ where: { id: "episode-0" } });
		expect(absent).toMatchObject({ torrentState: null, torrentRatio: null });
		expect(absent?.torrentSyncedAt).toBeInstanceOf(Date);
	}, 30_000);
});
