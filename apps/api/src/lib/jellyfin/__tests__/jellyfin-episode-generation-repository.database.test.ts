import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	acquireJellyfinEpisodePreparation,
	cleanupObsoleteJellyfinEpisodeGenerations,
	cleanupUnpublishedJellyfinEpisodeGeneration,
	prepareJellyfinEpisodeGeneration,
	releaseJellyfinEpisodePreparation,
	renewJellyfinEpisodePreparation,
	verifyPreparedJellyfinEpisodeGeneration,
} from "../jellyfin-episode-generation-repository.js";
import { fingerprintJellyfinEpisodeRows } from "../jellyfin-generation-metadata.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];

function syncDisposableSchema(dbPath: string): void {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
}

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-episode-generation-"));
	const dbPath = join(directory, "test.db");
	syncDisposableSchema(dbPath);
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "episode-generation-test" } });
	await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-instance",
			userId: "owner",
			service: "JELLYFIN",
			label: "Synthetic",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			identityStatus: "VERIFIED",
			expectedIdentity: "synthetic-server",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	return { prisma, dbPath };
}

async function seedRunningRun(prisma: ReturnType<typeof createTestPrismaClient>, id = "run-1") {
	await prisma.providerObservationRun.create({
		data: {
			id,
			instanceId: "jellyfin-instance",
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: "synthetic-authority",
			activeSlotKey: "synthetic-slot",
			targetDigest: "synthetic-digest",
			targetCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "running",
			totalUnits: 1,
			completedUnits: 1,
			totalWork: 1,
			completedWork: 1,
		},
	});
}

function candidateRows(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		showTmdbId: 42 + Math.floor(index / 250),
		seasonNumber: 1,
		episodeNumber: index % 250,
		jellyfinId: `synthetic-${index}`,
		title: `Synthetic episode ${index}`,
		watched: index % 2 === 0,
		watchedByUsers: "[]",
		lastWatchedAt: null,
	}));
}

