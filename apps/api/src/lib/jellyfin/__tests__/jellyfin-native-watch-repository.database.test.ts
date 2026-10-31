import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { emptyNativeWatchProjectionDiagnostics } from "../jellyfin-native-watch-projection.js";
import {
	cleanupCompletedJellyfinEpisodeArtifacts,
	cleanupPublishedJellyfinEpisodeArtifacts,
	type NativeWatchPublicationInput,
	prepareNativeWatchGeneration,
	publishNativeWatchGeneration,
	publishPreparedNativeWatchGeneration,
	verifyPreparedNativeWatchGeneration,
} from "../jellyfin-native-watch-repository.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const now = new Date("2026-09-24T12:00:00.000Z");

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-native-watch-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "native-watch-test" } });
	await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-instance",
			userId: "owner",
			service: "JELLYFIN",
			label: "Test",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			identityStatus: "VERIFIED",
			expectedIdentity: "server-id",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	return prisma;
}

async function seedCompletedRun(
	prisma: Awaited<ReturnType<typeof database>>,
	runId: string,
	generationId: string,
) {
	await prisma.providerObservationRun.create({
		data: {
			id: runId,
			instanceId: "jellyfin-instance",
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: `authority-${runId}`,
			targetDigest: `digest-${runId}`,
			targetCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "complete",
			totalUnits: 2,
			completedUnits: 2,
			totalWork: 1,
			completedWork: 1,
			completedAt: now,
		},
	});
	await prisma.cacheRefreshStatus.upsert({
		where: {
			instanceId_cacheType: {
				instanceId: "jellyfin-instance",
				cacheType: "jellyfin_episode",
			},
		},
		create: {
			instanceId: "jellyfin-instance",
			cacheType: "jellyfin_episode",
			lastRefreshedAt: now,
			lastResult: "success",
			generationId,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
		update: { generationId, lastRefreshedAt: now },
	});
}

async function seedRunningRun(prisma: Awaited<ReturnType<typeof database>>, runId: string) {
	await seedCompletedRun(prisma, runId, `${runId}-generation`);
	await prisma.providerObservationRun.update({
		where: { id: runId },
		data: { state: "running", activeSlotKey: `${runId}-slot`, completedAt: null },
	});
	await prisma.jellyfinEpisodePreparation.create({
		data: {
			runId,
			instanceId: "jellyfin-instance",
			generationId: runId.replace(/-run$/, "-generation"),
			token: "test-preparation-token",
			leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
			state: "verified",
		},
	});
}

function publication(
	runId: string,
	cacheGenerationId: string,
): NativeWatchPublicationInput & { preparationToken: string } {
	return {
		instanceId: "jellyfin-instance",
		runId,
		cacheGenerationId,
		preparationToken: "test-preparation-token",
		connectionGeneration: 1,
		identityGeneration: 1,
		observedAt: now,
		expectedScopeCount: 1,
		candidates: [
			{
				userKeyDigest: "user-digest",
				libraryId: "library-a",
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				played: false,
				playCount: 0,
				lastPlayedAt: null,
			},
		],
		receipts: [
			{
				userKeyDigest: "user-digest",
				libraryId: "library-a",
				expectedRawCount: 1,
				observedRawCount: 1,
				exact: true,
				contentFingerprint: "a".repeat(64),
			},
		],
	};
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
});

