import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { runEpisodeFileSync } from "../episode-file-backfill.js";
import { hasCompleteEpisodeFileInventory } from "../episode-file-coverage.js";

const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];

afterEach(async () => {
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		await rm(directory, { recursive: true, force: true });
	}
});

async function createDatabase(): Promise<{ observer: PrismaClient; prisma: PrismaClient }> {
	const directory = await mkdtemp(join(tmpdir(), "episode-coverage-"));
	const databasePath = join(directory, "coverage.db");
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

describe("Sonarr episode-file receipt on populated SQLite", { timeout: 30_000 }, () => {
	it("retains rows on unsettled evidence, deletes only after a current CAS, and denies a raced snapshot", async () => {
		const { observer, prisma } = await createDatabase();
		await prisma.user.create({ data: { id: "owner-1", username: "synthetic-owner" } });
		await prisma.serviceInstance.create({
			data: {
				id: "sonarr-1",
				userId: "owner-1",
				service: "SONARR",
				label: "Synthetic",
				baseUrl: "http://sonarr.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		const source = await prisma.libraryCache.create({
			data: {
				id: "series-1",
				instanceId: "sonarr-1",
				arrItemId: 1,
				itemType: "series",
				title: "Synthetic",
				hasFile: true,
				data: JSON.stringify({ statistics: { episodeFileCount: 2 }, sizeOnDisk: 2 }),
			},
		});
		await prisma.episodeFileCache.createMany({
			data: [10, 11].map((id) => ({
				instanceId: "sonarr-1",
				arrEpisodeFileId: id,
				arrSeriesId: 1,
				seasonNumber: 1,
				relativePath: `${id}.mkv`,
				path: `/synthetic/${id}.mkv`,
				size: 1n,
			})),
		});
		const liveCount = 2;
		let liveSize = 2;
		let raceOnSecondList = false;
		let fileReads = 0;
		let pauseNextFileList: Promise<void> | null = null;
		let signalPaused: (() => void) | null = null;
		const app = {
			prisma,
			arrClientFactory: {
				create: () => ({
					series: {
						getById: async () => ({
							id: 1,
							statistics: { episodeFileCount: liveCount, sizeOnDisk: liveSize },
						}),
					},
					episodeFile: {
						getAll: async () => {
							fileReads++;
							if (pauseNextFileList) {
								const wait = pauseNextFileList;
								pauseNextFileList = null;
								signalPaused?.();
								await wait;
							}
							if (raceOnSecondList && fileReads % 2 === 0) {
								await observer.libraryCache.update({
									where: { id: source.id },
									data: { cachedAt: new Date(source.cachedAt.getTime() + 60_000) },
								});
							}
							return [
								{
									id: 10,
									seriesId: 1,
									seasonNumber: 1,
									relativePath: "10.mkv",
									path: "/synthetic/10.mkv",
									size: 1,
								},
							];
						},
					},
				}),
			},
		} as unknown as FastifyInstance;

		const unsettled = await runEpisodeFileSync({ app, seriesCap: 1 });
		expect(unsettled.errors).toBeGreaterThan(0);
		expect(unsettled.filesDeleted).toBe(0);
		expect(await prisma.episodeFileCache.count({ where: { instanceId: "sonarr-1" } })).toBe(2);
		expect(
			(await prisma.libraryCache.findUniqueOrThrow({ where: { id: source.id } }))
				.episodeFileInventoryReceipt,
		).toBeNull();

		liveSize = 1;
		await prisma.libraryCache.update({
			where: { id: source.id },
			data: { data: JSON.stringify({ statistics: { episodeFileCount: 2 }, sizeOnDisk: 1 }) },
		});
		const settled = await runEpisodeFileSync({ app, seriesCap: 1 });
		expect(settled.errors).toBe(0);
		expect(settled.filesDeleted).toBe(1);
		const published = await prisma.libraryCache.findUniqueOrThrow({ where: { id: source.id } });
		const publishedFiles = await prisma.episodeFileCache.findMany({
			where: { instanceId: "sonarr-1", arrSeriesId: 1 },
			select: { arrEpisodeFileId: true, path: true, size: true },
		});
		expect(
			hasCompleteEpisodeFileInventory(
				published.episodeFileInventoryReceipt,
				published.cachedAt,
				publishedFiles,
			),
		).toBe(true);

		await prisma.episodeFileCache.create({
			data: {
				instanceId: "sonarr-1",
				arrEpisodeFileId: 12,
				arrSeriesId: 1,
				seasonNumber: 1,
				relativePath: "12.mkv",
				path: "/synthetic/12.mkv",
				size: 1n,
			},
		});
		raceOnSecondList = true;
		const raced = await runEpisodeFileSync({ app, seriesCap: 1 });
		expect(raced.errors).toBeGreaterThan(0);
		expect(raced.filesDeleted).toBe(0);
		expect(await prisma.episodeFileCache.count({ where: { instanceId: "sonarr-1" } })).toBe(2);
		expect(
			(await prisma.libraryCache.findUniqueOrThrow({ where: { id: source.id } }))
				.episodeFileInventoryReceipt,
		).toBeNull();

		// Both workers start from the same cachedAt. The later attempt
		// supersedes the paused one before either can publish its receipt.
		raceOnSecondList = false;
		let releaseOlder!: () => void;
		const olderPaused = new Promise<void>((resolve) => {
			signalPaused = resolve;
		});
		pauseNextFileList = new Promise<void>((resolve) => {
			releaseOlder = resolve;
		});
		const older = runEpisodeFileSync({ app, seriesCap: 1 });
		await olderPaused;
		const newer = await runEpisodeFileSync({ app, seriesCap: 1 });
		expect(newer.errors).toBe(0);
		expect(newer.filesDeleted).toBe(1);
		releaseOlder();
		const superseded = await older;
		expect(superseded.errors).toBeGreaterThan(0);
		expect(superseded.filesUpserted).toBe(0);
		const finalSeries = await prisma.libraryCache.findUniqueOrThrow({ where: { id: source.id } });
		const finalFiles = await prisma.episodeFileCache.findMany({
			where: { instanceId: "sonarr-1", arrSeriesId: 1 },
			select: { arrEpisodeFileId: true, path: true, size: true },
		});
		expect(finalFiles).toHaveLength(1);
		expect(
			hasCompleteEpisodeFileInventory(
				finalSeries.episodeFileInventoryReceipt,
				finalSeries.cachedAt,
				finalFiles,
			),
		).toBe(true);
	});
});