async function leasedInput(prisma: ReturnType<typeof createTestPrismaClient>) {
	await seedRunningRun(prisma);
	const input = {
		userId: "owner",
		instanceId: "jellyfin-instance",
		runId: "run-1",
		generationId: "run-1",
		now: new Date(),
	};
	const lease = await acquireJellyfinEpisodePreparation(prisma, input);
	if (!lease) throw new Error("Synthetic lease was not acquired");
	return { ...input, token: lease.token };
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("generation-scoped Jellyfin episode schema", { timeout: 30_000 }, () => {
	it("adds generation tables without changing legacy episode rows or status on replay", async () => {
		const { prisma, dbPath } = await database();
		await prisma.jellyfinEpisodeCache.create({
			data: {
				instanceId: "jellyfin-instance",
				showTmdbId: 42,
				seasonNumber: 1,
				episodeNumber: 2,
				jellyfinId: "legacy-episode",
				title: "Synthetic episode",
				watched: true,
				watchedByUsers: '["Synthetic user"]',
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await prisma.cacheRefreshStatus.create({
			data: {
				instanceId: "jellyfin-instance",
				cacheType: "jellyfin_episode",
				lastRefreshedAt: new Date("2026-09-26T00:00:00.000Z"),
				lastResult: "success",
				itemCount: 1,
				generationId: "legacy-generation",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		const legacyBefore = await prisma.jellyfinEpisodeCache.findMany();
		const statusBefore = await prisma.cacheRefreshStatus.findMany();

		syncDisposableSchema(dbPath);

		const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jellyfin_episode_generation_rows', 'jellyfin_episode_generation_show_receipts', 'jellyfin_episode_preparations') ORDER BY name",
		);
		expect(tables.map((row) => row.name)).toEqual([
			"jellyfin_episode_generation_rows",
			"jellyfin_episode_generation_show_receipts",
			"jellyfin_episode_preparations",
		]);
		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual(legacyBefore);
		expect(await prisma.cacheRefreshStatus.findMany()).toEqual(statusBefore);
	});

	it("grants one owned preparation lease and denies an overlapping finalizer", async () => {
		const { prisma } = await database();
		await seedRunningRun(prisma);
		const now = new Date("2026-09-26T00:00:00.000Z");
		const input = {
			userId: "owner",
			instanceId: "jellyfin-instance",
			runId: "run-1",
			generationId: "run-1",
			now,
		};

		const first = await acquireJellyfinEpisodePreparation(prisma, input);
		expect(first?.token).toEqual(expect.any(String));
		expect(first?.token.length).toBeGreaterThan(0);
		expect(await acquireJellyfinEpisodePreparation(prisma, input)).toBeNull();
		expect(
			await prisma.$transaction((tx) =>
				renewJellyfinEpisodePreparation(tx, { ...input, token: first!.token }),
			),
		).toBe(true);
		expect(await prisma.jellyfinEpisodePreparation.count({ where: { runId: "run-1" } })).toBe(1);
	});

	it("renews an owned lease after a concurrent SQLite writer releases its reservation", async () => {
		const { prisma, dbPath } = await database();
		const input = await leasedInput(prisma);
		const sqliteModulePath = createRequire(import.meta.url).resolve("better-sqlite3");
		const writer = new Worker(
			`const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.sqliteModulePath);
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = DELETE");
db.exec("BEGIN IMMEDIATE");
db.prepare('UPDATE "ServiceInstance" SET "label" = "label" WHERE "id" = ?').run("jellyfin-instance");
parentPort.postMessage("ready");
parentPort.once("message", (message) => {
  if (message !== "release") return;
  setTimeout(() => {
    db.exec("COMMIT");
    db.close();
    parentPort.postMessage("released");
  }, 150);
});`,
			{ eval: true, workerData: { dbPath, sqliteModulePath } },
		);
		try {
			await new Promise<void>((resolve, reject) => {
				writer.once("message", (message) => {
					if (message === "ready") resolve();
					else reject(new Error("Synthetic writer did not acquire its reservation"));
				});
				writer.once("error", reject);
			});
			expect(
				await prisma.$transaction((tx) =>
					renewJellyfinEpisodePreparation(
						new Proxy(tx, {
							get(target, property, receiver) {
								if (property === "$executeRaw") {
									return (...args: unknown[]) => {
										writer.postMessage("release");
										return Reflect.apply(Reflect.get(target, property), target, args);
									};
								}
								return Reflect.get(target, property, receiver);
							},
						}),
						input,
					),
				),
			).toBe(true);
		} finally {
			await writer.terminate();
		}
	}, 30_000);

	it("transfers only an expired lease and rejects the displaced token", async () => {
		const { prisma } = await database();
		await seedRunningRun(prisma);
		const input = {
			userId: "owner",
			instanceId: "jellyfin-instance",
			runId: "run-1",
			generationId: "run-1",
			now: new Date("2026-09-26T00:00:00.000Z"),
		};
		const first = await acquireJellyfinEpisodePreparation(prisma, input);
		if (!first) throw new Error("Synthetic lease was not acquired");
		const afterExpiry = new Date("2026-09-26T00:05:01.000Z");

		const second = await acquireJellyfinEpisodePreparation(prisma, {
			...input,
			now: afterExpiry,
		});
		expect(second?.token).toEqual(expect.any(String));
		expect(second?.token).not.toBe(first.token);
		expect(
			await prisma.$transaction((tx) =>
				renewJellyfinEpisodePreparation(tx, {
					...input,
					token: first.token,
					now: afterExpiry,
				}),
			),
		).toBe(false);
		expect(
			await prisma.$transaction((tx) =>
				renewJellyfinEpisodePreparation(tx, {
					...input,
					token: second!.token,
					now: afterExpiry,
				}),
			),
		).toBe(true);
	});

	it("rejects a foreign owner, a mismatched generation, and an already published run", async () => {
		const { prisma } = await database();
		await seedRunningRun(prisma);
		const input = {
			userId: "owner",
			instanceId: "jellyfin-instance",
			runId: "run-1",
			generationId: "run-1",
			now: new Date("2026-09-26T00:00:00.000Z"),
		};
		expect(
			await acquireJellyfinEpisodePreparation(prisma, { ...input, userId: "other" }),
		).toBeNull();
		expect(
			await acquireJellyfinEpisodePreparation(prisma, { ...input, generationId: "other" }),
		).toBeNull();
		const lease = await acquireJellyfinEpisodePreparation(prisma, input);
		if (!lease) throw new Error("Synthetic lease was not acquired");
		expect(
			await prisma.$transaction((tx) =>
				renewJellyfinEpisodePreparation(tx, {
					...input,
					userId: "other",
					token: lease.token,
				}),
			),
		).toBe(false);
		await prisma.jellyfinNativeWatchPublication.create({
			data: {
				instanceId: "jellyfin-instance",
				activeRunId: "run-1",
				activeCacheGenerationId: "run-1",
				activeObservedAt: input.now,
				activeExpectedScopeCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		expect(await acquireJellyfinEpisodePreparation(prisma, input)).toBeNull();
		expect(await releaseJellyfinEpisodePreparation(prisma, { ...input, token: lease.token })).toBe(
			false,
		);
	});

	it("releases only an unpublished lease owned by the caller", async () => {
		const { prisma } = await database();
		await seedRunningRun(prisma);
		const input = {
			userId: "owner",
			instanceId: "jellyfin-instance",
			runId: "run-1",
			generationId: "run-1",
			now: new Date("2026-09-26T00:00:00.000Z"),
		};
		const lease = await acquireJellyfinEpisodePreparation(prisma, input);
		if (!lease) throw new Error("Synthetic lease was not acquired");
		expect(
			await releaseJellyfinEpisodePreparation(prisma, {
				...input,
				userId: "other",
				token: lease.token,
			}),
		).toBe(false);
		expect(await releaseJellyfinEpisodePreparation(prisma, { ...input, token: lease.token })).toBe(
			true,
		);
		expect(
			await prisma.jellyfinEpisodePreparation.findUnique({ where: { runId: "run-1" } }),
		).toMatchObject({ token: lease.token, leaseExpiresAt: input.now });
		expect(await releaseJellyfinEpisodePreparation(prisma, { ...input, token: lease.token })).toBe(
			false,
		);
		const successor = await acquireJellyfinEpisodePreparation(prisma, {
			...input,
			now: new Date(input.now.getTime() + 1),
		});
		expect(successor?.token).toEqual(expect.any(String));
		expect(successor?.token).not.toBe(lease.token);
	});

	it("keeps a released staged run discoverable for terminal cleanup", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(1);
		await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
		});
		expect(await releaseJellyfinEpisodePreparation(prisma, input)).toBe(true);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "invalidated", activeSlotKey: null },
		});

		expect(
			await cleanupObsoleteJellyfinEpisodeGenerations(prisma, {
				userId: input.userId,
				instanceId: input.instanceId,
			}),
		).toBe(1);
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(0);
		expect(await prisma.jellyfinEpisodeGenerationShowReceipt.count()).toBe(0);
		expect(await prisma.jellyfinEpisodePreparation.count()).toBe(0);
	});
});

describe("generation-scoped Jellyfin episode staging", { timeout: 30_000 }, () => {
	it("writes more than one bounded chunk and verifies exact rows and per-show receipts", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(501);
		const expectedFingerprint = fingerprintJellyfinEpisodeRows(rows);
		const staged = await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			expectedFingerprint,
		});
		expect(staged).toEqual({ rowCount: 501, receiptCount: 3, fingerprint: expectedFingerprint });
		const cursorReader = vi.spyOn(prisma.jellyfinEpisodeGenerationRow, "findMany");
		expect(await verifyPreparedJellyfinEpisodeGeneration(prisma, input)).toBe(true);
		expect(cursorReader).not.toHaveBeenCalled();
		expect(await prisma.jellyfinEpisodeCache.count()).toBe(0);
	});

	it("seals a zero-row receipt only for an explicitly covered show", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(2);
		const staged = await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			coveredShowTmdbIds: [42, 99],
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
		});
		expect(staged.receiptCount).toBe(2);
		expect(
			await prisma.jellyfinEpisodeGenerationShowReceipt.findUnique({
				where: {
					instanceId_generationId_showTmdbId: {
						instanceId: input.instanceId,
						generationId: input.generationId,
						showTmdbId: 99,
					},
				},
			}),
		).toMatchObject({
			rowCount: 0,
			contentFingerprint: fingerprintJellyfinEpisodeRows([]),
		});
		expect(await verifyPreparedJellyfinEpisodeGeneration(prisma, input)).toBe(true);
	});

	it("rejects a same-count changed row and a same-count changed show receipt", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(3);
		await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
		});
		const original = await prisma.jellyfinEpisodeGenerationRow.findFirstOrThrow({
			where: { generationId: input.generationId },
		});
		await prisma.jellyfinEpisodeGenerationRow.update({
			where: { id: original.id },
			data: { watched: !original.watched },
		});
		expect(await verifyPreparedJellyfinEpisodeGeneration(prisma, input)).toBe(false);
		await prisma.jellyfinEpisodeGenerationRow.update({
			where: { id: original.id },
			data: { watched: original.watched },
		});
		await prisma.jellyfinEpisodeGenerationRow.update({
			where: { id: original.id },
			data: { identityGeneration: 2 },
		});
		expect(await verifyPreparedJellyfinEpisodeGeneration(prisma, input)).toBe(false);
		await prisma.jellyfinEpisodeGenerationRow.update({
			where: { id: original.id },
			data: { identityGeneration: original.identityGeneration },
		});
		const receipt = await prisma.jellyfinEpisodeGenerationShowReceipt.findFirstOrThrow({
			where: { generationId: input.generationId },
		});
		await prisma.jellyfinEpisodeGenerationShowReceipt.update({
			where: { id: receipt.id },
			data: { contentFingerprint: "same-count-tampering" },
		});
		expect(await verifyPreparedJellyfinEpisodeGeneration(prisma, input)).toBe(false);
	});

	it("fails closed on duplicate coordinates and wrong-owner or expired preparation", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(2);
		const expectedFingerprint = fingerprintJellyfinEpisodeRows(rows);
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				rows: [rows[0]!, rows[0]!],
				expectedFingerprint: fingerprintJellyfinEpisodeRows([rows[0]!, rows[0]!]),
			}),
		).rejects.toThrow();
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				userId: "other",
				rows,
				expectedFingerprint,
			}),
		).rejects.toThrow();
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				now: new Date(input.now.getTime() + 5 * 60_000 + 1_000),
				rows,
				expectedFingerprint,
			}),
		).rejects.toThrow();
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(0);
	});

	it("restarts a partially written generation after an expired worker lease", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(501);
		let clockCalls = 0;
		const expired = new Date(input.now.getTime() + 5 * 60_000 + 1_000);
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				rows,
				expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
				clock: () => (++clockCalls >= 3 ? expired : input.now),
			}),
		).rejects.toThrow();
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(500);
		const successor = await acquireJellyfinEpisodePreparation(prisma, {
			...input,
			now: expired,
		});
		if (!successor) throw new Error("Synthetic successor lease was not acquired");
		await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			now: expired,
			token: successor.token,
			rows,
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
			clock: () => expired,
		});
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(501);
		expect(
			await verifyPreparedJellyfinEpisodeGeneration(prisma, {
				...input,
				now: expired,
				token: successor.token,
			}),
		).toBe(true);
	});

	it("never resets a generation after it becomes the active or previous publication", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(2);
		await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
		});
		await prisma.jellyfinNativeWatchPublication.create({
			data: {
				instanceId: input.instanceId,
				activeRunId: input.runId,
				activeCacheGenerationId: input.generationId,
				activeObservedAt: input.now,
				activeExpectedScopeCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				rows,
				expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
			}),
		).rejects.toThrow();
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(2);
		await prisma.jellyfinNativeWatchPublication.update({
			where: { instanceId: input.instanceId },
			data: { activeRunId: "another-run", previousRunId: input.runId },
		});
		await expect(
			prepareJellyfinEpisodeGeneration(prisma, {
				...input,
				rows,
				expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
			}),
		).rejects.toThrow();
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(2);
	});

	it("replays terminal cleanup in bounded batches without touching legacy rows", async () => {
		const { prisma } = await database();
		const input = await leasedInput(prisma);
		const rows = candidateRows(501);
		await prepareJellyfinEpisodeGeneration(prisma, {
			...input,
			rows,
			expectedFingerprint: fingerprintJellyfinEpisodeRows(rows),
		});
		await prisma.jellyfinEpisodeCache.create({
			data: {
				instanceId: input.instanceId,
				showTmdbId: 90,
				seasonNumber: 1,
				episodeNumber: 1,
				jellyfinId: "legacy",
				title: "Synthetic legacy row",
				watched: false,
				watchedByUsers: "[]",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		expect(await cleanupUnpublishedJellyfinEpisodeGeneration(prisma, input)).toBe(false);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "invalidated", activeSlotKey: null },
		});
		expect(
			await cleanupUnpublishedJellyfinEpisodeGeneration(prisma, {
				...input,
				userId: "foreign",
			}),
		).toBe(false);
		expect(await cleanupUnpublishedJellyfinEpisodeGeneration(prisma, input)).toBe(true);
		expect(await cleanupUnpublishedJellyfinEpisodeGeneration(prisma, input)).toBe(true);
		expect(await prisma.jellyfinEpisodeGenerationRow.count()).toBe(0);
		expect(await prisma.jellyfinEpisodeGenerationShowReceipt.count()).toBe(0);
		expect(await prisma.jellyfinEpisodePreparation.count()).toBe(0);
		expect(await prisma.jellyfinEpisodeCache.count()).toBe(1);
	});

	it("retires only terminal generations outside the active and previous pointers", async () => {
		const { prisma } = await database();
		for (const runId of ["run-1", "run-2", "run-3"]) {
			await seedRunningRun(prisma, runId);
			await prisma.providerObservationRun.update({
				where: { id: runId },
				data: { state: "complete", activeSlotKey: null },
			});
			await prisma.jellyfinEpisodePreparation.create({
				data: {
					runId,
					instanceId: "jellyfin-instance",
					generationId: runId,
					token: `token-${runId}`,
					leaseExpiresAt: new Date(),
					state: "published",
					expectedRowCount: 1,
				},
			});
			await prisma.jellyfinEpisodeGenerationRow.create({
				data: {
					instanceId: "jellyfin-instance",
					generationId: runId,
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					jellyfinId: "synthetic",
					title: "Synthetic",
					watched: true,
					watchedByUsers: "[]",
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
		}
		await prisma.jellyfinNativeWatchPublication.create({
			data: {
				instanceId: "jellyfin-instance",
				activeRunId: "run-3",
				activeCacheGenerationId: "run-3",
				activeObservedAt: new Date(),
				activeExpectedScopeCount: 1,
				previousRunId: "run-2",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await prisma.cacheRefreshStatus.create({
			data: {
				instanceId: "jellyfin-instance",
				cacheType: "jellyfin_episode",
				lastResult: "success",
				lastRefreshedAt: new Date(),
				generationId: "run-3",
				itemCount: 1,
			},
		});
		const input = { userId: "owner", instanceId: "jellyfin-instance" };
		expect(await cleanupObsoleteJellyfinEpisodeGenerations(prisma, input)).toBe(1);
		expect(await cleanupObsoleteJellyfinEpisodeGenerations(prisma, input)).toBe(0);
		expect(
			(await prisma.jellyfinEpisodeGenerationRow.findMany({ select: { generationId: true } }))
				.map((row) => row.generationId)
				.sort(),
		).toEqual(["run-2", "run-3"]);
	});
});