describe("native watch publication", { timeout: 30_000 }, () => {
	it.each(["direct", "prepared"])(
		"persists constant-key diagnostics on the correct %s publication",
		async (mode) => {
			const prisma = await database();
			const base = publication("new-run", "new-generation");
			const diagnosticsJson = JSON.stringify({
				version: 1,
				...emptyNativeWatchProjectionDiagnostics(),
				collectUnits: 1,
				verifyUnits: 1,
				collectStageRows: 1,
				verifyStageRows: 1,
				expectedCountsMatch: true,
				excludedRows: 0,
			});
			const input = {
				...base,
				userId: "owner",
				receipts: base.receipts.map((r) => ({ ...r, diagnosticsJson })),
			};
			if (mode === "direct") {
				await seedCompletedRun(prisma, "new-run", "new-generation");
				await prisma.$transaction((tx) => publishNativeWatchGeneration(tx, input));
			} else {
				await seedRunningRun(prisma, "new-run");
				await prepareNativeWatchGeneration(prisma, input);
				await verifyPreparedNativeWatchGeneration(prisma, input);
			}
			expect(
				await prisma.jellyfinNativeWatchScopeReceipt.findFirst({ where: { runId: "new-run" } }),
			).toMatchObject({
				runId: "new-run",
				diagnosticsJson,
				exact: true,
				contentFingerprint: "a".repeat(64),
				connectionGeneration: 1,
				identityGeneration: 1,
			});
		},
	);
	it("retains nullable diagnostics in direct and prepared runs without changing fingerprints or exactness", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "old-run", "old-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("old-run", "old-generation")),
		);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.findFirst({ where: { runId: "old-run" } }),
		).toMatchObject({ diagnosticsJson: null, exact: true, contentFingerprint: "a".repeat(64) });
		await seedRunningRun(prisma, "new-run");
		const base = publication("new-run", "new-generation");
		const input = {
			...base,
			userId: "owner",
			receipts: base.receipts.map((receipt) => ({
				...receipt,
				diagnosticsJson: '{"legacy-forged":true}',
			})),
		};
		await prepareNativeWatchGeneration(prisma, input);
		await verifyPreparedNativeWatchGeneration(prisma, input);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.findFirst({ where: { runId: "new-run" } }),
		).toMatchObject({ diagnosticsJson: null, exact: true, contentFingerprint: "a".repeat(64) });
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.findFirst({ where: { runId: "old-run" } }),
		).toMatchObject({ diagnosticsJson: null });
	});
	it("reports staging progress without exposing inputs or letting an observer change success", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const stages: Array<{ stage: string; count?: number }> = [];
		await prepareNativeWatchGeneration(
			prisma,
			{ ...publication("new-run", "new-generation"), userId: "owner" },
			(event) => {
				stages.push(event);
				throw new Error("synthetic observer failure");
			},
		);
		expect(stages.map((event) => event.stage)).toEqual(
			expect.arrayContaining([
				"lease-checkpoint",
				"authority-check",
				"own-row-reset",
				"own-receipt-reset",
				"row-chunk-write",
				"receipt-chunk-write",
				"row-verification",
				"receipt-verification",
			]),
		);
		expect(stages).toContainEqual({ stage: "row-chunk-write", count: 1 });
		expect(stages).toContainEqual({ stage: "receipt-chunk-write", count: 1 });
		for (const event of stages)
			expect(Object.keys(event).sort()).toEqual(
				event.count === undefined ? ["stage"] : ["count", "stage"],
			);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } })).toBe(1);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: "new-run" } }),
		).toBe(1);
	});

	it.each([
		["jellyfin_native_watch_rows", "row-chunk-write"],
		["jellyfin_native_watch_scope_receipts", "receipt-chunk-write"],
	] as const)(
		"locates a real rejected write to %s and preserves the prior publication",
		async (table, stage) => {
			const prisma = await database();
			await seedCompletedRun(prisma, "old-run", "old-generation");
			await prisma.$transaction((tx) =>
				publishNativeWatchGeneration(tx, publication("old-run", "old-generation")),
			);
			await seedRunningRun(prisma, "new-run");
			await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_diagnostic_write BEFORE INSERT ON "${table}"
			WHEN NEW.runId = 'new-run' BEGIN SELECT RAISE(ABORT, 'synthetic write rejection'); END`);
			let current: { stage: string; count?: number } | undefined;
			await expect(
				prepareNativeWatchGeneration(
					prisma,
					{ ...publication("new-run", "new-generation"), userId: "owner" },
					(event) => {
						current = event;
						throw new Error("synthetic observer failure");
					},
				),
			).rejects.toMatchObject({ code: "P2003" });
			expect(current).toEqual({ stage, count: 1 });
			expect(
				await prisma.jellyfinNativeWatchPublication.findUnique({
					where: { instanceId: "jellyfin-instance" },
				}),
			).toMatchObject({ activeRunId: "old-run", activeCacheGenerationId: "old-generation" });
			expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "old-run" } })).toBe(1);
		},
	);

	it("rebuilds an interrupted unpublished run without changing the active pointer", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "old-run", "old-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("old-run", "old-generation")),
		);
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prisma.jellyfinNativeWatchRow.create({
			data: {
				instanceId: input.instanceId,
				runId: input.runId,
				...input.candidates[0]!,
				episodeNumber: 99,
				observedAt: now,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});

		await prepareNativeWatchGeneration(prisma, input);

		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toMatchObject({ activeRunId: "old-run" });
		expect(
			await prisma.jellyfinNativeWatchRow.findMany({ where: { runId: input.runId } }),
		).toMatchObject([{ episodeNumber: 1, jellyfinId: "episode-1" }]);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: input.runId } }),
		).toBe(1);
	});

	it("renews the exact preparation lease while staging native rows", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-run"), userId: "owner" };
		await prisma.jellyfinEpisodePreparation.update({
			where: { runId: input.runId },
			data: {
				generationId: input.runId,
				leaseExpiresAt: new Date(Date.now() + 60_000),
			},
		});

		await prepareNativeWatchGeneration(prisma, input);

		const preparation = await prisma.jellyfinEpisodePreparation.findUnique({
			where: { runId: input.runId },
			select: { token: true, state: true, leaseExpiresAt: true },
		});
		expect(preparation).toMatchObject({
			token: input.preparationToken,
			state: "verified",
		});
		expect(preparation!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(1);
	});

	it("renews across later staging and verification checkpoints", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const baseline = publication("new-run", "new-generation");
		const candidates = Array.from({ length: 5_501 }, (_, index) => ({
			...baseline.candidates[0]!,
			jellyfinId: `episode-${String(index).padStart(5, "0")}`,
			episodeNumber: index + 1,
		}));
		const input = {
			...baseline,
			userId: "owner",
			candidates,
			receipts: [
				{
					...baseline.receipts[0]!,
					expectedRawCount: candidates.length,
					observedRawCount: candidates.length,
				},
			],
		};
		await prisma.$executeRawUnsafe(`
			CREATE TRIGGER shorten_lease_after_tenth_chunk
			AFTER INSERT ON jellyfin_native_watch_rows
			WHEN NEW.jellyfinId = 'episode-04999'
			BEGIN
				UPDATE jellyfin_episode_preparations
				SET leaseExpiresAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
				WHERE runId = NEW.runId;
			END
		`);
		await prisma.$executeRawUnsafe(`
			CREATE TRIGGER require_later_lease_renewal
			BEFORE INSERT ON jellyfin_native_watch_rows
			WHEN NEW.jellyfinId = 'episode-05000'
			BEGIN
				SELECT CASE WHEN (
					SELECT leaseExpiresAt FROM jellyfin_episode_preparations WHERE runId = NEW.runId
				) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+240 seconds')
				THEN RAISE(ABORT, 'missing later preparation lease renewal') END;
			END
		`);

		await prepareNativeWatchGeneration(prisma, input);

		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(
			candidates.length,
		);
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toBeNull();
	}, 60_000);

	it("rejects a displaced worker before it can replace the takeover worker's native rows", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const oldWorker = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, oldWorker);
		const newObservedAt = new Date(now.getTime() + 1_000);
		await prisma.jellyfinEpisodePreparation.update({
			where: { runId: oldWorker.runId },
			data: {
				token: "takeover-token",
				leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
				state: "verified",
			},
		});
		const takeover = {
			...oldWorker,
			preparationToken: "takeover-token",
			observedAt: newObservedAt,
		};
		await prepareNativeWatchGeneration(prisma, takeover);

		await expect(prepareNativeWatchGeneration(prisma, oldWorker)).rejects.toMatchObject({
			name: "JellyfinNativeWatchLeaseLostError",
		});
		expect(
			await prisma.jellyfinNativeWatchRow.findMany({ where: { runId: oldWorker.runId } }),
		).toMatchObject([{ observedAt: newObservedAt }]);
	});

	it("rejects a pointer commit when native rows have a different observation time", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, input);
		await prisma.jellyfinNativeWatchRow.updateMany({
			where: { instanceId: input.instanceId, runId: input.runId },
			data: { observedAt: new Date(input.observedAt.getTime() + 1_000) },
		});
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "complete", activeSlotKey: null, completedAt: now },
		});
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
			},
			data: { generationId: input.cacheGenerationId },
		});

		await expect(
			prisma.$transaction((tx) =>
				publishPreparedNativeWatchGeneration(tx, {
					instanceId: input.instanceId,
					runId: input.runId,
					userId: input.userId,
					cacheGenerationId: input.cacheGenerationId,
					connectionGeneration: input.connectionGeneration,
					identityGeneration: input.identityGeneration,
					observedAt: input.observedAt,
					expectedScopeCount: input.expectedScopeCount,
					candidateCount: input.candidates.length,
					receiptCount: input.receipts.length,
				}),
			),
		).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toBeNull();
	});

	it("rejects a same-count native row mismatch before pointer publication", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, input);
		await prisma.jellyfinNativeWatchRow.updateMany({
			where: { instanceId: input.instanceId, runId: input.runId },
			data: { episodeNumber: 99 },
		});

		await expect(verifyPreparedNativeWatchGeneration(prisma, input)).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toBeNull();
	});

	it("rejects a native candidate without a matching scope receipt", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		input.receipts = [{ ...input.receipts[0]!, libraryId: "different-library" }];

		await expect(prepareNativeWatchGeneration(prisma, input)).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toBeNull();
	});

	it("rebuilds exactly after an interrupted second native-write chunk", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		const first = input.candidates[0]!;
		const unique = Array.from({ length: 501 }, (_, index) => ({
			...first,
			jellyfinId: `episode-${String(index).padStart(4, "0")}`,
			episodeNumber: index + 1,
		}));
		await expect(
			prepareNativeWatchGeneration(prisma, {
				...input,
				candidates: [...unique.slice(0, 500), unique[0]!],
			}),
		).rejects.toThrow();
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(500);

		const cursorReader = vi.spyOn(prisma.jellyfinNativeWatchRow, "findMany");
		await prepareNativeWatchGeneration(prisma, { ...input, candidates: unique });
		expect(cursorReader).not.toHaveBeenCalled();

		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(501);
		expect(
			await prisma.jellyfinNativeWatchRow.findFirst({
				where: { runId: input.runId, jellyfinId: "episode-0500" },
			}),
		).toMatchObject({ episodeNumber: 501 });
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toBeNull();
	});

	it.each(["candidate", "receipt"] as const)(
		"waits for a competing SQLite writer before reading and staging a %s chunk",
		async (kind) => {
			const prisma = await database();
			await seedRunningRun(prisma, "new-run");
			const preparationBefore = await prisma.jellyfinEpisodePreparation.findUnique({
				where: { runId: "new-run" },
			});
			const baseline = publication("new-run", "new-generation");
			const input = {
				...baseline,
				userId: "owner",
				...(kind === "receipt"
					? {
							candidates: [],
							receipts: [{ ...baseline.receipts[0]!, expectedRawCount: 0, observedRawCount: 0 }],
						}
					: {}),
			};
			const dbPath = join(databases.at(-1)!.directory, "test.db");
			const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
			const originalTransaction = prisma.$transaction.bind(prisma);
			let lockHolder: Worker | undefined;
			let firstChunk = true;
			const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
				...args: never[]
			) => {
				if (firstChunk) {
					firstChunk = false;
					lockHolder = new Worker(
						`const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.modulePath);
const db = new Database(workerData.dbPath);
try {
  db.exec(\`BEGIN IMMEDIATE; UPDATE "ServiceInstance" SET "label" = "label" WHERE "id" = 'jellyfin-instance';\`);
  parentPort.postMessage("held");
  setTimeout(() => {
    try { db.exec("COMMIT"); parentPort.postMessage("released"); }
    catch { parentPort.postMessage("release-failed"); }
    finally { db.close(); }
  }, 400);
} catch { parentPort.postMessage("hold-failed"); db.close(); }`,
						{ eval: true, workerData: { dbPath, modulePath } },
					);
					await new Promise<void>((resolve, reject) => {
						lockHolder!.once("message", (state) => {
							if (state === "held") resolve();
							else reject(new Error("Synthetic SQLite writer did not acquire its lock"));
						});
						lockHolder!.once("error", reject);
					});
				}
				return await (originalTransaction as (...values: never[]) => Promise<unknown>)(...args);
			}) as typeof prisma.$transaction);
			try {
				await expect(prepareNativeWatchGeneration(prisma, input)).resolves.toBeUndefined();
				expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(
					kind === "candidate" ? 1 : 0,
				);
				expect(
					await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: input.runId } }),
				).toBe(1);
				const preparationAfter = await prisma.jellyfinEpisodePreparation.findUnique({
					where: { runId: input.runId },
				});
				expect(preparationAfter).toMatchObject({
					runId: preparationBefore!.runId,
					instanceId: preparationBefore!.instanceId,
					generationId: preparationBefore!.generationId,
					token: preparationBefore!.token,
					state: "verified",
				});
				expect(preparationAfter!.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
					preparationBefore!.leaseExpiresAt.getTime(),
				);
				expect(
					await prisma.jellyfinNativeWatchPublication.findUnique({
						where: { instanceId: input.instanceId },
					}),
				).toBeNull();
			} finally {
				transactionSpy.mockRestore();
				if (lockHolder) await lockHolder.terminate();
			}
		},
	);

	it("rejects a preparation reset for another owner or an already published run", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, input);
		await expect(
			prepareNativeWatchGeneration(prisma, { ...input, userId: "other-owner" }),
		).rejects.toThrow();
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(1);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "complete", activeSlotKey: null, completedAt: now },
		});
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
			},
			data: { generationId: input.cacheGenerationId },
		});
		await prisma.$transaction((tx) =>
			publishPreparedNativeWatchGeneration(tx, {
				instanceId: input.instanceId,
				runId: input.runId,
				userId: input.userId,
				cacheGenerationId: input.cacheGenerationId,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
				observedAt: input.observedAt,
				expectedScopeCount: input.expectedScopeCount,
				candidateCount: input.candidates.length,
				receiptCount: input.receipts.length,
			}),
		);
		await expect(prepareNativeWatchGeneration(prisma, input)).rejects.toThrow();
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(1);
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toMatchObject({ activeRunId: input.runId });
	});

	it("does not change another instance's unpublished native rows", async () => {
		const prisma = await database();
		await prisma.user.create({
			data: { id: "other-owner", username: "second-native-watch-owner" },
		});
		await prisma.serviceInstance.create({
			data: {
				id: "other-instance",
				userId: "other-owner",
				service: "JELLYFIN",
				label: "Second test instance",
				baseUrl: "http://other.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
				identityStatus: "VERIFIED",
				expectedIdentity: "other-server",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await prisma.providerObservationRun.create({
			data: {
				id: "other-run",
				instanceId: "other-instance",
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				authorityKey: "other-authority",
				activeSlotKey: "other-slot",
				targetDigest: "other-digest",
				targetCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
				state: "running",
				totalUnits: 2,
				completedUnits: 2,
				totalWork: 1,
				completedWork: 1,
			},
		});
		await prisma.jellyfinNativeWatchRow.create({
			data: {
				instanceId: "other-instance",
				runId: "other-run",
				...publication("other-run", "other-generation").candidates[0]!,
				observedAt: now,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await seedRunningRun(prisma, "new-run");

		await prepareNativeWatchGeneration(prisma, {
			...publication("new-run", "new-generation"),
			userId: "owner",
		});

		expect(
			await prisma.jellyfinNativeWatchRow.count({
				where: { instanceId: "other-instance", runId: "other-run" },
			}),
		).toBe(1);
	});

	it("does not accept a lost-ack retry when the active run has mismatched metadata", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "new-run");
		const input = { ...publication("new-run", "new-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, input);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "complete", activeSlotKey: null, completedAt: now },
		});
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
			},
			data: { generationId: input.cacheGenerationId },
		});
		const prepared = {
			instanceId: input.instanceId,
			runId: input.runId,
			userId: input.userId,
			cacheGenerationId: input.cacheGenerationId,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
			observedAt: input.observedAt,
			expectedScopeCount: input.expectedScopeCount,
			candidateCount: input.candidates.length,
			receiptCount: input.receipts.length,
		};
		await prisma.$transaction((tx) => publishPreparedNativeWatchGeneration(tx, prepared));
		await prisma.jellyfinNativeWatchPublication.update({
			where: { instanceId: input.instanceId },
			data: { activeCacheGenerationId: "mismatched-generation" },
		});

		await expect(
			prisma.$transaction((tx) => publishPreparedNativeWatchGeneration(tx, prepared)),
		).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId },
			}),
		).toMatchObject({ activeRunId: input.runId, activeCacheGenerationId: "mismatched-generation" });
	});
	it("lets a pending read run between completed cleanup batches", async () => {
		const events: string[] = [];
		let deletes = 0;
		const prisma = {
			providerObservationRun: { findFirst: async () => ({ id: "completed-run" }) },
			$executeRaw: async () => {
				deletes += 1;
				events.push(`delete-${deletes}`);
				if (deletes === 1) {
					setImmediate(() => events.push("pending-read"));
					return 1;
				}
				return 0;
			},
		} as unknown as Parameters<typeof cleanupPublishedJellyfinEpisodeArtifacts>[0];

		await cleanupPublishedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance", "completed-run");
		expect(events.indexOf("pending-read")).toBeGreaterThan(-1);
		expect(events.indexOf("pending-read")).toBeLessThan(events.indexOf("delete-2"));
	});

	it("atomically preserves the old active generation when a later chunk fails", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "old-run", "old-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("old-run", "old-generation")),
		);
		await seedCompletedRun(prisma, "new-run", "new-generation");
		const input = publication("new-run", "new-generation");
		const first = input.candidates[0]!;
		input.candidates = [
			first,
			...Array.from({ length: 499 }, (_, index) => ({
				...first,
				jellyfinId: `episode-${index + 2}`,
				episodeNumber: index + 2,
			})),
			first,
		];
		await expect(
			prisma.$transaction((tx) => publishNativeWatchGeneration(tx, input)),
		).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: "jellyfin-instance" },
			}),
		).toMatchObject({ activeRunId: "old-run" });
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "old-run" } })).toBe(1);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "new-run" } })).toBe(0);
	});

	it("rejects a losing finalizer whose cache generation was superseded", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "winner", "winner-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("winner", "winner-generation")),
		);
		await seedCompletedRun(prisma, "loser", "loser-generation");
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-instance", cacheType: "jellyfin_episode" },
			},
			data: { generationId: "winner-generation" },
		});
		await expect(
			prisma.$transaction((tx) =>
				publishNativeWatchGeneration(tx, publication("loser", "loser-generation")),
			),
		).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: "jellyfin-instance" },
			}),
		).toMatchObject({ activeRunId: "winner" });
	});

	it("rejects an identity-generation change without altering the readable generation", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "old-run", "old-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("old-run", "old-generation")),
		);
		await seedCompletedRun(prisma, "new-run", "new-generation");
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-instance" },
			data: { identityGeneration: 2 },
		});
		await expect(
			prisma.$transaction((tx) =>
				publishNativeWatchGeneration(tx, publication("new-run", "new-generation")),
			),
		).rejects.toThrow();
		expect(
			await prisma.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: "jellyfin-instance" },
			}),
		).toMatchObject({ activeRunId: "old-run" });
	});

	it("stores an incomplete scope receipt without claiming catalog exactness", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "partial-run", "partial-generation");
		const input = publication("partial-run", "partial-generation");
		input.receipts = [{ ...input.receipts[0]!, observedRawCount: 2, exact: false }];
		await prisma.$transaction((tx) => publishNativeWatchGeneration(tx, input));
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.findFirst({ where: { runId: "partial-run" } }),
		).toMatchObject({ exact: false, expectedRawCount: 1, observedRawCount: 2 });
	});

	it("prunes completed staging and retired watch rows only after the pointer advances", async () => {
		const prisma = await database();
		for (const [runId, generationId] of [
			["old-run", "old-generation"],
			["middle-run", "middle-generation"],
			["active-run", "active-generation"],
		] as const) {
			await seedCompletedRun(prisma, runId, generationId);
			await prisma.$transaction((tx) =>
				publishNativeWatchGeneration(tx, publication(runId, generationId)),
			);
		}
		await prisma.providerObservationUnit.create({
			data: {
				id: "active-unit",
				runId: "active-run",
				ordinal: 0,
				scopeKey: "active-scope",
				scopeDigest: "active-digest",
				phase: "collect",
				expectedTargets: 1,
				cursor: 1,
				expectedRawCount: 1,
				observedRawCount: 1,
				state: "complete",
			},
		});
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: "active-run",
				unitId: "active-unit",
				userKeyDigest: "user-digest",
				pass: "collect",
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Synthetic episode",
				played: false,
				userName: "",
			},
		});
		expect(await prisma.jellyfinNativeWatchRow.count()).toBe(3);
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "active-run" } }),
		).toBe(1);
		// Simulate a restart after the pointer committed but before cleanup began.
		await cleanupCompletedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance");
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "old-run" } })).toBe(0);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "middle-run" } })).toBe(1);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "active-run" } })).toBe(1);
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "active-run" } }),
		).toBe(0);
		await cleanupPublishedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance", "active-run");
		expect(await prisma.jellyfinNativeWatchRow.count()).toBe(2);
	});

	it("does not remove staging for an unfinished run", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "running-run", "running-generation");
		await prisma.providerObservationRun.update({
			where: { id: "running-run" },
			data: { state: "running", activeSlotKey: "running-slot", completedAt: null },
		});
		await prisma.providerObservationUnit.create({
			data: {
				id: "running-unit",
				runId: "running-run",
				ordinal: 0,
				scopeKey: "running-scope",
				scopeDigest: "running-digest",
				phase: "collect",
				expectedTargets: 1,
				state: "complete",
			},
		});
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: "running-run",
				unitId: "running-unit",
				userKeyDigest: "user-digest",
				pass: "collect",
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Synthetic episode",
				played: false,
				userName: "",
			},
		});
		await cleanupPublishedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance", "running-run");
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: "running-run" } }),
		).toBe(1);
	});

	it("preserves unpublished rows of a running run during completed-run cleanup", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "active-run", "active-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("active-run", "active-generation")),
		);
		await seedCompletedRun(prisma, "preparing-run", "preparing-generation");
		await prisma.providerObservationRun.update({
			where: { id: "preparing-run" },
			data: { state: "running", activeSlotKey: "preparing-slot", completedAt: null },
		});
		const candidate = publication("preparing-run", "preparing-generation").candidates[0]!;
		await prisma.jellyfinNativeWatchRow.create({
			data: {
				instanceId: "jellyfin-instance",
				runId: "preparing-run",
				...candidate,
				observedAt: now,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});

		await cleanupPublishedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance", "active-run");

		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "preparing-run" } })).toBe(
			1,
		);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "active-run" } })).toBe(1);
	});

	it("reclaims invalidated unpublished staging and receipts without touching the active run", async () => {
		const prisma = await database();
		await seedCompletedRun(prisma, "active-run", "active-generation");
		await prisma.$transaction((tx) =>
			publishNativeWatchGeneration(tx, publication("active-run", "active-generation")),
		);
		await seedRunningRun(prisma, "invalid-run");
		const input = { ...publication("invalid-run", "invalid-generation"), userId: "owner" };
		await prisma.providerObservationUnit.create({
			data: {
				id: "invalid-unit",
				runId: input.runId,
				ordinal: 0,
				scopeKey: "invalid-scope",
				scopeDigest: "invalid-digest",
				phase: "collect",
				expectedTargets: 1,
				state: "complete",
			},
		});
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: input.runId,
				unitId: "invalid-unit",
				userKeyDigest: "user-digest",
				pass: "collect",
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Synthetic episode",
				played: false,
				userName: "",
			},
		});
		await prepareNativeWatchGeneration(prisma, input);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "invalidated", activeSlotKey: null, completedAt: now },
		});

		await cleanupCompletedJellyfinEpisodeArtifacts(prisma, input.instanceId);

		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: input.runId } }),
		).toBe(0);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(0);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: input.runId } }),
		).toBe(0);
		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: "active-run" } })).toBe(1);
	});

	it("resumes cleanup when only invalidated native rows and receipts remain", async () => {
		const prisma = await database();
		await seedRunningRun(prisma, "invalid-run");
		const input = { ...publication("invalid-run", "invalid-generation"), userId: "owner" };
		await prepareNativeWatchGeneration(prisma, input);
		await prisma.providerObservationRun.update({
			where: { id: input.runId },
			data: { state: "invalidated", activeSlotKey: null, completedAt: now },
		});

		await cleanupCompletedJellyfinEpisodeArtifacts(prisma, input.instanceId);

		expect(await prisma.jellyfinNativeWatchRow.count({ where: { runId: input.runId } })).toBe(0);
		expect(
			await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId: input.runId } }),
		).toBe(0);
	});

	it("drains completed-run staging across multiple restart-recovery batches", async () => {
		const prisma = await database();
		for (let index = 0; index < 33; index++) {
			const runId = `completed-${index}`;
			const unitId = `unit-${index}`;
			await seedCompletedRun(prisma, runId, `generation-${index}`);
			await prisma.providerObservationUnit.create({
				data: {
					id: unitId,
					runId,
					ordinal: 0,
					scopeKey: `scope-${index}`,
					scopeDigest: `digest-${index}`,
					phase: "collect",
					expectedTargets: 1,
					state: "complete",
				},
			});
			await prisma.jellyfinEpisodeObservationStage.create({
				data: {
					runId,
					unitId,
					userKeyDigest: "user-digest",
					pass: "collect",
					jellyfinId: `episode-${index}`,
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: index + 1,
					title: "Synthetic episode",
					played: false,
					userName: "",
				},
			});
		}
		await cleanupCompletedJellyfinEpisodeArtifacts(prisma, "jellyfin-instance");
		expect(await prisma.jellyfinEpisodeObservationStage.count()).toBe(0);
	});
});
