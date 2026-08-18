/**
 * F-01 orchestration-level regression tests.
 *
 * These exercise the real `BackupService.restoreBackup()` boundary (including
 * secrets/filesystem handling), not just `restoreDatabase()`. They prove the
 * compatibility preflight runs BEFORE any secrets mutation, and that a
 * successful cross-key restore leaves a consistent (ciphertext, key) pair.
 *
 * Run with TEST_DB=true (see .github/workflows/ci.yml).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";
import { BackupCompatibilityError } from "../../errors.js";
import type { PrismaClient } from "../../prisma.js";
import { exportDatabase, restoreDatabase } from "../backup-database.js";
import { BackupService } from "../backup-service.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);

const KEY_A = "a".repeat(64); // 32-byte hex key
const KEY_B = "b".repeat(64); // 32-byte hex key

const USER_ID = "orch-user";
const INSTANCE_ID = "orch-instance";

function makeLegacyBackup(encryptionKey: string) {
	return {
		version: "1.1",
		appVersion: "2.23.0",
		timestamp: new Date().toISOString(),
		data: {
			users: [{ id: USER_ID, username: "orch-user" }],
			sessions: [],
			serviceInstances: [
				{
					id: INSTANCE_ID,
					userId: USER_ID,
					service: "RADARR",
					label: "Orch Radarr",
					baseUrl: "http://radarr:7878",
					encryptedApiKey: "ciphertext",
					encryptionIv: "iv",
				},
			],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		},
		secrets: {
			encryptionKey,
			sessionCookieSecret: "session-secret",
		},
	};
}

(RUN_DB_TESTS ? describe : describe.skip)("F-01 restore orchestration (SQLite)", () => {
	let prisma: PrismaClient;
	let databaseDir: string;
	let secretsPath: string;

	beforeAll(async () => {
		databaseDir = await mkdtemp(path.join(os.tmpdir(), "arr-f01-orch-"));
		const databasePath = path.join(databaseDir, "orch.db");
		secretsPath = path.join(databaseDir, "secrets.json");
		const schemaPath = path.resolve(import.meta.dirname, "../../../../prisma/schema.prisma");
		const prismaCli = path.resolve(
			import.meta.dirname,
			"../../../../node_modules/prisma/build/index.js",
		);
		await execFileAsync(process.execPath, [
			prismaCli,
			"db",
			"push",
			"--schema",
			schemaPath,
			"--url",
			`file:${databasePath}`,
		]);
		prisma = createTestPrismaClient(databasePath);
	});

	afterAll(async () => {
		await prisma.$disconnect();
		await rm(databaseDir, { recursive: true, force: true });
	});

	it("K — a rejected legacy restore never mutates the secrets file", async () => {
		// Seed a populated target with durable config + KEY-A secrets.
		await prisma.user.deleteMany();
		await prisma.user.create({ data: { id: USER_ID, username: "orch-user" } });
		await prisma.serviceInstance.create({
			data: {
				id: INSTANCE_ID,
				userId: USER_ID,
				service: "RADARR",
				label: "Orch Radarr",
				baseUrl: "http://radarr:7878",
				encryptedApiKey: "ciphertext",
				encryptionIv: "iv",
			},
		});
		await prisma.notificationChannel.create({
			data: {
				id: "chan-1",
				userId: USER_ID,
				name: "Channel 1",
				type: "WEBHOOK",
				encryptedConfig: "ciphertext-config",
				configIv: "iv-config",
			},
		});

		const secretsContent = JSON.stringify(
			{ encryptionKey: KEY_A, sessionCookieSecret: "session-secret" },
			null,
			2,
		);
		await writeFile(secretsPath, secretsContent, { mode: 0o600 });

		const service = new BackupService(prisma, secretsPath);
		const legacyBackup = makeLegacyBackup(KEY_B);

		await expect(service.restoreBackup(JSON.stringify(legacyBackup))).rejects.toBeInstanceOf(
			BackupCompatibilityError,
		);

		// Secrets file must be byte-for-byte identical — KEY-B was never written.
		const afterSecrets = await readFile(secretsPath, "utf-8");
		expect(afterSecrets).toBe(secretsContent);

		// Database unchanged: durable config still present.
		expect(await prisma.notificationChannel.count()).toBe(1);
		expect(await prisma.user.count()).toBe(1);
	});

	it("O — the database-layer recheck independently fails closed for a direct caller", async () => {
		// Direct call to restoreDatabase() (bypassing orchestration) must still
		// reject a legacy backup over a populated target. This is the defense-in-depth
		// against a stale orchestration preflight decision (TOCTOU).
		await prisma.user.deleteMany();
		await prisma.user.create({ data: { id: USER_ID, username: "orch-user" } });
		await prisma.notificationChannel.create({
			data: {
				id: "chan-2",
				userId: USER_ID,
				name: "Channel 2",
				type: "WEBHOOK",
				encryptedConfig: "ciphertext-config",
				configIv: "iv-config",
			},
		});

		const legacyData = makeLegacyBackup(KEY_B).data;
		await expect(restoreDatabase(prisma, legacyData as never)).rejects.toBeInstanceOf(
			BackupCompatibilityError,
		);
		expect(await prisma.notificationChannel.count()).toBe(1);
	});

	it("N — a successful cross-key restore leaves a consistent (ciphertext, key) pair", async () => {
		// Build a valid v1.2 backup whose ciphertext is encrypted under KEY-B.
		await prisma.user.deleteMany();
		const encryptorB = new Encryptor(KEY_B);
		const { value, iv } = encryptorB.encrypt("secret-api-key");
		await prisma.user.create({ data: { id: USER_ID, username: "orch-user" } });
		await prisma.serviceInstance.create({
			data: {
				id: INSTANCE_ID,
				userId: USER_ID,
				service: "RADARR",
				label: "Orch Radarr",
				baseUrl: "http://radarr:7878",
				encryptedApiKey: value,
				encryptionIv: iv,
			},
		});

		const data = await exportDatabase(prisma, { excludeOperationalHistory: false });
		const backup = {
			version: "1.2",
			appVersion: "3.0.0",
			timestamp: new Date().toISOString(),
			data,
			secrets: { encryptionKey: KEY_B, sessionCookieSecret: "session-secret" },
		};

		// Target currently uses KEY-A.
		await writeFile(
			secretsPath,
			JSON.stringify({ encryptionKey: KEY_A, sessionCookieSecret: "session-secret" }, null, 2),
			{ mode: 0o600 },
		);

		const service = new BackupService(prisma, secretsPath);
		await service.restoreBackup(JSON.stringify(backup));

		// Secrets file now carries KEY-B.
		const afterSecrets = JSON.parse(await readFile(secretsPath, "utf-8"));
		expect(afterSecrets.encryptionKey).toBe(KEY_B);

		// Restored ciphertext decrypts with the active (restored) key.
		const instance = await prisma.serviceInstance.findUnique({ where: { id: INSTANCE_ID } });
		const decrypted = new Encryptor(KEY_B).decrypt({
			value: instance!.encryptedApiKey,
			iv: instance!.encryptionIv,
		});
		expect(decrypted).toBe("secret-api-key");
	});
});
