import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { decryptBackupData, type EncryptedBackupEnvelope } from "../../lib/backup/backup-crypto.js";
import { BACKUP_VERSION, validateBackup } from "../../lib/backup/backup-validation.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerBackupRoutes } from "../backup.js";
import { registerTestErrorHandler } from "./test-helpers.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const HOOK_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);
const TEST_PASSWORD = "synthetic-backup-evidence-password";

async function pushSqliteSchema(databasePath: string): Promise<void> {
	const apiDir = path.resolve(import.meta.dirname, "../../..");
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
			cwd: apiDir,
			env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		},
	);
}

async function buildApp(prisma: PrismaClient, databaseUrl: string): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("config", { DATABASE_URL: databaseUrl } as never);
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "unused", iv: "unused" }),
		decrypt: vi.fn().mockReturnValue("unused"),
	} as never);
	app.decorate("secretsSynchronized", true);
	app.decorateRequest("currentUser", null);

	app.addHook("preHandler", async (request) => {
		if (request.headers["x-test-auth"]) {
			(request as { currentUser: { id: string; username: string } | null }).currentUser = {
				id: "backup-evidence-user",
				username: "backup-evidence-user",
			};
		}
	});
	registerTestErrorHandler(app);

	await app.register(async (protectedApp) => {
		protectedApp.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});
		await protectedApp.register(registerBackupRoutes, { prefix: "/api/backup" });
	});

	await app.ready();
	return app;
}

(RUN_DB_TESTS ? describe : describe.skip)("backup create/download binding", () => {
	let app: FastifyInstance | undefined;
	let prisma: PrismaClient | undefined;
	let tempDir: string | undefined;

	beforeAll(async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BACKUP_PASSWORD", TEST_PASSWORD);

		tempDir = await mkdtemp(path.join(os.tmpdir(), "backup-create-download-"));
		const databasePath = path.join(tempDir, "qa.db");
		const databaseUrl = `file:${databasePath}`;
		await pushSqliteSchema(databasePath);

		await writeFile(
			path.join(tempDir, "secrets.json"),
			JSON.stringify({
				encryptionKey: "synthetic-encryption-key",
				sessionCookieSecret: "synthetic-session-secret",
			}),
			{ mode: 0o600 },
		);

		prisma = createTestPrismaClient(databasePath);
		await prisma.user.create({
			data: {
				id: "backup-evidence-user",
				username: "backup-evidence-user",
				hashedPassword: "synthetic-password-hash",
			},
		});
		app = await buildApp(prisma, databaseUrl);
	}, HOOK_TIMEOUT_MS);

	afterAll(async () => {
		await app?.close();
		await prisma?.$disconnect();
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	it("returns the exact encrypted file and authenticates it with the configured password", async () => {
		if (!app || !tempDir) throw new Error("Backup integration fixture was not initialized");

		const created = await app.inject({
			method: "POST",
			url: "/api/backup/create",
			headers: { "x-test-auth": "1" },
			payload: {},
		});
		expect(created.statusCode).toBe(200);
		const backup = created.json<{ id: string; filename: string }>();

		const downloaded = await app.inject({
			method: "GET",
			url: `/api/backup/${backup.id}/download`,
			headers: { "x-test-auth": "1" },
		});
		expect(downloaded.statusCode).toBe(200);
		expect(downloaded.headers["content-type"]).toBe("application/octet-stream");

		const filePath = path.join(tempDir, "backups", "manual", backup.filename);
		const fileBytes = await readFile(filePath);
		expect(downloaded.rawPayload).toEqual(fileBytes);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);

		const envelope = JSON.parse(downloaded.rawPayload.toString("utf8")) as EncryptedBackupEnvelope;
		const payload = JSON.parse(await decryptBackupData(envelope, TEST_PASSWORD)) as unknown;
		validateBackup(payload);
		expect(payload.version).toBe(BACKUP_VERSION);
		expect(payload.data.users).toHaveLength(1);

		await expect(decryptBackupData(envelope, "incorrect-synthetic-password")).rejects.toThrow(
			"Failed to decrypt backup: invalid password or corrupted data",
		);
	});
});
