/**
 * Tests for BackupService
 *
 * Unit tests cover validation, ID generation, and encryption detection.
 * Integration tests use a fresh full-schema SQLite database per case.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../../lib/auth/encryption.js";
import type { PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	decryptBackupData,
	encryptBackupData,
	type EncryptedBackupEnvelope,
} from "../backup-crypto.js";
import { generateBackupId } from "../backup-file-utils.js";
import {
	assertPreparedRestoreData,
	RestorePreparationError,
} from "../backup-restore-preparation.js";
import {
	BackupPasswordConfigurationError,
	BackupService,
	estimateBackupBytes,
} from "../backup-service.js";
import {
	isEncryptedBackupEnvelope,
	isPlaintextBackup,
	validateBackup,
} from "../backup-validation.js";

const execFileAsync = promisify(execFile);
const TEST_PASSWORD = "TestPassword123!";
const TEST_SECRETS = {
	encryptionKey: "a".repeat(64),
	sessionCookieSecret: "synthetic-session-secret".repeat(2),
};

describe("BackupService database integration", () => {
	let templateDir: string | undefined;
	let templatePath: string;
	let testDir: string | undefined;
	let testSecretsPath: string;
	let prisma: PrismaClient | undefined;
	let backupService: BackupService;
	const encryptor = new Encryptor(TEST_SECRETS.encryptionKey);

	beforeAll(async () => {
		templateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-service-schema-"));
		templatePath = path.join(templateDir, "template.db");
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
				`file:${templatePath}`,
			],
			{
				cwd: path.resolve(import.meta.dirname, "../../../.."),
				env: { ...process.env, DATABASE_URL: `file:${templatePath}` },
			},
		);
	}, 120_000);

	afterAll(async () => {
		if (templateDir) await fs.rm(templateDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BACKUP_PASSWORD", "");
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-service-case-"));
		const databasePath = path.join(testDir, "case.db");
		await fs.copyFile(templatePath, databasePath);
		prisma = createTestPrismaClient(databasePath);
		testSecretsPath = path.join(testDir, "secrets.json");
		await fs.writeFile(testSecretsPath, JSON.stringify(TEST_SECRETS), { mode: 0o600 });
		backupService = new BackupService(prisma, testSecretsPath, encryptor);
		await prisma.user.create({
			data: {
				id: "backup-test-owner",
				username: "synthetic-backup-user",
				hashedPassword: "synthetic-hash",
			},
		});
		const apiKey = encryptor.encrypt("synthetic-api-key");
		await prisma.serviceInstance.create({
			data: {
				id: "backup-test-instance",
				userId: "backup-test-owner",
				service: "RADARR",
				label: "Synthetic instance",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: apiKey.value,
				encryptionIv: apiKey.iv,
			},
		});
		await prisma.trashBackup.create({
			data: {
				id: "backup-test-snapshot",
				userId: "backup-test-owner",
				instanceId: "backup-test-instance",
				backupData: '{"synthetic":true}',
			},
		});
	});

	afterEach(async () => {
		try {
			await prisma?.$disconnect();
		} finally {
			prisma = undefined;
			try {
				if (testDir) await fs.rm(testDir, { recursive: true, force: true });
			} finally {
				testDir = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	async function readBackup(id: string) {
		const info = await backupService.getBackupByIdInternal(id);
		if (!info) throw new Error("Synthetic backup was not found");
		const envelope = JSON.parse(await fs.readFile(info.path, "utf8")) as EncryptedBackupEnvelope;
		const payload: unknown = JSON.parse(await decryptBackupData(envelope, TEST_PASSWORD));
		validateBackup(payload);
		return { info, envelope, payload };
	}

	describe("read-only Restore preparation", () => {
		const destination = {
			encryptor: new Encryptor("b".repeat(64)),
			installationId: "synthetic-restore-destination",
			stableForRestart: true,
		};
		async function contentsSnapshot() {
			if (!testDir) throw new Error("Owned fixture is missing");
			const files: Record<string, { hash: string; mode: number; inode: string; mtime: string }> =
				{};
			async function walk(directory: string, relative = "") {
				const entries = await fs.readdir(directory, { withFileTypes: true });
				for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
					const filename = path.join(directory, entry.name);
					const key = path.join(relative, entry.name);
					if (entry.isDirectory()) {
						await walk(filename, key);
						continue;
					}

					const handle = await fs.open(
						filename,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					try {
						const stat = await handle.stat({ bigint: true });
						if (!stat.isFile()) throw new Error("Expected a regular synthetic fixture file");
						files[key] = {
							hash: createHash("sha256")
								.update(await handle.readFile())
								.digest("hex"),
							mode: Number(stat.mode & 0o777n),
							inode: stat.ino.toString(),
							mtime: stat.mtimeNs.toString(),
						};
					} finally {
						await handle.close();
					}
				}
			}
			await walk(testDir);
			return files;
		}
		async function encryptedFixture() {
			vi.stubEnv("BACKUP_PASSWORD", TEST_PASSWORD);
			const created = await backupService.createBackup("2.6.2", "manual");
			const { info } = await readBackup(created.id);
			return { id: created.id, envelopeJson: await fs.readFile(info.path, "utf8") };
		}
		async function corruptStoredPassword() {
			await prisma!.backupSettings.upsert({
				where: { id: 1 },
				create: { id: 1, encryptedPassword: "invalid-synthetic-ciphertext", passwordIv: "invalid" },
				update: { encryptedPassword: "invalid-synthetic-ciphertext", passwordIv: "invalid" },
			});
		}

		it.each([
			"stored",
			"environment",
			"override",
			"override-before-stored",
			"invalid-stored-environment",
			"invalid-stored-override",
		])(
			"prepares an authenticated upload using %s without changing destination state",
			async (selection) => {
				const fixture = await encryptedFixture();
				let password: string | undefined;
				if (selection === "stored") {
					await backupService.setPassword(TEST_PASSWORD);
					vi.stubEnv("BACKUP_PASSWORD", "incorrect-environment-password");
				} else if (selection.startsWith("invalid-stored")) {
					await corruptStoredPassword();
					if (selection === "invalid-stored-override") {
						password = TEST_PASSWORD;
						vi.stubEnv("BACKUP_PASSWORD", "");
					}
				} else if (selection.startsWith("override")) {
					password = TEST_PASSWORD;
					vi.stubEnv("BACKUP_PASSWORD", "incorrect-environment-password");
					if (selection === "override-before-stored")
						await backupService.setPassword("incorrect-stored-password");
				}
				const before = await contentsSnapshot();
				expect(backupService.prepareBackupRestore).toBeTypeOf("function");
				const prepared = await backupService.prepareBackupRestore(
					fixture.envelopeJson,
					password,
					destination,
				);
				expect(() => assertPreparedRestoreData(prepared)).not.toThrow();
				expect(prepared.destinationInstallationId).toBe("synthetic-restore-destination");
				expect(prepared.safetyCoverage).toBe("complete");
				const restored = prepared.records.serviceInstances[0] as Record<string, unknown>;
				expect(
					destination.encryptor.decrypt({
						value: String(restored.encryptedApiKey),
						iv: String(restored.encryptionIv),
					}),
				).toBe("synthetic-api-key");
				expect(await contentsSnapshot()).toEqual(before);
			},
		);

		it("prepares a freshly resolved stored file without publishing or modifying it", async () => {
			const fixture = await encryptedFixture();
			const before = await contentsSnapshot();
			expect(backupService.prepareBackupRestoreFromFile).toBeTypeOf("function");
			const prepared = await backupService.prepareBackupRestoreFromFile(
				fixture.id,
				undefined,
				destination,
			);
			expect(() => assertPreparedRestoreData(prepared)).not.toThrow();
			expect(prepared.records.users).toHaveLength(1);
			expect(prepared.publicationBlockers).toEqual([]);
			expect(await contentsSnapshot()).toEqual(before);
		});

		it("never generates or persists a development password during preparation", async () => {
			const fixture = await encryptedFixture();
			vi.stubEnv("BACKUP_PASSWORD", "");
			vi.stubEnv("NODE_ENV", "development");
			const before = await contentsSnapshot();
			expect(backupService.prepareBackupRestore).toBeTypeOf("function");
			await expect(
				backupService.prepareBackupRestore(fixture.envelopeJson, undefined, destination),
			).rejects.toEqual(new RestorePreparationError("authentication-failed"));
			expect(await contentsSnapshot()).toEqual(before);
		});

		it("preserves an invalid stored-password refusal when no override or environment password exists", async () => {
			const fixture = await encryptedFixture();
			await corruptStoredPassword();
			vi.stubEnv("BACKUP_PASSWORD", "");
			const before = await contentsSnapshot();
			expect(backupService.prepareBackupRestore).toBeTypeOf("function");
			await expect(
				backupService.prepareBackupRestore(fixture.envelopeJson, undefined, destination),
			).rejects.toBeInstanceOf(BackupPasswordConfigurationError);
			expect(await contentsSnapshot()).toEqual(before);
		});

		it.each(["", "x".repeat(1025), "incorrect-explicit-password"])(
			"refuses an invalid explicit password without falling back or changing state",
			async (password) => {
				const fixture = await encryptedFixture();
				const before = await contentsSnapshot();
				expect(backupService.prepareBackupRestore).toBeTypeOf("function");
				await expect(
					backupService.prepareBackupRestore(fixture.envelopeJson, password, destination),
				).rejects.toEqual(new RestorePreparationError("authentication-failed"));
				expect(await contentsSnapshot()).toEqual(before);
			},
		);

		it.each(["not-json", "{}", '{"version":"1.4","data":{},"secrets":{}}'])(
			"refuses malformed or plaintext input without changing state",
			async (json) => {
				const before = await contentsSnapshot();
				expect(backupService.prepareBackupRestore).toBeTypeOf("function");
				await expect(
					backupService.prepareBackupRestore(json, TEST_PASSWORD, destination),
				).rejects.toEqual(new RestorePreparationError("invalid-envelope"));
				expect(await contentsSnapshot()).toEqual(before);
			},
		);

		it.each(["unstable-destination", "unsynchronized-service"])(
			"refuses %s before publishing or changing destination state",
			async (condition) => {
				const fixture = await encryptedFixture();
				const service =
					condition === "unsynchronized-service"
						? new BackupService(prisma!, testSecretsPath, encryptor, false)
						: backupService;
				const target = { ...destination, stableForRestart: condition !== "unstable-destination" };
				const before = await contentsSnapshot();
				expect(service.prepareBackupRestore).toBeTypeOf("function");
				await expect(
					service.prepareBackupRestore(fixture.envelopeJson, TEST_PASSWORD, target),
				).rejects.toEqual(new RestorePreparationError("destination-unavailable"));
				expect(await contentsSnapshot()).toEqual(before);
			},
		);

		it("refuses incomplete legacy safety coverage even when its envelope authenticates", async () => {
			const fixture = await encryptedFixture();
			const { payload } = await readBackup(fixture.id);
			const legacyEnvelope = await encryptBackupData(
				JSON.stringify({ ...payload, version: "1.2" }),
				TEST_PASSWORD,
			);
			const before = await contentsSnapshot();
			await expect(
				backupService.prepareBackupRestore(
					JSON.stringify(legacyEnvelope),
					TEST_PASSWORD,
					destination,
				),
			).rejects.toEqual(new RestorePreparationError("invalid-backup"));
			expect(await contentsSnapshot()).toEqual(before);
		});

		it("refuses an absent stored backup without initializing storage", async () => {
			const before = await contentsSnapshot();
			await expect(
				backupService.prepareBackupRestoreFromFile("a".repeat(24), TEST_PASSWORD, destination),
			).rejects.toThrow(/^stored-file-unavailable$/);
			expect(await contentsSnapshot()).toEqual(before);
		});
	});

	describe("BackupService - Password Management (Integration)", () => {
		it("should return correct status when no password is configured", async () => {
			const status = await backupService.getPasswordStatus();
			expect(status).toHaveProperty("configured");
			expect(status).toHaveProperty("source");
			expect(status).toEqual({ configured: false, source: "none" });
		});

		it("should set password in database", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			const reloaded = new BackupService(
				prisma!,
				testSecretsPath,
				new Encryptor(TEST_SECRETS.encryptionKey),
			);
			const status = await reloaded.getPasswordStatus();
			expect(status.configured).toBe(true);
			expect(status.source).toBe("database");
			const stored = await prisma!.backupSettings.findUniqueOrThrow({ where: { id: 1 } });
			expect(stored.encryptedPassword).not.toBe(TEST_PASSWORD);
			expect(stored.passwordIv).toBeTruthy();
			expect(encryptor.decrypt({ value: stored.encryptedPassword!, iv: stored.passwordIv! })).toBe(
				TEST_PASSWORD,
			);
			const backup = await reloaded.createBackup("2.6.2", "manual");
			await readBackup(backup.id);
		});

		it("should remove password from database", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			await backupService.removePassword();
			const status = await backupService.getPasswordStatus();
			expect(status.source).not.toBe("database");
			expect(status).toEqual({ configured: false, source: "none" });
			const stored = await prisma!.backupSettings.findUniqueOrThrow({ where: { id: 1 } });
			expect(stored.encryptedPassword).toBeNull();
			expect(stored.passwordIv).toBeNull();
			await expect(backupService.createBackup("2.6.2")).rejects.toThrow("BACKUP_PASSWORD");
			expect(await backupService.listBackups()).toEqual([]);
		});

		it("should require minimum password length", async () => {
			await expect(backupService.setPassword("short")).rejects.toThrow("at least 8 characters");
			expect(await prisma!.backupSettings.count()).toBe(0);
			await expect(backupService.setPassword("ValidPassword123!")).resolves.not.toThrow();
		});
	});

	describe("BackupService - Backup Creation with includeTrashBackups (Integration)", () => {
		it("keeps native schema receipts out of backups and preserves them during read-only preparation", async () => {
			await prisma!.$executeRawUnsafe(
				'CREATE TABLE "ArrSchemaMigrationReceipt"("id" TEXT NOT NULL PRIMARY KEY,"protocolVersion" INTEGER NOT NULL DEFAULT 1,"registryVersion" INTEGER NOT NULL,"provider" TEXT NOT NULL,"targetDigest" TEXT NOT NULL,"planDigest" TEXT NOT NULL,"completedAt" DATETIME NOT NULL)',
			);
			await prisma!.$executeRawUnsafe(
				'INSERT INTO "ArrSchemaMigrationReceipt" VALUES(?,1,1,?,?,?,?)',
				"destination-native-transition-sentinel",
				"sqlite",
				"a".repeat(64),
				"b".repeat(64),
				"2026-10-08T00:00:00.000Z",
			);
			const before = await prisma!.$queryRawUnsafe('SELECT * FROM "ArrSchemaMigrationReceipt"');
			await prisma!.$executeRawUnsafe(
				'CREATE TABLE "ArrRuntimeDataFormatReceipt"("id" INTEGER NOT NULL PRIMARY KEY,"formatVersion" INTEGER NOT NULL,"dateColumnsDigest" TEXT NOT NULL,"completedAt" TEXT NOT NULL,"normalizedValues" INTEGER NOT NULL)',
			);
			await prisma!.$executeRawUnsafe(
				'INSERT INTO "ArrRuntimeDataFormatReceipt" VALUES(1,1,?,?,7)',
				"destination-native-format-sentinel",
				"2026-10-08T00:00:00.000+00:00",
			);
			const beforeFormat = await prisma!.$queryRawUnsafe(
				'SELECT * FROM "ArrRuntimeDataFormatReceipt"',
			);
			await backupService.setPassword(TEST_PASSWORD);
			const created = await backupService.createBackup("2.6.2", "manual");
			const { payload } = await readBackup(created.id);
			expect(payload.data).not.toHaveProperty("arrSchemaMigrationReceipts");
			expect(payload.data).not.toHaveProperty("ArrSchemaMigrationReceipt");
			expect(payload.data).not.toHaveProperty("arrRuntimeDataFormatReceipts");
			expect(payload.data).not.toHaveProperty("ArrRuntimeDataFormatReceipt");
			expect(JSON.stringify(payload)).not.toContain("destination-native-transition-sentinel");
			expect(JSON.stringify(payload)).not.toContain("destination-native-format-sentinel");
			const prepared = await backupService.prepareBackupRestore(
				JSON.stringify(
					await encryptBackupData(
						JSON.stringify({
							...payload,
							data: {
								...payload.data,
								arrSchemaMigrationReceipts: [{ id: "source-native-transition" }],
								arrRuntimeDataFormatReceipts: [{ id: "source-native-format" }],
							},
						}),
						TEST_PASSWORD,
					),
				),
				undefined,
				{ encryptor, installationId: "synthetic-destination", stableForRestart: true },
			);
			expect(() => assertPreparedRestoreData(prepared)).not.toThrow();
			expect(await prisma!.$queryRawUnsafe('SELECT * FROM "ArrSchemaMigrationReceipt"')).toEqual(
				before,
			);
			expect(await prisma!.$queryRawUnsafe('SELECT * FROM "ArrRuntimeDataFormatReceipt"')).toEqual(
				beforeFormat,
			);
		});
		it("should create backup without TRaSH backups by default", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			const backupInfo = await backupService.createBackup("2.6.2", "manual");
			expect(backupInfo).toHaveProperty("id");
			expect(backupInfo).toHaveProperty("filename");
			expect(backupInfo).toHaveProperty("timestamp");
			expect(backupInfo).toHaveProperty("size");
			expect(backupInfo.type).toBe("manual");
			const { info, envelope, payload } = await readBackup(backupInfo.id);
			expect(payload.secrets).toEqual(TEST_SECRETS);
			expect(payload.data.users).toEqual([expect.objectContaining({ id: "backup-test-owner" })]);
			expect(payload.data.trashBackups).toEqual([]);
			expect((await fs.stat(info.path)).mode & 0o777).toBe(0o600);
			await expect(decryptBackupData(envelope, "incorrect-synthetic-password")).rejects.toThrow(
				"Failed to decrypt backup",
			);
		});

		it("should create backup with TRaSH backups when option enabled", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			const backupInfo = await backupService.createBackup("2.6.2", "manual", {
				includeTrashBackups: true,
			});
			expect(backupInfo).toHaveProperty("id");
			expect(backupInfo.type).toBe("manual");
			expect(backupInfo.size).toBeGreaterThan(0);
			const { payload } = await readBackup(backupInfo.id);
			expect(payload.data.trashBackups).toEqual([
				expect.objectContaining({ id: "backup-test-snapshot" }),
			]);
		});

		it("should organize backups by type in subdirectories", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			const manualBackup = await backupService.createBackup("2.6.2", "manual");
			const scheduledBackup = await backupService.createBackup("2.6.2", "scheduled");
			expect(manualBackup.type).toBe("manual");
			expect(scheduledBackup.type).toBe("scheduled");
			const manual = await readBackup(manualBackup.id);
			const scheduled = await readBackup(scheduledBackup.id);
			expect(path.dirname(manual.info.path)).toBe(path.join(testDir!, "backups", "manual"));
			expect(path.dirname(scheduled.info.path)).toBe(path.join(testDir!, "backups", "scheduled"));
		});
	});

	describe("BackupService - Backup Listing (Integration)", () => {
		it("should list all backups", async () => {
			await backupService.setPassword(TEST_PASSWORD);
			const created = await backupService.createBackup("2.6.2", "manual");
			const backups = await backupService.listBackups();
			expect(Array.isArray(backups)).toBe(true);
			expect(backups.length).toBeGreaterThanOrEqual(1);
			expect(backups).toHaveLength(1);
			expect(backups[0]?.id).toBe(created.id);
		});

		it("should return empty array when no backups exist", async () => {
			const backups = await backupService.listBackups();
			expect(Array.isArray(backups)).toBe(true);
			expect(backups).toEqual([]);
		});
	});

	it.each([
		["missing key", JSON.stringify({ sessionCookieSecret: TEST_SECRETS.sessionCookieSecret })],
		["wrong secret type", JSON.stringify({ ...TEST_SECRETS, encryptionKey: 7 })],
		["invalid JSON", '{"synthetic":'],
	])(
		"rejects %s without publishing a file, then allows explicit retry",
		async (_category, contents) => {
			await backupService.setPassword(TEST_PASSWORD);
			await fs.writeFile(testSecretsPath, contents, { mode: 0o600 });
			await expect(backupService.createBackup("2.6.2")).rejects.toThrow("secrets");
			expect(await backupService.listBackups()).toEqual([]);
			expect(await prisma!.user.count()).toBe(1);
			expect(await prisma!.trashBackup.count()).toBe(1);
			await fs.writeFile(testSecretsPath, JSON.stringify(TEST_SECRETS), { mode: 0o600 });
			const retried = await backupService.createBackup("2.6.2");
			await readBackup(retried.id);
			expect(await backupService.listBackups()).toHaveLength(1);
		},
	);
});

// Unit tests - these don't require database access
describe("BackupService - Backup Validation (Unit)", () => {
	it("rejects backup creation while active environment secrets are unsynchronized", async () => {
		const backupService = new BackupService(
			{} as PrismaClient,
			"/unused/secrets.json",
			undefined,
			false,
		);

		await expect(backupService.createBackup("2.23.0")).rejects.toThrow(
			"active environment secrets could not be synchronized",
		);
	});

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

	it("accepts the current 1.1 payload format", () => {
		const currentBackup = {
			version: "1.1",
			appVersion: "3.0.0-beta",
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

		expect(() => validateBackup(currentBackup)).not.toThrow();
	});

	it("applies coordination evidence requirements according to backup version", () => {
		const legacyBackup = {
			version: "1.0",
			appVersion: "2.23.0",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [{ id: "instance-1", userId: "user-1" }],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				trashTemplates: [{ id: "template-1", userId: "user-1" }],
				templateDeploymentHistory: [
					{
						id: "legacy-partial-undeploy",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "PARTIAL_UNDEPLOY",
					},
				],
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		expect(() => validateBackup(legacyBackup)).not.toThrow();
		expect(() => validateBackup({ ...legacyBackup, version: "1.1" })).toThrow(
			"missing backup snapshot reference",
		);
	});

	it.each(["1.0", "1.1"])(
		"accepts a valid %s payload with authoritative coordination ownership",
		(version) => {
			const validBackup = {
				version,
				appVersion: "3.0.0-beta",
				timestamp: new Date().toISOString(),
				data: {
					users: [],
					sessions: [],
					serviceInstances: [{ id: "instance-1", userId: "user-1" }],
					serviceTags: [],
					serviceInstanceTags: [],
					oidcAccounts: [],
					webAuthnCredentials: [],
					trashTemplates: [{ id: "template-1", userId: "user-1" }],
					trashSyncHistory: [
						{
							id: "rollback-1",
							instanceId: "instance-1",
							templateId: "template-1",
							userId: "user-1",
							rollbackStatus: "IN_PROGRESS",
							backupId: "snapshot-1",
						},
					],
					templateDeploymentHistory: [
						{
							id: "undeploy-1",
							instanceId: "instance-1",
							templateId: "template-1",
							userId: "user-1",
							undeployStatus: "IN_PROGRESS",
							backupId: "snapshot-1",
						},
					],
					trashBackups: [
						{
							id: "snapshot-1",
							instanceId: "instance-1",
							userId: "user-1",
							backupData: "recovery-evidence",
						},
					],
				},
				secrets: {
					encryptionKey: "test-encryption-key-32-bytes-hex",
					sessionCookieSecret: "test-session-cookie-secret",
				},
			};

			expect(() => validateBackup(validBackup)).not.toThrow();
		},
	);

	it.each([
		{
			name: "missing backupId",
			history: {
				trashSyncHistory: [
					{
						id: "rollback-1",
						instanceId: "instance-1",
						userId: "user-1",
						rollbackStatus: "IN_PROGRESS",
						backupId: null,
					},
				],
				trashBackups: [],
			},
		},
		{
			name: "missing referenced snapshot",
			history: {
				trashSyncHistory: [
					{
						id: "rollback-2",
						instanceId: "instance-1",
						userId: "user-1",
						rollbackStatus: "PARTIAL",
						backupId: "snapshot-missing",
					},
				],
				trashBackups: [],
			},
		},
		{
			name: "mismatched snapshot ownership",
			history: {
				serviceInstances: [
					{ id: "instance-1", userId: "user-1" },
					{ id: "instance-2", userId: "user-1" },
				],
				templateDeploymentHistory: [
					{
						id: "undeploy-1",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						undeployStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-2",
						userId: "user-1",
						backupData: "wrong-instance-evidence",
					},
				],
			},
		},
		{
			name: "empty snapshot payload",
			history: {
				templateDeploymentHistory: [
					{
						id: "undeploy-2",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "PARTIAL_UNDEPLOY",
						backupId: "snapshot-2",
					},
				],
				trashBackups: [
					{
						id: "snapshot-2",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "",
					},
				],
			},
		},
	])("fails closed before restore when coordination evidence is $name", ({ history }) => {
		const unsafeBackup = {
			version: "1.1",
			appVersion: "3.0.0-beta",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [{ id: "instance-1", userId: "user-1" }],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				trashTemplates: [{ id: "template-1", userId: "user-1" }],
				...history,
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		expect(() => validateBackup(unsafeBackup)).toThrow("coordination evidence");
	});

	it.each([
		{
			name: "snapshot references a missing service instance",
			history: {
				trashBackups: [
					{
						id: "snapshot-missing-instance",
						instanceId: "instance-missing",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "referenced service instance instance-missing is missing",
		},
		{
			name: "snapshot owner differs from its service instance owner",
			history: {
				trashBackups: [
					{
						id: "snapshot-cross-owner",
						instanceId: "instance-1",
						userId: "user-2",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "owner does not match service instance instance-1",
		},
		{
			name: "journal references a missing service instance",
			history: {
				trashSyncHistory: [
					{
						id: "rollback-missing-instance",
						instanceId: "instance-missing",
						userId: "user-1",
						rollbackStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "referenced service instance instance-missing is missing",
		},
		{
			name: "journal owner differs from its service instance owner",
			history: {
				trashSyncHistory: [
					{
						id: "rollback-cross-owner",
						instanceId: "instance-1",
						userId: "user-2",
						rollbackStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "owner does not match service instance instance-1",
		},
		{
			name: "undeploy journal references a missing template",
			history: {
				templateDeploymentHistory: [
					{
						id: "undeploy-missing-template",
						instanceId: "instance-1",
						templateId: "template-missing",
						userId: "user-1",
						undeployStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "referenced template template-missing is missing",
		},
		{
			name: "undeploy journal omits its template reference",
			history: {
				templateDeploymentHistory: [
					{
						id: "undeploy-without-template",
						instanceId: "instance-1",
						userId: "user-1",
						undeployStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "missing template reference",
		},
		{
			name: "undeploy journal owner differs from its template owner",
			history: {
				trashTemplates: [{ id: "template-1", userId: "user-2" }],
				templateDeploymentHistory: [
					{
						id: "undeploy-cross-owner-template",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						undeployStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "owner does not match template template-1",
		},
		{
			name: "rollback journal owner differs from its referenced template owner",
			history: {
				trashTemplates: [{ id: "template-1", userId: "user-2" }],
				trashSyncHistory: [
					{
						id: "rollback-cross-owner-template",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						rollbackStatus: "IN_PROGRESS",
						backupId: "snapshot-1",
					},
				],
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "recovery-evidence",
					},
				],
			},
			message: "owner does not match template template-1",
		},
		{
			name: "authoritative service identities are duplicated",
			history: {
				serviceInstances: [
					{ id: "instance-1", userId: "user-1" },
					{ id: "instance-1", userId: "user-2" },
				],
			},
			message: "duplicate service instance identity instance-1",
		},
		{
			name: "recovery snapshot identities are duplicated",
			history: {
				trashBackups: [
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "first",
					},
					{
						id: "snapshot-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: "second",
					},
				],
			},
			message: "duplicate backup snapshot identity snapshot-1",
		},
		{
			name: "authoritative template identities are duplicated",
			history: {
				trashTemplates: [
					{ id: "template-1", userId: "user-1" },
					{ id: "template-1", userId: "user-2" },
				],
			},
			message: "duplicate template identity template-1",
		},
	])("rejects $name before restore", ({ history, message }) => {
		const unsafeBackup = {
			version: "1.1",
			appVersion: "3.0.0-beta",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [{ id: "instance-1", userId: "user-1" }],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				trashTemplates: [{ id: "template-1", userId: "user-1" }],
				...history,
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		expect(() => validateBackup(unsafeBackup)).toThrow(message);
	});

	it("does not require snapshots for completed coordination", () => {
		const completedBackup = {
			version: "1.1",
			appVersion: "3.0.0-beta",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				trashSyncHistory: [{ id: "done", rollbackStatus: "COMPLETED" }],
				templateDeploymentHistory: [
					{
						id: "legacy-rolled-back",
						status: "PARTIAL_UNDEPLOY",
						rolledBack: true,
					},
					{
						id: "legacy-undeploy-completed",
						status: "PARTIAL_UNDEPLOY",
						undeployStatus: "COMPLETED",
					},
				],
				trashBackups: [],
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		expect(() => validateBackup(completedBackup)).not.toThrow();
	});

	it.each(["IN_PROGRESS", "RUNNING"])(
		"requires recovery evidence for ordinary sync status %s",
		(status) => {
			const backup = {
				version: "1.1",
				appVersion: "3.0.0-beta",
				timestamp: new Date().toISOString(),
				data: {
					users: [],
					sessions: [],
					serviceInstances: [{ id: "instance-1", userId: "user-1" }],
					serviceTags: [],
					serviceInstanceTags: [],
					oidcAccounts: [],
					webAuthnCredentials: [],
					trashSyncHistory: [
						{
							id: `sync-${status.toLowerCase()}`,
							instanceId: "instance-1",
							userId: "user-1",
							status,
							backupId: null,
						},
					],
					trashBackups: [],
				},
				secrets: {
					encryptionKey: "test-encryption-key-32-bytes-hex",
					sessionCookieSecret: "test-session-cookie-secret",
				},
			};

			expect(() => validateBackup(backup)).toThrow("missing backup snapshot reference");
		},
	);

	it("requires recovery evidence for an ordinary in-progress template deployment", () => {
		const backup = {
			version: "1.1",
			appVersion: "3.0.0-beta",
			timestamp: new Date().toISOString(),
			data: {
				users: [],
				sessions: [],
				serviceInstances: [{ id: "instance-1", userId: "user-1" }],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				trashTemplates: [{ id: "template-1", userId: "user-1" }],
				templateDeploymentHistory: [
					{
						id: "deployment-in-progress",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "IN_PROGRESS",
						backupId: null,
					},
				],
				trashBackups: [],
			},
			secrets: {
				encryptionKey: "test-encryption-key-32-bytes-hex",
				sessionCookieSecret: "test-session-cookie-secret",
			},
		};

		expect(() => validateBackup(backup)).toThrow("missing backup snapshot reference");
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

describe("BackupService - backup password status (Unit)", () => {
	const testSecretsPath = "/unused/secrets.json";
	const activeKey = "a".repeat(64);
	const previousKey = "b".repeat(64);

	function serviceForSettings(
		settings: { encryptedPassword: string | null; passwordIv: string | null } | null,
		encryptor = new Encryptor(activeKey),
	) {
		const prisma = {
			backupSettings: {
				findUnique: vi.fn().mockResolvedValue(settings),
			},
		} as unknown as PrismaClient;

		return new BackupService(prisma, testSecretsPath, encryptor);
	}

	beforeEach(() => {
		vi.stubEnv("BACKUP_PASSWORD", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reports a password encrypted by another key as invalid instead of configured", async () => {
		const encrypted = new Encryptor(previousKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: encrypted.iv };
		const status = await serviceForSettings(stored).getPasswordStatus();

		expect(status).toEqual({
			configured: false,
			source: "database",
			reason: "invalid_database_password",
		});
		expect(status).not.toHaveProperty("password");
		expect(status).not.toHaveProperty("encryptedPassword");
	});

	it("reports corrupt ciphertext as invalid without exposing crypto details", async () => {
		const encrypted = new Encryptor(activeKey).encrypt("TestPassword123!");
		const stored = {
			encryptedPassword: `${encrypted.value.slice(0, -4)}AAAA`,
			passwordIv: encrypted.iv,
		};

		const status = await serviceForSettings(stored).getPasswordStatus();

		expect(status).toMatchObject({
			configured: false,
			source: "database",
			reason: "invalid_database_password",
		});
		expect(JSON.stringify(status)).not.toContain("Unsupported");
	});

	it("reports corrupt IV as invalid", async () => {
		const encrypted = new Encryptor(activeKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: "not-a-valid-iv" };

		await expect(serviceForSettings(stored).getPasswordStatus()).resolves.toEqual({
			configured: false,
			source: "database",
			reason: "invalid_database_password",
		});
	});

	it("reports a decryptable database password as configured", async () => {
		const encrypted = new Encryptor(activeKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: encrypted.iv };

		await expect(serviceForSettings(stored).getPasswordStatus()).resolves.toEqual({
			configured: true,
			source: "database",
		});
	});

	it("falls back to the environment password when no database password exists", async () => {
		vi.stubEnv("BACKUP_PASSWORD", "environment-password");

		await expect(serviceForSettings(null).getPasswordStatus()).resolves.toEqual({
			configured: true,
			source: "environment",
		});
	});

	it("uses the environment password when the stored password is invalid", async () => {
		const encrypted = new Encryptor(previousKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: encrypted.iv };
		vi.stubEnv("BACKUP_PASSWORD", "environment-password");

		await expect(serviceForSettings(stored).getPasswordStatus()).resolves.toEqual({
			configured: true,
			source: "environment",
		});
	});

	it("returns bounded reset guidance when production backup creation has an invalid stored password", async () => {
		const encrypted = new Encryptor(previousKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: encrypted.iv };
		vi.stubEnv("NODE_ENV", "production");

		const getPassword = (
			serviceForSettings(stored) as unknown as { getBackupPassword: () => Promise<string> }
		).getBackupPassword();

		await expect(getPassword).rejects.toThrow(
			"The stored backup password is invalid. Reset it in Settings > Backup or set the BACKUP_PASSWORD environment variable.",
		);
		await expect(getPassword).rejects.not.toThrow(/cipher|decrypt|key/i);
	});

	it("rejects an invalid stored password instead of generating a development password", async () => {
		const encrypted = new Encryptor(previousKey).encrypt("TestPassword123!");
		const stored = { encryptedPassword: encrypted.value, passwordIv: encrypted.iv };
		vi.stubEnv("NODE_ENV", "development");

		const getPassword = (
			serviceForSettings(stored) as unknown as { getBackupPassword: () => Promise<string> }
		).getBackupPassword();

		await expect(getPassword).rejects.toBeInstanceOf(BackupPasswordConfigurationError);
	});

	it("reports an absent password as unconfigured", async () => {
		await expect(serviceForSettings(null).getPasswordStatus()).resolves.toEqual({
			configured: false,
			source: "none",
		});
	});
});

describe("BackupService - unstable preparation containment", () => {
	it("rejects an unstable destination before parsing, filesystem access, or database access", async () => {
		const prisma = new Proxy(
			{},
			{
				get() {
					throw new Error("database access must remain unreachable");
				},
			},
		) as PrismaClient;
		const backupService = new BackupService(prisma, "/unreachable/secrets.json");
		const destination = {
			encryptor: new Encryptor("64".repeat(32)),
			installationId: "synthetic-destination",
			stableForRestart: false,
		};
		await expect(
			backupService.prepareBackupRestore("not-json", undefined, destination),
		).rejects.toEqual(new RestorePreparationError("destination-unavailable"));
		await expect(
			backupService.prepareBackupRestoreFromFile("a".repeat(24), undefined, destination),
		).rejects.toEqual(new RestorePreparationError("destination-unavailable"));
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
			assertRestoreCompatibility: vi.fn().mockResolvedValue(undefined),
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
			assertRestoreCompatibility: vi.fn().mockResolvedValue(undefined),
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
			assertRestoreCompatibility: vi.fn().mockResolvedValue(undefined),
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
			assertRestoreCompatibility: vi.fn().mockResolvedValue(undefined),
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
