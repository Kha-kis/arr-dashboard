/**
 * Integration tests for TrashCacheManager
 *
 * Tests cache operations, compression, staleness detection, and statistics.
 * Every run initializes the current schema in a disposable SQLite database.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { TrashCacheManager } from "../cache-manager.js";
import { TemplateUpdater } from "../template-updater.js";

const execFileAsync = promisify(execFile);

describe("TrashCacheManager Integration Tests", () => {
	let prisma: PrismaClient;
	let cacheManager: TrashCacheManager;
	let tempDir: string | undefined;
	let databasePath: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "trash-cache-test-"));
		databasePath = path.join(tempDir, "cache.db");
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
				`file:${databasePath}`,
			],
			{
				cwd: path.resolve(import.meta.dirname, "../../../.."),
				env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
			},
		);
	}, 120_000);

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		// Create a new Prisma client for each test
		prisma = createTestPrismaClient(databasePath);

		// Create cache manager with default options
		cacheManager = new TrashCacheManager(prisma, {
			staleAfterHours: 12,
			compressionEnabled: true,
		});
	});

	afterEach(async () => {
		// Clean up test data
		try {
			await prisma.trashCache.deleteMany({});
		} finally {
			await prisma.$disconnect();
		}
	});

	describe("Cache CRUD Operations", () => {
		it("should set and get cache data", async () => {
			const testData = [
				{ id: "test-1", name: "Test Custom Format 1" },
				{ id: "test-2", name: "Test Custom Format 2" },
			];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", testData);

			const retrieved = await cacheManager.get("RADARR", "CUSTOM_FORMATS");

			expect(retrieved).toEqual(testData);
		});

		it("should return null for non-existent cache", async () => {
			const result = await cacheManager.get("SONARR", "NAMING_PRESETS");

			expect(result).toBeNull();
		});

		it("should update existing cache entry", async () => {
			const initialData = [{ id: "1", name: "Initial" }];
			const updatedData = [
				{ id: "1", name: "Updated" },
				{ id: "2", name: "New" },
			];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", initialData);
			await cacheManager.set("RADARR", "CUSTOM_FORMATS", updatedData);

			const retrieved = await cacheManager.get("RADARR", "CUSTOM_FORMATS");

			expect(retrieved).toEqual(updatedData);
		});

		it("should increment version on cache update", async () => {
			const data = [{ id: "test" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			const status1 = await cacheManager.getStatus("RADARR", "CUSTOM_FORMATS");

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			const status2 = await cacheManager.getStatus("RADARR", "CUSTOM_FORMATS");

			expect(status2?.version).toBe((status1?.version || 0) + 1);
		});

		it("should delete cache entry", async () => {
			const data = [{ id: "test" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			const deleted = await cacheManager.delete("RADARR", "CUSTOM_FORMATS");

			expect(deleted).toBe(true);

			const retrieved = await cacheManager.get("RADARR", "CUSTOM_FORMATS");
			expect(retrieved).toBeNull();
		});

		it("should return false when deleting non-existent cache", async () => {
			const deleted = await cacheManager.delete("SONARR", "NAMING_PRESETS");

			expect(deleted).toBe(false);
		});
	});

	describe("Cache Freshness", () => {
		it("should report fresh cache as fresh", async () => {
			const data = [{ id: "test" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			const isFresh = await cacheManager.isFresh("RADARR", "CUSTOM_FORMATS");

			expect(isFresh).toBe(true);
		});

		it("should report non-existent cache as not fresh", async () => {
			const isFresh = await cacheManager.isFresh("SONARR", "NAMING_PRESETS");

			expect(isFresh).toBe(false);
		});

		it.each([true, false])(
			"reads preserve verification age with compression=%s",
			async (compressionEnabled) => {
				const manager = new TrashCacheManager(prisma, { compressionEnabled });
				const data = [{ trash_id: "cf-1", name: "Synthetic format" }];
				const provenance = {
					version: 1 as const,
					repository: "TRaSH-Guides/Guides",
					commitHash: "0123456789abcdef0123456789abcdef01234567",
				};
				await manager.setVerified("RADARR", "CUSTOM_FORMATS", data, provenance);
				await prisma.trashCache.updateMany({
					data: {
						fetchedAt: new Date("2020-01-01T00:00:00Z"),
						lastCheckedAt: new Date("2020-01-02T00:00:00Z"),
					},
				});
				const before = await prisma.trashCache.findMany();
				expect(await manager.isFresh("RADARR", "CUSTOM_FORMATS")).toBe(false);

				await expect(manager.getSnapshot("RADARR", "CUSTOM_FORMATS")).resolves.toEqual({
					data,
					commitHash: provenance.commitHash,
					provenance,
				});
				await expect(manager.get("RADARR", "CUSTOM_FORMATS")).resolves.toEqual(data);

				expect(await prisma.trashCache.findMany()).toEqual(before);
				expect(await manager.isFresh("RADARR", "CUSTOM_FORMATS")).toBe(false);
				expect(await manager.getStatus("RADARR", "CUSTOM_FORMATS")).toMatchObject({
					isStale: true,
					lastChecked: "2020-01-02T00:00:00.000Z",
				});
				expect(await manager.getStats()).toMatchObject({ staleEntries: 1 });
			},
		);

		it.each([true, false])(
			"valid cached data remains readable when updates are refused with compression=%s",
			async (compressionEnabled) => {
				const manager = new TrashCacheManager(prisma, { compressionEnabled });
				const data = [{ trash_id: "cf-1", name: "Synthetic format" }];
				await manager.set("RADARR", "CUSTOM_FORMATS", data);
				const before = await prisma.trashCache.findMany();
				await prisma.$executeRawUnsafe(`
					CREATE TRIGGER refuse_cache_updates BEFORE UPDATE ON trash_cache
					BEGIN SELECT RAISE(ABORT, 'synthetic update refusal'); END
				`);
				try {
					await expect(manager.touchCache("RADARR", "CUSTOM_FORMATS")).rejects.toThrow();
					await expect(manager.getSnapshot("RADARR", "CUSTOM_FORMATS")).resolves.toEqual({
						data,
						commitHash: null,
						provenance: null,
					});
					await expect(manager.get("RADARR", "CUSTOM_FORMATS")).resolves.toEqual(data);
					expect(await prisma.trashCache.findMany()).toEqual(before);
				} finally {
					await prisma.$executeRawUnsafe("DROP TRIGGER refuse_cache_updates");
				}
			},
		);

		it("a verified unchanged upstream commit refreshes all cache check times without refetching", async () => {
			const provenance = {
				version: 1 as const,
				repository: "TRaSH-Guides/Guides",
				commitHash: "0123456789abcdef0123456789abcdef01234567",
			};
			const configTypes = [
				"CUSTOM_FORMATS",
				"CF_GROUPS",
				"QUALITY_SIZE",
				"QUALITY_PROFILES",
				"CF_DESCRIPTIONS",
				"CONFLICTS",
			] as const;
			for (const configType of configTypes) {
				await cacheManager.setVerified("RADARR", configType, [], provenance);
			}
			const oldTime = new Date("2020-01-01T00:00:00Z");
			await prisma.trashCache.updateMany({ data: { fetchedAt: oldTime, lastCheckedAt: oldTime } });
			const before = await prisma.trashCache.findMany({ orderBy: { configType: "asc" } });
			const updater = new TemplateUpdater(
				prisma,
				{ getLatestCommit: async () => ({ commitHash: provenance.commitHash }) } as never,
				cacheManager,
				{
					getCommitProvenance: () => provenance,
					fetchConfigsAtCommit: async () => {
						throw new Error("Unexpected refetch");
					},
				} as never,
			);
			const checkStarted = Date.now();

			await expect(updater.refreshAllCaches("RADARR")).resolves.toEqual({
				refreshed: 0,
				failed: 0,
				errors: [],
				verifiedConfigTypes: [...configTypes],
				verifiedQualitySizeData: [],
			});
			const after = await prisma.trashCache.findMany({ orderBy: { configType: "asc" } });
			expect(after).toHaveLength(6);
			for (let index = 0; index < after.length; index++) {
				const { lastCheckedAt, updatedAt: _updatedAt, ...row } = after[index]!;
				const { lastCheckedAt: _oldCheck, updatedAt: _oldUpdate, ...priorRow } = before[index]!;
				expect(row).toEqual(priorRow);
				expect(lastCheckedAt.getTime()).toBeGreaterThanOrEqual(checkStarted);
			}
		});
	});

	describe("Cache Status", () => {
		it("should return cache status with correct metadata", async () => {
			const data = [
				{ id: "1", name: "Format 1" },
				{ id: "2", name: "Format 2" },
				{ id: "3", name: "Format 3" },
			];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			const status = await cacheManager.getStatus("RADARR", "CUSTOM_FORMATS");

			expect(status).toBeDefined();
			expect(status?.serviceType).toBe("RADARR");
			expect(status?.configType).toBe("CUSTOM_FORMATS");
			expect(status?.itemCount).toBe(3);
			expect(status?.version).toBe(1);
			expect(status?.isStale).toBe(false);
		});

		it("should return null status for non-existent cache", async () => {
			const status = await cacheManager.getStatus("SONARR", "NAMING_PRESETS");

			expect(status).toBeNull();
		});

		it("should get all statuses for a service", async () => {
			const data1 = [{ id: "1" }];
			const data2 = [{ id: "2" }, { id: "3" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data1);
			await cacheManager.set("RADARR", "CF_GROUPS", data2);

			const statuses = await cacheManager.getAllStatuses("RADARR");

			expect(statuses).toHaveLength(2);
			expect(statuses.map((s) => s.configType)).toContain("CUSTOM_FORMATS");
			expect(statuses.map((s) => s.configType)).toContain("CF_GROUPS");
		});
	});

	describe("Cache Statistics", () => {
		it("should return accurate cache statistics", async () => {
			const data1 = [{ id: "1" }];
			const data2 = [{ id: "2" }, { id: "3" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data1);
			await cacheManager.set("SONARR", "NAMING_PRESETS", data2);

			const stats = await cacheManager.getStats();

			expect(stats.totalEntries).toBe(2);
			expect(stats.staleEntries).toBe(0);
			expect(stats.totalSizeBytes).toBeGreaterThan(0);
			expect(stats.oldestEntry).toBeDefined();
			expect(stats.newestEntry).toBeDefined();
		});

		it("should handle empty cache statistics", async () => {
			const stats = await cacheManager.getStats();

			expect(stats.totalEntries).toBe(0);
			expect(stats.staleEntries).toBe(0);
			expect(stats.totalSizeBytes).toBe(0);
			expect(stats.oldestEntry).toBeUndefined();
			expect(stats.newestEntry).toBeUndefined();
		});
	});

	describe("Compression", () => {
		it("should compress data when compression is enabled", async () => {
			const largeData = Array.from({ length: 100 }, (_, i) => ({
				id: `item-${i}`,
				name: `Item ${i}`,
				description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			}));

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", largeData);

			// Verify data is stored correctly despite compression
			const retrieved = await cacheManager.get("RADARR", "CUSTOM_FORMATS");

			expect(retrieved).toEqual(largeData);
			expect(Array.isArray(retrieved)).toBe(true);
			expect(retrieved).toHaveLength(100);
		});

		it("should work with compression disabled", async () => {
			const uncompressedManager = new TrashCacheManager(prisma, {
				compressionEnabled: false,
			});

			const data = [{ id: "test", name: "Test" }];

			await uncompressedManager.set("RADARR", "CUSTOM_FORMATS", data);
			const retrieved = await uncompressedManager.get("RADARR", "CUSTOM_FORMATS");

			expect(retrieved).toEqual(data);
		});
	});

	describe("Service-level Operations", () => {
		it("should clear all cache for a service", async () => {
			const data = [{ id: "test" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			await cacheManager.set("RADARR", "CF_GROUPS", data);
			await cacheManager.set("SONARR", "NAMING_PRESETS", data);

			const count = await cacheManager.clearService("RADARR");

			expect(count).toBe(2);

			// Verify RADARR cache is cleared but SONARR remains
			const radarrCache = await cacheManager.get("RADARR", "CUSTOM_FORMATS");
			const sonarrCache = await cacheManager.get("SONARR", "NAMING_PRESETS");

			expect(radarrCache).toBeNull();
			expect(sonarrCache).toEqual(data);
		});

		it("should clear all cache entries", async () => {
			const data = [{ id: "test" }];

			await cacheManager.set("RADARR", "CUSTOM_FORMATS", data);
			await cacheManager.set("SONARR", "NAMING_PRESETS", data);

			const count = await cacheManager.clearAll();

			expect(count).toBe(2);

			const stats = await cacheManager.getStats();
			expect(stats.totalEntries).toBe(0);
		});
	});
});
