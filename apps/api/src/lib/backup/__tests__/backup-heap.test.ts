/**
 * Heap-measurement test for v2.18.4 OOM fix.
 *
 * Uses 5,000 synthetic huntLog rows and 2,000 huntSearchHistory rows in a
 * fresh full-schema SQLite database. Calls the real backup/crypto paths.
 *
 * Opt in from apps/api with TEST_HEAP=true and Vitest options:
 * --pool=forks --execArgv=--expose-gc --execArgv=--max-old-space-size=768
 * --maxWorkers=1 --no-file-parallelism
 *
 * What this test proves vs. doesn't:
 *  - Measures post-operation heap and post-GC retained growth on this dataset.
 *  - Checks real encrypted output, scheduled history omission and an explicit
 *    manual retention limit large enough to include every seeded history row.
 *  - Does not measure peak heap/RSS or reproduce 50k rows/production data.
 *    Node's 768 MiB old-space flag is not a 768 MiB process/RSS limit.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { BackupData, BackupFileInfo } from "@arr/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient } from "../../prisma.js";
import { decryptBackupData, type EncryptedBackupEnvelope } from "../backup-crypto.js";
import { BackupService } from "../backup-service.js";

const RUN_HEAP_TESTS = process.env.TEST_HEAP === "true";
const execFileAsync = promisify(execFile);
const TEST_PASSWORD = "synthetic-heap-backup-password";
const TEST_SECRETS = {
	encryptionKey: "a".repeat(64),
	sessionCookieSecret: "synthetic-heap-session-secret".repeat(2),
};
const HUNT_LOGS = 5_000;
const HUNT_HISTORY = 2_000;

function collectGarbage(): void {
	if (typeof global.gc !== "function") {
		throw new Error("Heap tests require --execArgv=--expose-gc with the forks pool");
	}
	global.gc();
}

// Synthetic huntLog `details` blob shaped like a real one — search results
// from arr-sdk include indexer name, release title, size, indexer flags,
// rejection reasons. Real rows are 5–50 KB; we target ~3 KB to keep the
// test runtime reasonable while still exercising the JSON-blob memory
// pattern that broke production.
function makeRealisticDetailsBlob(seed: number): string {
	const releases = Array.from({ length: 6 }, (_, i) => ({
		guid: `https://indexer.example.com/release/${seed}-${i}`,
		title: `Some.Movie.Title.${seed}.${i}.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.7.1-RELEASEGRP`,
		indexer: `Indexer-${i % 4}`,
		size: 25_000_000_000 + i * 1_000_000,
		seeders: 50 - i,
		leechers: i,
		ageHours: i * 12,
		quality: { id: 19, name: "Bluray-2160p Remux", source: "bluray" },
		languages: [{ id: 1, name: "English" }],
		rejected: i > 2,
		rejections: i > 2 ? ["Custom format rejected"] : [],
	}));
	return JSON.stringify({ releases, totalAvailable: 47, attemptedAt: new Date().toISOString() });
}

(RUN_HEAP_TESTS ? describe : describe.skip)(
	"BackupService — synthetic 5k/2k heap checks (TEST_HEAP=true)",
	() => {
		let prisma: PrismaClient;
		let backupService: BackupService;
		let testBackupsDir: string;
		let testSecretsPath: string;
		let testDbPath: string;

		beforeAll(async () => {
			collectGarbage();
			// V8 accepts underscores too, and later duplicate flags override earlier ones.
			const oldSpaceFlags = process.execArgv.filter((argument) =>
				/^--max[-_]old[-_]space[-_]size(?:=|$)/.test(argument),
			);
			if (oldSpaceFlags.length !== 1 || oldSpaceFlags[0] !== "--max-old-space-size=768") {
				throw new Error("Heap tests require exactly one --execArgv=--max-old-space-size=768");
			}
			console.log({
				gcAvailable: true,
				oldSpaceFlagMiB: 768,
				observedHeapLimitMiB: getHeapStatistics().heap_size_limit / 1024 / 1024,
			});
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("BACKUP_PASSWORD", TEST_PASSWORD);
			// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
			// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
			testBackupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-heap-"));
			testSecretsPath = path.join(testBackupsDir, "secrets.json");
			testDbPath = path.join(testBackupsDir, "heap-test.db");

			await execFileAsync(
				"pnpm",
				[
					"exec",
					"prisma",
					"db",
					"push",
					"--schema",
					"prisma/schema.prisma",
					"--url",
					`file:${testDbPath}`,
				],
				{
					cwd: path.resolve(import.meta.dirname, "../../../.."),
					env: { ...process.env, DATABASE_URL: `file:${testDbPath}` },
					timeout: 60_000,
				},
			);
			await fs.writeFile(testSecretsPath, JSON.stringify(TEST_SECRETS), { mode: 0o600 });

			prisma = createTestPrismaClient(testDbPath);
			backupService = new BackupService(
				prisma,
				testSecretsPath,
				new Encryptor(TEST_SECRETS.encryptionKey),
			);

			// Seed a service instance so huntConfig FKs resolve.
			await prisma.user.create({
				data: { id: "heap-user", username: "heap-user" },
			});
			const instance = await prisma.serviceInstance.create({
				data: {
					id: "heap-inst",
					userId: "heap-user",
					service: "RADARR",
					label: "Heap Test Radarr",
					baseUrl: "http://radarr:7878",
					encryptedApiKey: "x",
					encryptionIv: "y",
				},
			});

			const huntConfig = await prisma.huntConfig.create({
				data: {
					id: "heap-cfg",
					instanceId: instance.id,
					huntMissingEnabled: true,
					missingBatchSize: 5,
				},
			});

			// Seed 5k huntLog rows with ~3 KB JSON blobs each → ~15 MB of raw
			// row data. Plus 2k huntSearchHistory rows. This is the row shape
			// + row count that exercises the OOM-prone path. Larger seeds
			// (50k) would more faithfully reproduce the reporter's scenario,
			// but keep the test runtime under ~30s for CI feasibility.
			console.log(`Seeding ${HUNT_LOGS} huntLog rows + ${HUNT_HISTORY} huntSearchHistory rows...`);
			const seedStart = Date.now();

			// Bulk insert via createMany for speed.
			const huntLogRows = Array.from({ length: HUNT_LOGS }, (_, i) => ({
				id: `hl-${i}`,
				instanceId: instance.id,
				huntType: "missing",
				itemsSearched: 10,
				itemsFound: 3,
				searchedItems: makeRealisticDetailsBlob(i),
				foundItems: makeRealisticDetailsBlob(i + 100000),
				status: "completed",
				startedAt: new Date(Date.now() - i * 60_000),
				completedAt: new Date(Date.now() - i * 60_000 + 30_000),
			}));
			await prisma.huntLog.createMany({ data: huntLogRows });

			const huntHistoryRows = Array.from({ length: HUNT_HISTORY }, (_, i) => ({
				id: `hh-${i}`,
				configId: huntConfig.id,
				mediaType: "movie",
				mediaId: 1000 + i,
				title: `Synthetic Title ${i} with a reasonably long descriptive name`,
				huntType: "missing",
				searchedAt: new Date(Date.now() - i * 60_000),
			}));
			await prisma.huntSearchHistory.createMany({ data: huntHistoryRows });
			expect(await prisma.huntLog.count()).toBe(HUNT_LOGS);
			expect(await prisma.huntSearchHistory.count()).toBe(HUNT_HISTORY);

			console.log(`Seed complete in ${Date.now() - seedStart}ms`);
		}, 120_000);

		afterAll(async () => {
			try {
				await prisma?.$disconnect();
			} finally {
				try {
					if (testBackupsDir) await fs.rm(testBackupsDir, { recursive: true, force: true });
				} finally {
					vi.unstubAllEnvs();
				}
			}
		});

		async function expectBackupHistory(
			backup: BackupFileInfo,
			logs: number,
			history: number,
		): Promise<void> {
			const internal = await backupService.getBackupByIdInternal(backup.id);
			expect(internal).not.toBeNull();
			const backupPath = path.join(testBackupsDir, "backups", backup.type, backup.filename);
			expect(internal?.path).toBe(backupPath);
			expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
			const envelope: EncryptedBackupEnvelope = JSON.parse(await fs.readFile(backupPath, "utf8"));
			const restored: BackupData = JSON.parse(await decryptBackupData(envelope, TEST_PASSWORD));
			expect(restored.data.users).toHaveLength(1);
			expect(restored.data.serviceInstances).toHaveLength(1);
			expect(restored.data.huntLogs).toHaveLength(logs);
			expect(restored.data.huntSearchHistory).toHaveLength(history);
		}

		it("scheduled backup post-operation heap stays below 400 MiB with history excluded", async () => {
			// Force GC to a clean baseline. Requires --expose-gc.
			collectGarbage();
			const baseline = process.memoryUsage().heapUsed;

			const before = process.memoryUsage();
			console.log(
				`Pre-backup heap: ${(before.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(before.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			const backup = await backupService.createBackup("heap-test", "scheduled");

			const after = process.memoryUsage();
			console.log(
				`Post-backup heap: ${(after.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(after.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			// The reporter's OOM fired at ~760 MB heap. With excludeOperational-
			// History defaulting to true for scheduled, the 5k huntLog + 2k
			// huntSearchHistory rows aren't loaded at all, so the backup
			// should complete with minimal heap delta.
			const heapDeltaMB = (after.heapUsed - baseline) / 1024 / 1024;
			console.log(`Heap delta: ${heapDeltaMB.toFixed(1)} MB`);

			// Generous threshold — the actual delta should be tiny since
			// we skip the heavy tables entirely.
			expect(after.heapUsed).toBeLessThan(400 * 1024 * 1024);
			await expectBackupHistory(backup, 0, 0);
		});

		it("manual backup including all seeded history has post-operation heap below 768 MiB", async () => {
			// The default history cap is 1,000 rows per table. Explicitly request
			// the full synthetic dataset so the memory check cannot pass by truncation.
			collectGarbage();
			const baseline = process.memoryUsage().heapUsed;

			const before = process.memoryUsage();
			console.log(
				`Pre-manual heap: ${(before.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(before.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			const backup = await backupService.createBackup("heap-test", "manual", {
				historyRetentionLimit: HUNT_LOGS,
			});

			const after = process.memoryUsage();
			console.log(
				`Post-manual heap: ${(after.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(after.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			const heapDeltaMB = (after.heapUsed - baseline) / 1024 / 1024;
			console.log(`Manual backup heap delta: ${heapDeltaMB.toFixed(1)} MB`);

			// Post-operation snapshot only; this assertion does not measure peak heap.
			expect(after.heapUsed).toBeLessThan(768 * 1024 * 1024);
			await expectBackupHistory(backup, HUNT_LOGS, HUNT_HISTORY);
		});

		it("five scheduled backups keep post-GC retained growth below 50 MiB", async () => {
			// 5 successive scheduled backups; heap should return near baseline
			// between runs (post-GC). Catches regressions where a future
			// refactor accidentally retains references to the row data.
			collectGarbage();
			const baseline = process.memoryUsage().heapUsed;

			const backups: BackupFileInfo[] = [];
			for (let i = 0; i < 5; i++) {
				backups.push(await backupService.createBackup("heap-test", "scheduled"));
				collectGarbage();
			}

			const final = process.memoryUsage().heapUsed;
			const growthMB = (final - baseline) / 1024 / 1024;
			console.log(`Heap growth after 5 backups: ${growthMB.toFixed(1)} MB`);

			// Allow up to 50 MB of growth — small drift is normal due to V8
			// internal allocations, but anything more suggests a leak.
			expect(final - baseline).toBeLessThan(50 * 1024 * 1024);
			expect(new Set(backups.map((backup) => backup.id)).size).toBe(5);
			for (const backup of backups) await expectBackupHistory(backup, 0, 0);
		});
	},
);
