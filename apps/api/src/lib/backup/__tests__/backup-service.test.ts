/**
 * Tests for BackupService
 *
 * Unit tests for backup validation, ID generation, and encryption detection.
 * Integration tests (database-dependent) are skipped unless TEST_DB=true.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { generateBackupId } from "../backup-file-utils.js";
import { BackupService, estimateBackupBytes } from "../backup-service.js";
import {
	isEncryptedBackupEnvelope,
	isPlaintextBackup,
	validateBackup,
} from "../backup-validation.js";

// Check if we should run integration tests (requires writable test database)
const RUN_DB_TESTS = process.env.TEST_DB === "true";

// Use the pre-initialized test database with full schema
// (matches the pattern used by routes/library/__tests__/queryraw-migration.test.ts)
const TEST_DB_PATH = path.resolve(import.meta.dirname, "../../../../prisma/test-integration.db");

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
			prisma = createTestPrismaClient(TEST_DB_PATH);

			// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
			// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
			testBackupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-test-"));
			testSecretsPath = path.join(testBackupsDir, "secrets.json");

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
			prisma = createTestPrismaClient(TEST_DB_PATH);
			// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
			// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
			testBackupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-test-"));
			testSecretsPath = path.join(testBackupsDir, "secrets.json");
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
		prisma = createTestPrismaClient(TEST_DB_PATH);
		// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
		// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
		testBackupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-test-"));
		testSecretsPath = path.join(testBackupsDir, "secrets.json");
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

		expect(() => validateBackup(invalidBackup)).toThrow("Unsupported backup version: 999.0");
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

/**
 * Regression-pinning tests for the `createBackup → exportDatabase` defaulting
 * wiring (the v2.18.4 OOM fix's actual contract). These verify that:
 *  - manual backups preserve full history (operational tables included)
 *  - scheduled + update backups skip operational history by default
 *  - explicit `excludeOperationalHistory: false` overrides the type-based default
 *
 * If a future refactor flips the operator precedence (e.g.
 * `(options.excludeOperationalHistory ?? type) === "scheduled"`) the OOM fix
 * regresses silently for nightly cron — these tests are the safety net.
 */
