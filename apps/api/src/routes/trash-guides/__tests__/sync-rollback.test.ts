/**
 * Unit tests for Sync Rollback functionality
 *
 * Tests the rollback logic for TRaSH Guides sync operations including:
 * - Restoring custom formats from backup
 * - Only deleting CFs that were created by sync (not user-created ones)
 * - Handling different backup data formats
 *
 * Note: These are unit tests that don't require database access.
 * Integration tests with database are skipped unless TEST_DB=true.
 */

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Check if we should run integration tests (requires writable test database)
const RUN_DB_TESTS = process.env.TEST_DB === "true";

describe("Sync Rollback Logic Tests", () => {
	describe("Backup Data Format Parsing", () => {
		it("should handle raw array backup format (deployment-executor style)", () => {
			// deployment-executor stores backupData as a raw array of CFs
			const rawArrayBackup = JSON.stringify([
				{ id: 1, name: "Test CF 1", specifications: [] },
				{ id: 2, name: "Test CF 2", specifications: [] },
			]);

			const parsed = JSON.parse(rawArrayBackup);
			const backupCFs = Array.isArray(parsed) ? parsed : (parsed.customFormats ?? []);

			expect(backupCFs).toHaveLength(2);
			expect(backupCFs[0].name).toBe("Test CF 1");
		});

		it("should handle object with customFormats backup format (backup-manager style)", () => {
			// backup-manager stores backupData as { customFormats: [...], qualityProfiles: [...] }
			const objectBackup = JSON.stringify({
				customFormats: [
					{ id: 1, name: "Test CF 1", specifications: [] },
					{ id: 2, name: "Test CF 2", specifications: [] },
				],
				qualityProfiles: [],
			});

			const parsed = JSON.parse(objectBackup);
			const backupCFs = Array.isArray(parsed) ? parsed : (parsed.customFormats ?? []);

			expect(backupCFs).toHaveLength(2);
			expect(backupCFs[0].name).toBe("Test CF 1");
		});

		it("should handle empty backup gracefully", () => {
			const emptyBackup = JSON.stringify([]);

			const parsed = JSON.parse(emptyBackup);
			const backupCFs = Array.isArray(parsed) ? parsed : (parsed.customFormats ?? []);

			expect(backupCFs).toHaveLength(0);
		});

		it("should handle missing customFormats in object format", () => {
			const objectBackup = JSON.stringify({
				qualityProfiles: [],
				// customFormats is missing
			});

			const parsed = JSON.parse(objectBackup);
			const backupCFs = Array.isArray(parsed) ? parsed : (parsed.customFormats ?? []);

			expect(backupCFs).toHaveLength(0);
		});
	});

	describe("Applied Configs Parsing", () => {
		it("should identify CFs created by sync", () => {
			const appliedConfigs = JSON.stringify([
				{ name: "Created CF 1", action: "created" },
				{ name: "Updated CF 1", action: "updated" },
				{ name: "Created CF 2", action: "created" },
			]);

			const parsed = JSON.parse(appliedConfigs);
			const createdBySyncNames = new Set<string>();

			for (const config of parsed) {
				if (config.action === "created" || !config.action) {
					createdBySyncNames.add(config.name);
				}
			}

			expect(createdBySyncNames.has("Created CF 1")).toBe(true);
			expect(createdBySyncNames.has("Created CF 2")).toBe(true);
			expect(createdBySyncNames.has("Updated CF 1")).toBe(false);
		});

		it("should handle legacy format without action field", () => {
			// Legacy format: just { name } without action field
			const appliedConfigs = JSON.stringify([{ name: "Legacy CF 1" }, { name: "Legacy CF 2" }]);

			const parsed = JSON.parse(appliedConfigs);
			const createdBySyncNames = new Set<string>();

			for (const config of parsed) {
				// Legacy: assume created if no action field
				if (config.action === "created" || !config.action) {
					createdBySyncNames.add(config.name);
				}
			}

			expect(createdBySyncNames.has("Legacy CF 1")).toBe(true);
			expect(createdBySyncNames.has("Legacy CF 2")).toBe(true);
		});
	});

	describe("Rollback CF Identification", () => {
		it("should not delete CFs that existed in backup", () => {
			// CFs in backup
			const backupCFs = [{ name: "Existing CF 1" }, { name: "Existing CF 2" }];

			// CFs marked as created by sync
			const createdBySyncNames = new Set(["Existing CF 1", "New CF 1"]);

			// Cross-reference: if a CF was "created" but exists in backup, it was actually updated
			const backupNames = new Set(backupCFs.map((cf) => cf.name));
			for (const name of createdBySyncNames) {
				if (backupNames.has(name)) {
					createdBySyncNames.delete(name);
				}
			}

			// Only "New CF 1" should remain as truly created
			expect(createdBySyncNames.has("Existing CF 1")).toBe(false);
			expect(createdBySyncNames.has("New CF 1")).toBe(true);
		});

		it("should preserve user-created CFs during rollback", () => {
			// Current CFs in instance
			const currentCFs = [
				{ id: 1, name: "Backup CF 1" }, // Was in backup - should be restored
				{ id: 2, name: "Sync Created CF" }, // Created by sync - should be deleted
				{ id: 3, name: "User Created CF" }, // Created by user - should NOT be deleted
			];

			// CFs in backup
			const backupCFs = [{ name: "Backup CF 1" }];

			// CFs created by sync
			const createdBySyncNames = new Set(["Sync Created CF"]);

			// Determine what to delete
			const backupNames = new Set(backupCFs.map((cf) => cf.name));
			const toDelete: string[] = [];

			for (const cf of currentCFs) {
				// Only delete if: not in backup AND was created by sync
				if (!backupNames.has(cf.name) && createdBySyncNames.has(cf.name)) {
					toDelete.push(cf.name);
				}
			}

			expect(toDelete).toContain("Sync Created CF");
			expect(toDelete).not.toContain("User Created CF");
			expect(toDelete).not.toContain("Backup CF 1");
		});
	});

	// Database integration tests - only run with TEST_DB=true
	(RUN_DB_TESTS ? describe : describe.skip)("Rollback State Management (Integration)", () => {
		let prisma: PrismaClient;

		beforeEach(() => {
			prisma = new PrismaClient();
		});

		afterEach(async () => {
			await prisma.$disconnect();
		});

		it("should create sync history record with correct structure", async () => {
			// Create test user
			const user = await prisma.user.upsert({
				where: { id: "test-user-rollback" },
				update: {},
				create: {
					id: "test-user-rollback",
					username: "testuser",
				},
			});

			// Create test instance
			const instance = await prisma.serviceInstance.upsert({
				where: { id: "test-instance-rollback" },
				update: {},
				create: {
					id: "test-instance-rollback",
					userId: user.id,
					label: "Test Instance",
					service: "RADARR",
					baseUrl: "http://localhost:7878",
					encryptedApiKey: "encrypted-key",
					encryptionIv: "iv",
				},
			});

			// Create a backup
			const backup = await prisma.trashBackup.create({
				data: {
					instanceId: instance.id,
					userId: user.id,
					backupData: JSON.stringify([{ id: 1, name: "Test CF" }]),
				},
			});

			// Create sync history
			const syncHistory = await prisma.trashSyncHistory.create({
				data: {
					instanceId: instance.id,
					userId: user.id,
					syncType: "CUSTOM_FORMATS",
					status: "SUCCESS",
					appliedConfigs: JSON.stringify([{ name: "Test CF", action: "created" }]),
					backupId: backup.id,
				},
			});

			expect(syncHistory.id).toBeDefined();
			expect(syncHistory.backupId).toBe(backup.id);
			expect(syncHistory.rolledBack).toBe(false);

			// Clean up
			await prisma.trashSyncHistory.delete({ where: { id: syncHistory.id } });
			await prisma.trashBackup.delete({ where: { id: backup.id } });
			await prisma.serviceInstance.delete({ where: { id: instance.id } });
			await prisma.user.delete({ where: { id: user.id } });
		});

		it("should mark sync as rolled back after successful rollback", async () => {
			// Create test user
			const user = await prisma.user.upsert({
				where: { id: "test-user-rollback-2" },
				update: {},
				create: {
					id: "test-user-rollback-2",
					username: "testuser2",
				},
			});

			// Create test instance
			const instance = await prisma.serviceInstance.upsert({
				where: { id: "test-instance-rollback-2" },
				update: {},
				create: {
					id: "test-instance-rollback-2",
					userId: user.id,
					label: "Test Instance 2",
					service: "RADARR",
					baseUrl: "http://localhost:7878",
					encryptedApiKey: "encrypted-key",
					encryptionIv: "iv",
				},
			});

			// Create a backup
			const backup = await prisma.trashBackup.create({
				data: {
					instanceId: instance.id,
					userId: user.id,
					backupData: JSON.stringify([]),
				},
			});

			// Create sync history
			const syncHistory = await prisma.trashSyncHistory.create({
				data: {
					instanceId: instance.id,
					userId: user.id,
					syncType: "CUSTOM_FORMATS",
					status: "SUCCESS",
					appliedConfigs: JSON.stringify([]),
					backupId: backup.id,
				},
			});

			// Simulate rollback completion
			const updated = await prisma.trashSyncHistory.update({
				where: { id: syncHistory.id },
				data: {
					rolledBack: true,
					rolledBackAt: new Date(),
				},
			});

			expect(updated.rolledBack).toBe(true);
			expect(updated.rolledBackAt).toBeInstanceOf(Date);

			// Clean up
			await prisma.trashSyncHistory.delete({ where: { id: syncHistory.id } });
			await prisma.trashBackup.delete({ where: { id: backup.id } });
			await prisma.serviceInstance.delete({ where: { id: instance.id } });
			await prisma.user.delete({ where: { id: user.id } });
		});
	});

	describe("Error Handling", () => {
		it("should handle invalid JSON in backup data gracefully", () => {
			const invalidJson = "not valid json {{{";

			expect(() => JSON.parse(invalidJson)).toThrow();
		});

		it("should handle null appliedConfigs", () => {
			const appliedConfigs = null;

			let parsed: Array<{ name: string; action?: string }> = [];
			try {
				if (appliedConfigs) {
					parsed = JSON.parse(appliedConfigs);
				}
			} catch {
				// If parsing fails, skip deletion step for safety
			}

			expect(parsed).toHaveLength(0);
		});
	});
});
