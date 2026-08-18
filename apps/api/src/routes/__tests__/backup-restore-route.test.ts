/**
 * F-01 restore route HTTP contract tests.
 *
 * Prove the API maps a legacy-incompatibility rejection to HTTP 409 (not 500)
 * and a malformed v1.2 backup to a 400-class validation error (not 409/500),
 * without exposing secrets. Both restore entrypoints share the same
 * BackupService.restoreBackup() path and the same per-route error mapping, so
 * the uploaded-restore route is exercised directly; the file-restore route
 * delegates to the identical service method and error branch.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupRoutes } from "../backup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const DURABLE_CONFIG_MODELS = [
	"notificationChannel",
	"notificationSubscription",
	"notificationRule",
	"notificationAggregationConfig",
	"autoTagRule",
	"labelSyncRule",
	"crossDomainRule",
	"queueCleanerConfig",
	"libraryCleanupConfig",
	"libraryCleanupRule",
	"namingConfig",
	"userCustomFormat",
] as const;

function makeLegacyBackup() {
	return {
		version: "1.1",
		appVersion: "2.23.0",
		timestamp: new Date().toISOString(),
		data: {
			users: [{ id: "user-1", username: "admin" }],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		},
		secrets: {
			encryptionKey: "b".repeat(64),
			sessionCookieSecret: "session-secret",
		},
	};
}

function makeMalformedV12Backup() {
	const emptyConfig = Object.fromEntries(DURABLE_CONFIG_MODELS.map((m) => [m, []]));
	delete emptyConfig.notificationChannel;
	return {
		version: "1.2",
		appVersion: "3.0.0",
		timestamp: new Date().toISOString(),
		data: {
			users: [],
			sessions: [],
			serviceInstances: [],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
			...emptyConfig,
		},
		secrets: {
			encryptionKey: "b".repeat(64),
			sessionCookieSecret: "session-secret",
		},
	};
}

describe("F-01 restore route HTTP contract", () => {
	let app: ReturnType<typeof Fastify>;
	let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(path.join(tmpdir(), "arr-f01-route-"));
		app = Fastify();

		// Populated target: every durable-config model reports a non-zero count so
		// the compatibility preflight detects a populated installation.
		const configModels = Object.fromEntries(
			DURABLE_CONFIG_MODELS.map((m) => [m, { count: vi.fn().mockResolvedValue(1) }]),
		);
		const prisma = {
			...configModels,
			$transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
		};
		app.decorate("prisma", prisma as never);
		app.decorate("config", {
			DATABASE_URL: `file:${path.join(dataDir, "prod.db")}`,
		} as never);
		app.decorate("encryptor", { encrypt: vi.fn(), decrypt: vi.fn() } as never);
		app.decorate("secretsSynchronized", true as never);
		app.decorate("lifecycle", { getRestartMessage: () => "ok", restart: vi.fn() } as never);

		setupAuthInjection(app);
		await app.register(registerBackupRoutes, { prefix: "/api/backup" });
		await app.ready();

		injectAuthenticated = createInjectAuthenticated(app);
	});

	afterEach(async () => {
		await app?.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("L — legacy backup over populated target returns 409 (not 500)", async () => {
		const backupJson = JSON.stringify(makeLegacyBackup());
		const backupData = Buffer.from(backupJson, "utf-8").toString("base64");

		const res = await injectAuthenticated("POST", "/api/backup/restore", {
			body: { backupData },
		});

		expect(res.statusCode).toBe(409);
		const body = res.json();
		expect(body.error).toBeTruthy();
		// Actionable but non-sensitive: no key material in the response.
		expect(JSON.stringify(body)).not.toContain("b".repeat(64));
		expect(JSON.stringify(body)).not.toContain("encryptionKey");
	});

	it("M — malformed v1.2 backup returns 400 (not 409/500)", async () => {
		const backupJson = JSON.stringify(makeMalformedV12Backup());
		const backupData = Buffer.from(backupJson, "utf-8").toString("base64");

		const res = await injectAuthenticated("POST", "/api/backup/restore", {
			body: { backupData },
		});

		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toBeTruthy();
		expect(JSON.stringify(body)).not.toContain("b".repeat(64));
	});
});
