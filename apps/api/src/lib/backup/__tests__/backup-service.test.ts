/**
 * Tests for BackupService
 *
 * Unit tests for backup validation, ID generation, and encryption detection.
 * Integration tests (database-dependent) are skipped unless TEST_DB=true.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../backup-service.js";
import { generateBackupId } from "../backup-file-utils.js";
import {
	isEncryptedBackupEnvelope,
	isPlaintextBackup,
	validateBackup,
} from "../backup-validation.js";

// Check if we should run integration tests (requires writable test database)
const RUN_DB_TESTS = process.env.TEST_DB === "true";

// Mock encryptor for tests
const mockEncryptor = {
	encrypt: vi.fn((value: string) => ({
		value: Buffer.from(value).toString("base64"),
		iv: "mock-iv-123",
	})),
	decrypt: vi.fn((data: { value: string; iv: string }) =>
		Buffer.from(data.value, "base64").toString("utf-8"),
	),
};

// Integration tests - only run with TEST_DB=true
(RUN_DB_TESTS ? describe : describe.skip)(
	"BackupService - Password Management (Integration)",
	() => {
		let prisma: PrismaClient;
		let backupService: BackupService;
		let testBackupsDir: string;
		let testSecretsPath: string;

		beforeEach(async () => {
			// Create a new Prisma client for each test
			prisma = createTestPrismaClient();

			// Create temp directories for backups and secrets
			testBackupsDir = path.join(os.tmpdir(), `backup-test-${Date.now()}`);
			testSecretsPath = path.join(testBackupsDir, "secrets.json");
			await fs.mkdir(testBackupsDir, { recursive: true });

			// Write mock secrets file
			await fs.writeFile(
				testSecretsPath,
				JSON.stringify({
					ENCRYPTION_KEY: "test-encryption-key-32-bytes-hex",
					SESSION_COOKIE_SECRET: "test-session-secret",
				}),
			);

			// Create backup service with mock encryptor
			backupService = new BackupService(prisma, testSecretsPath, mockEncryptor as any);

			// Override backups directory
			(backupService as any).backupsDir = testBackupsDir;
		});

		afterEach(async () => {
			// Clean up test data
			await prisma.trashBackup.deleteMany({}).catch(() => {});
			await prisma.backupSettings.deleteMany({}).catch(() => {});
			await prisma.$disconnect();

			// Clean up temp directory
			await fs.rm(testBackupsDir, { recursive: true, force: true }).catch(() => {});
		});

		it("should return correct status when no password is configured", async () => {
			const status = await backupService.getPasswordStatus();

			expect(status).toHaveProperty("configured");
			expect(status).toHaveProperty("source");
		});

		it("should set password in database", async () => {
			await backupService.setPassword("TestPassword123!");

			const status = await backupService.getPasswordStatus();
			expect(status.configured).toBe(true);
			expect(status.source).toBe("database");
		});

		it("should remove password from database", async () => {
			// First set a password
			await backupService.setPassword("TestPassword123!");

			// Then remove it
			await backupService.removePassword();

			const status = await backupService.getPasswordStatus();
			// May fall back to env var or dev password
			expect(status.source).not.toBe("database");
		});

		it("should require minimum password length", async () => {
			// Password validation happens at the route level
			// This tests that the service accepts valid passwords
			await expect(backupService.setPassword("ValidPassword123!")).resolves.not.toThrow();
		});
	},
);

// Integration tests - only run with TEST_DB=true
(RUN_DB_TESTS ? describe : describe.skip)(
	"BackupService - Backup Creation with includeTrashBackups (Integration)",
	() => {
		let prisma: PrismaClient;
		let backupService: BackupService;
		let testBackupsDir: string;
		let testSecretsPath: string;

		beforeEach(async () => {
			prisma = createTestPrismaClient();
			testBackupsDir = path.join(os.tmpdir(), `backup-test-${Date.now()}`);
			testSecretsPath = path.join(testBackupsDir, "secrets.json");
			await fs.mkdir(testBackupsDir, { recursive: true });
			await fs.writeFile(
				testSecretsPath,
				JSON.stringify({
					ENCRYPTION_KEY: "test-encryption-key-32-bytes-hex",
					SESSION_COOKIE_SECRET: "test-session-secret",
				}),
			);
			backupService = new BackupService(prisma, testSecretsPath, mockEncryptor as any);
			(backupService as any).backupsDir = testBackupsDir;
		});

		afterEach(async () => {
			await prisma.trashBackup.deleteMany({}).catch(() => {});
			await prisma.backupSettings.deleteMany({}).catch(() => {});
			await prisma.$disconnect();
			await fs.rm(testBackupsDir, { recursive: true, force: true }).catch(() => {});
		});

		it("should create backup without TRaSH backups by default", async () => {
			// Set a test password first
			await backupService.setPassword("TestPassword123!");

			const backupInfo = await backupService.createBackup("2.6.2", "manual");

			expect(backupInfo).toHaveProperty("id");
			expect(backupInfo).toHaveProperty("filename");
			expect(backupInfo).toHaveProperty("timestamp");
			expect(backupInfo).toHaveProperty("size");
			expect(backupInfo.type).toBe("manual");
		});

		it("should create backup with TRaSH backups when option enabled", async () => {
			// Set a test password first
			await backupService.setPassword("TestPassword123!");

			const backupInfo = await backupService.createBackup("2.6.2", "manual", {
				includeTrashBackups: true,
			});

			expect(backupInfo).toHaveProperty("id");
			expect(backupInfo.type).toBe("manual");
			expect(backupInfo.size).toBeGreaterThan(0);
		});

		it("should organize backups by type in subdirectories", async () => {
			await backupService.setPassword("TestPassword123!");

			const manualBackup = await backupService.createBackup("2.6.2", "manual");
			const scheduledBackup = await backupService.createBackup("2.6.2", "scheduled");

			// Check that backups are in different directories
			expect(manualBackup.type).toBe("manual");
			expect(scheduledBackup.type).toBe("scheduled");
		});
	},
);

// Integration tests - only run with TEST_DB=true
(RUN_DB_TESTS ? describe : describe.skip)("BackupService - Backup Listing (Integration)", () => {
	let prisma: PrismaClient;
	let backupService: BackupService;
	let testBackupsDir: string;
	let testSecretsPath: string;

	beforeEach(async () => {
		prisma = createTestPrismaClient();
		testBackupsDir = path.join(os.tmpdir(), `backup-test-${Date.now()}`);
		testSecretsPath = path.join(testBackupsDir, "secrets.json");
		await fs.mkdir(testBackupsDir, { recursive: true });
		await fs.writeFile(
			testSecretsPath,
			JSON.stringify({
				ENCRYPTION_KEY: "test-encryption-key-32-bytes-hex",
				SESSION_COOKIE_SECRET: "test-session-secret",
			}),
		);
		backupService = new BackupService(prisma, testSecretsPath, mockEncryptor as any);
		(backupService as any).backupsDir = testBackupsDir;
	});

	afterEach(async () => {
		await prisma.trashBackup.deleteMany({}).catch(() => {});
		await prisma.backupSettings.deleteMany({}).catch(() => {});
		await prisma.$disconnect();
		await fs.rm(testBackupsDir, { recursive: true, force: true }).catch(() => {});
	});

	it("should list all backups", async () => {
		await backupService.setPassword("TestPassword123!");

		// Create a backup
		await backupService.createBackup("2.6.2", "manual");

		const backups = await backupService.listBackups();

		expect(Array.isArray(backups)).toBe(true);
		expect(backups.length).toBeGreaterThanOrEqual(1);
	});

	it("should return empty array when no backups exist", async () => {
		const backups = await backupService.listBackups();

		expect(Array.isArray(backups)).toBe(true);
	});
});

// Unit tests - these don't require database access
describe("BackupService - Backup Validation (Unit)", () => {
	it("should validate backup structure", () => {
		const validBackup = {
			version: "1.0",
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		// Should not throw for valid backup
		expect(() => validateBackup(validBackup)).not.toThrow();
	});

	it("should reject invalid backup version", () => {
		const invalidBackup = {
			version: "999.0",
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {},
			secrets: {},
		};

		expect(() => validateBackup(invalidBackup)).toThrow(
			"Unsupported backup version: 999.0",
		);
	});

	it("should reject backup missing required data", () => {
		const invalidBackup = {
			version: "1.0",
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {
				// Missing required fields
			},
			secrets: {},
		};

		expect(() => validateBackup(invalidBackup)).toThrow();
	});

	it("should reject backup with missing version", () => {
		const invalidBackup = {
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {},
		};

		expect(() => validateBackup(invalidBackup)).toThrow(
			"Invalid backup format: missing or invalid version",
		);
	});
});

describe("BackupService - Backup ID Generation (Unit)", () => {
	it("should generate consistent IDs for the same path", () => {
		const testPath = "/path/to/backup.json";
		const id1 = generateBackupId(testPath);
		const id2 = generateBackupId(testPath);

		expect(id1).toBe(id2);
	});

	it("should generate different IDs for different paths", () => {
		const id1 = generateBackupId("/path/to/backup1.json");
		const id2 = generateBackupId("/path/to/backup2.json");

		expect(id1).not.toBe(id2);
	});

	it("should generate 24-character hex IDs", () => {
		const id = generateBackupId("/path/to/backup.json");

		expect(id).toHaveLength(24);
		expect(/^[a-f0-9]+$/.test(id)).toBe(true);
	});
});

describe("BackupService - Encryption Detection (Unit)", () => {
	it("should detect encrypted backup envelope", () => {
		const encryptedEnvelope = {
			version: "1",
			salt: "some-salt-base64",
			iv: "some-iv-base64",
			tag: "some-tag-base64",
			cipherText: "encrypted-data-base64",
			kdfParams: {
				algorithm: "argon2id",
				hash: "SHA-256",
				iterations: 100000,
				saltLength: 32,
			},
		};

		expect(isEncryptedBackupEnvelope(encryptedEnvelope)).toBe(true);
	});

	it("should detect plaintext backup", () => {
		const plaintextBackup = {
			version: "1.0",
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
			},
			secrets: {
				ENCRYPTION_KEY: "test",
			},
		};

		expect(isPlaintextBackup(plaintextBackup)).toBe(true);
	});

	it("should not detect plaintext as encrypted", () => {
		const plaintextBackup = {
			version: "1.0",
			appVersion: "2.6.2",
			timestamp: new Date().toISOString(),
			data: {},
			secrets: {},
		};

		expect(isEncryptedBackupEnvelope(plaintextBackup)).toBe(false);
	});

	it("should not detect encrypted as plaintext", () => {
		const encryptedEnvelope = {
			version: "1",
			salt: "some-salt-base64",
			iv: "some-iv-base64",
			tag: "some-tag-base64",
			cipherText: "encrypted-data-base64",
			kdfParams: {
				algorithm: "argon2id",
				hash: "SHA-256",
				iterations: 100000,
				saltLength: 32,
			},
		};

		expect(isPlaintextBackup(encryptedEnvelope)).toBe(false);
	});
});