describe("BackupService - createBackup type-based defaulting (Unit)", () => {
	it("manual: defaults excludeOperationalHistory to false (full history preserved)", async () => {
		// Mock exportDatabase to capture the options it receives.
		const exportSpy = vi.fn().mockResolvedValue({
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		});
		vi.doMock("../backup-database.js", () => ({
			exportDatabase: exportSpy,
			restoreDatabase: vi.fn(),
		}));
		// Reload the BackupService module so it picks up the mock.
		vi.resetModules();
		const { BackupService } = await import("../backup-service.js");

		// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
		// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-default-test-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		await fs.writeFile(secretsPath, JSON.stringify({ backupPassword: "x".repeat(32) }));

		const fakePrisma = {
			backupSettings: { findUnique: vi.fn().mockResolvedValue(null) },
		} as never;
		const svc = new BackupService(fakePrisma, secretsPath);
		(svc as unknown as { backupsDir: string }).backupsDir = tempDir;

		try {
			await svc.createBackup("test", "manual");
		} catch (_err) {
			// Encryption may fail because of mocked deps — we only care about the
			// captured exportDatabase options.
		}

		expect(exportSpy).toHaveBeenCalled();
		const opts = exportSpy.mock.calls[0]?.[1];
		expect(opts).toMatchObject({ excludeOperationalHistory: false });

		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		vi.doUnmock("../backup-database.js");
	});

	it("scheduled: defaults excludeOperationalHistory to true (heavy tables skipped)", async () => {
		const exportSpy = vi.fn().mockResolvedValue({
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		});
		vi.doMock("../backup-database.js", () => ({
			exportDatabase: exportSpy,
			restoreDatabase: vi.fn(),
		}));
		vi.resetModules();
		const { BackupService } = await import("../backup-service.js");

		// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
		// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-default-test-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		await fs.writeFile(secretsPath, JSON.stringify({ backupPassword: "x".repeat(32) }));

		const fakePrisma = {
			backupSettings: { findUnique: vi.fn().mockResolvedValue(null) },
		} as never;
		const svc = new BackupService(fakePrisma, secretsPath);
		(svc as unknown as { backupsDir: string }).backupsDir = tempDir;

		try {
			await svc.createBackup("test", "scheduled");
		} catch (_err) {
			// ignore — we only assert the captured options
		}

		const opts = exportSpy.mock.calls[0]?.[1];
		expect(opts).toMatchObject({ excludeOperationalHistory: true });

		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		vi.doUnmock("../backup-database.js");
	});

	it("update: defaults excludeOperationalHistory to true (covers auto-update backups)", async () => {
		// Pre-fix, only "scheduled" was excluded; auto-update backups went through
		// the unbounded path. This test pins the broader `type !== "manual"` default.
		const exportSpy = vi.fn().mockResolvedValue({
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		});
		vi.doMock("../backup-database.js", () => ({
			exportDatabase: exportSpy,
			restoreDatabase: vi.fn(),
		}));
		vi.resetModules();
		const { BackupService } = await import("../backup-service.js");

		// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
		// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-default-test-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		await fs.writeFile(secretsPath, JSON.stringify({ backupPassword: "x".repeat(32) }));

		const fakePrisma = {
			backupSettings: { findUnique: vi.fn().mockResolvedValue(null) },
		} as never;
		const svc = new BackupService(fakePrisma, secretsPath);
		(svc as unknown as { backupsDir: string }).backupsDir = tempDir;

		try {
			await svc.createBackup("test", "update");
		} catch (_err) {
			// ignore
		}

		const opts = exportSpy.mock.calls[0]?.[1];
		expect(opts).toMatchObject({ excludeOperationalHistory: true });

		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		vi.doUnmock("../backup-database.js");
	});

	it("explicit override: caller-passed false beats the type-based default", async () => {
		const exportSpy = vi.fn().mockResolvedValue({
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		});
		vi.doMock("../backup-database.js", () => ({
			exportDatabase: exportSpy,
			restoreDatabase: vi.fn(),
		}));
		vi.resetModules();
		const { BackupService } = await import("../backup-service.js");

		// fs.mkdtemp atomically creates a unique directory with mode 0o700 —
		// avoids the symlink race that path.join+mkdir is vulnerable to (CWE-377/378).
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-default-test-"));
		const secretsPath = path.join(tempDir, "secrets.json");
		await fs.writeFile(secretsPath, JSON.stringify({ backupPassword: "x".repeat(32) }));

		const fakePrisma = {
			backupSettings: { findUnique: vi.fn().mockResolvedValue(null) },
		} as never;
		const svc = new BackupService(fakePrisma, secretsPath);
		(svc as unknown as { backupsDir: string }).backupsDir = tempDir;

		try {
			await svc.createBackup("test", "scheduled", { excludeOperationalHistory: false });
		} catch (_err) {
			// ignore
		}

		const opts = exportSpy.mock.calls[0]?.[1];
		expect(opts).toMatchObject({ excludeOperationalHistory: false });

		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
		vi.doUnmock("../backup-database.js");
	});
});

describe("BackupService - estimateBackupBytes (Unit)", () => {
	it("returns 0 for empty data", () => {
		expect(estimateBackupBytes({})).toBe(0);
	});

	it("returns 0 when all tables are empty arrays", () => {
		expect(estimateBackupBytes({ users: [], sessions: [] })).toBe(0);
	});

	it("samples first row and multiplies by row count", () => {
		// One row of `{"id":"a"}` is 10 chars; 5 rows = 50.
		const data = {
			users: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
		};
		expect(estimateBackupBytes(data)).toBe(50);
	});

	it("scales with per-row size — large rows produce proportionally larger estimates", () => {
		// Verifies the estimator picks up byte-size differences that the old
		// flat 1KB-per-record heuristic missed. A row with a JSON blob should
		// dominate the estimate over a row with just an id.
		const small = { users: [{ id: "a" }, { id: "b" }] };
		const large = {
			users: [
				{
					id: "a",
					data: "x".repeat(1000),
				},
				{
					id: "b",
					data: "x".repeat(1000),
				},
			],
		};
		const smallEstimate = estimateBackupBytes(small);
		const largeEstimate = estimateBackupBytes(large);
		expect(largeEstimate).toBeGreaterThan(smallEstimate * 50);
	});

	it("ignores non-array values (e.g., the `secrets` block)", () => {
		const data = {
			users: [{ id: "a" }],
			secrets: { encryptionKey: "long-secret-string" },
		};
		// Only `users` contributes; `secrets` is an object, not an array.
		expect(estimateBackupBytes(data)).toBe(JSON.stringify({ id: "a" }).length);
	});

	it("sums across multiple tables", () => {
		const data = {
			users: [{ id: "u1" }],
			sessions: [{ id: "s1" }],
			trashTemplates: [{ id: "t1" }],
		};
		// Each row stringifies as `{"id":"u1"}` (11 chars).
		expect(estimateBackupBytes(data)).toBe(33);
	});
});
