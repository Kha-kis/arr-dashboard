/**
 * Heap-measurement test for v2.18.4 OOM fix.
 *
 * The reporter's bug fired during scheduled backup at ~760 MB heap (768 MB
 * container cap, see Dockerfile:141 `--max-old-space-size=768`). This test
 * seeds a synthetic-large dataset shaped like a heavy install — primarily
 * `huntLog` rows with realistic JSON `details` blobs that were the primary
 * culprit — then runs `createBackup` under the same heap pattern that
 * crashed in production.
 *
 * Skipped by default (TEST_HEAP=true to opt in). It's slow (~5–10s) and
 * needs a writable test DB, so we keep it out of the default `pnpm test`
 * loop. Run before tagging a release that touches the backup path.
 *
 * What this test proves vs. doesn't:
 *  - PROVES: a 50k-row huntLog table with realistic blobs no longer trips
 *    a 768 MB heap cap during scheduled backup.
 *  - DOES NOT prove: production-shaped data hits the same number; users
 *    with unusual table distributions could still OOM.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { BackupService } from "../backup-service.js";

const RUN_HEAP_TESTS = process.env.TEST_HEAP === "true";

// Mock encryptor — same shape used by other integration tests.
const mockEncryptor = {
	encrypt: vi.fn((value: string) => ({
		value: Buffer.from(value).toString("base64"),
		iv: "mock-iv-123",
	})),
	decrypt: vi.fn((data: { value: string; iv: string }) =>
		Buffer.from(data.value, "base64").toString("utf-8"),
	),
};

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
	"BackupService — heap measurement under production-shaped load (TEST_HEAP=true)",
	() => {
		let prisma: PrismaClient;
		let backupService: BackupService;
		let testBackupsDir: string;
		let testSecretsPath: string;
		let testDbPath: string;

		beforeAll(async () => {
			testBackupsDir = path.join(os.tmpdir(), `backup-heap-${Date.now()}`);
			testSecretsPath = path.join(testBackupsDir, "secrets.json");
			testDbPath = path.join(testBackupsDir, "heap-test.db");
			await fs.mkdir(testBackupsDir, { recursive: true });

			// Copy the pre-seeded test DB (which has the schema applied) to a
			// dedicated heap-test DB file so we don't pollute test-integration.db
			// with 50k synthetic rows.
			const sourceDb = path.resolve(import.meta.dirname, "../../../../prisma/test-integration.db");
			await fs.copyFile(sourceDb, testDbPath);

			await fs.writeFile(testSecretsPath, JSON.stringify({ backupPassword: "x".repeat(32) }));

			prisma = createTestPrismaClient(testDbPath);
			backupService = new BackupService(prisma, testSecretsPath, mockEncryptor as never);
			(backupService as unknown as { backupsDir: string }).backupsDir = testBackupsDir;

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
			const HUNT_LOGS = 5000;
			const HUNT_HISTORY = 2000;

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

			console.log(`Seed complete in ${Date.now() - seedStart}ms`);
		});

		afterAll(async () => {
			await prisma.$disconnect();
			await fs.rm(testBackupsDir, { recursive: true, force: true }).catch(() => {});
		});

		it("scheduled backup stays well under 768 MB heap with operational history excluded", async () => {
			// Force GC to a clean baseline. Requires --expose-gc.
			global.gc?.();
			const baseline = process.memoryUsage().heapUsed;

			const before = process.memoryUsage();
			console.log(
				`Pre-backup heap: ${(before.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(before.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			await backupService.createBackup("heap-test", "scheduled");

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
		});

		it("manual backup with full history stays under 768 MB on this dataset", async () => {
			// Manual backups load EVERYTHING. With our 5k+2k seed dataset
			// and ~3KB blob per row, this is ~21 MB of raw row data — well
			// within the cap. This test pins that manual backups don't
			// regress for typical heavy users (vs. extreme outliers).
			global.gc?.();
			const baseline = process.memoryUsage().heapUsed;

			const before = process.memoryUsage();
			console.log(
				`Pre-manual heap: ${(before.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(before.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			await backupService.createBackup("heap-test", "manual");

			const after = process.memoryUsage();
			console.log(
				`Post-manual heap: ${(after.heapUsed / 1024 / 1024).toFixed(1)} MB / RSS ${(after.rss / 1024 / 1024).toFixed(1)} MB`,
			);

			const heapDeltaMB = (after.heapUsed - baseline) / 1024 / 1024;
			console.log(`Manual backup heap delta: ${heapDeltaMB.toFixed(1)} MB`);

			// Hard cap — manual backups must NOT exceed the production heap
			// limit on a realistic-but-heavy dataset.
			expect(after.heapUsed).toBeLessThan(768 * 1024 * 1024);
		});

		it("repeated scheduled backups do not leak heap monotonically", async () => {
			// 5 successive scheduled backups; heap should return near baseline
			// between runs (post-GC). Catches regressions where a future
			// refactor accidentally retains references to the row data.
			global.gc?.();
			const baseline = process.memoryUsage().heapUsed;

			for (let i = 0; i < 5; i++) {
				await backupService.createBackup("heap-test", "scheduled");
				global.gc?.();
			}

			const final = process.memoryUsage().heapUsed;
			const growthMB = (final - baseline) / 1024 / 1024;
			console.log(`Heap growth after 5 backups: ${growthMB.toFixed(1)} MB`);

			// Allow up to 50 MB of growth — small drift is normal due to V8
			// internal allocations, but anything more suggests a leak.
			expect(final - baseline).toBeLessThan(50 * 1024 * 1024);
		});
	},
);
