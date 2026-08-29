import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const databases: Array<{ client: PrismaClient; directory: string }> = [];

afterEach(async () => {
	for (const { client, directory } of databases.splice(0)) {
		await client.$disconnect();
		await rm(directory, { recursive: true, force: true });
	}
});

async function createDatabase(): Promise<PrismaClient> {
	const directory = await mkdtemp(join(tmpdir(), "qui-sync-scale-"));
	const databasePath = join(directory, "scale.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	const client = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
	});
	await client.$connect();
	databases.push({ client, directory });
	return client;
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
	it("keeps a health query responsive during a complete 15k-torrent publication", async () => {
		const prisma = await createDatabase();
		const userId = "scale-user";
		const quiId = "scale-qui";
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

		const healthLatencies: number[] = [];
		const probePromises = Array.from({ length: 20 }, (_, index) => {
			const dueAt = performance.now() + 50 + index * 100;
			return new Promise<void>((resolve) => {
				setTimeout(
					async () => {
						await prisma.$queryRaw`SELECT 1`;
						healthLatencies.push(performance.now() - dueAt);
						resolve();
					},
					50 + index * 100,
				);
			});
		});

		const result = await runQuiTorrentStateSync({ prisma, log, dbProvider: "sqlite" } as never);
		await Promise.all(probePromises);

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
		expect(Math.max(...healthLatencies)).toBeLessThan(2_000);
	}, 30_000);
});
