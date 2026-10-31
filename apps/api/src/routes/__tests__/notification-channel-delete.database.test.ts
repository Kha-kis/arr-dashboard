import { execFileSync } from "node:child_process";
import { existsSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../config/env.js";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { synchronizeSqliteRuntimeSchema } from "../../lib/backup/runtime-schema-sqlite.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { buildServer } from "../../server.js";

// Keep actual server session/protected/error boundaries and real route SQL.
// Only startup infrastructure, unrelated route groups, schedulers and file logging
// are isolated. No notification delete implementation or success is mocked.
vi.mock("../../bootstrap/index.js", async () => {
	const { registerNativeProtectedInfrastructure } = await import(
		"./native-protected-infrastructure.js"
	);
	const { registerProtectedRoutes } = await import("../../bootstrap/protected-routes.js");
	return {
		registerInfrastructure: registerNativeProtectedInfrastructure,
		registerProtectedRoutes,
		registerPublicRoutes() {},
		registerSchedulers() {},
	};
});
vi.mock("../route-manifest.js", async () => {
	const { registerNotificationRoutes } = await import("../notifications.js");
	return {
		PROTECTED_ROUTE_GROUPS: [
			{ prefix: "/api/notifications", register: registerNotificationRoutes },
		],
	};
});
vi.mock("../../lib/logger.js", () => ({
	logger: {},
	loggers: { api: {}, auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const fixtureRoot = resolve(process.env.CHANNEL_DELETE_FIXTURE_ROOT ?? tmpdir());
const privateDetail = "synthetic-private-delete-dependency";
const target = "owned-target";
const releaseBarriers: Array<() => void> = [];
let directory: string;
let database: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;
let ownerCookie: string;
let foreignCookie: string;
let expiredCookie: string;
let unsignedCookie: string;
let invalidCookie: string;

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, "notification-channel-delete-"));
	chmodSync(directory, 0o700);
	database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// Full actual schema; explicit private DB/config, no dotenv, client generation,
	// inherited DATABASE_URL, transport, provider service or live infrastructure.
	writeFileSync(
		config,
		`import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(api, "package.json"))});
const { defineConfig } = require('prisma/config');
if (process.env.DATABASE_URL !== ${JSON.stringify(`file:${database}`)}) throw new Error('Unowned fixture database');
export default defineConfig({ schema: ${JSON.stringify(join(api, "prisma/schema.prisma"))}, datasource: { url: process.env.DATABASE_URL } });`,
		{ mode: 0o600 },
	);
	const allowedEnv = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			["PATH", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH", "SystemRoot"].includes(key),
		),
	);
	const cli = join(
		dirname(require.resolve("prisma/package.json")),
		require("prisma/package.json").bin.prisma,
	);
	execFileSync(process.execPath, [cli, "db", "push", "--config", config], {
		cwd: directory,
		env: {
			...allowedEnv,
			CI: "1",
			CHECKPOINT_DISABLE: "1",
			PRISMA_HIDE_UPDATE_MESSAGE: "1",
			DATABASE_URL: `file:${database}`,
			TMPDIR: directory,
		},
		timeout: 30_000,
		stdio: "pipe",
	});
	chmodSync(database, 0o600);
	prisma = createTestPrismaClient(database);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "foreign", username: "synthetic-foreign" },
		],
	});
}, 30_000);

beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_channel_delete"');
	await prisma.session.deleteMany({});
	await prisma.notificationRule.deleteMany({});
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	await prisma.notificationChannel.createMany({
		data: [
			{
				id: target,
				userId: "owner",
				name: "Same synthetic name",
				type: "WEBHOOK",
				encryptedConfig: "unused",
				configIv: "unused",
			},
			{
				id: "owned-same-name",
				userId: "owner",
				name: "Same synthetic name",
				type: "WEBHOOK",
				encryptedConfig: "unused",
				configIv: "unused",
			},
			{
				id: "foreign-same-name",
				userId: "foreign",
				name: "Same synthetic name",
				type: "WEBHOOK",
				encryptedConfig: "unused",
				configIv: "unused",
			},
		],
	});
	await prisma.notificationSubscription.createMany({
		data: [
			{ channelId: target, eventType: "HUNT_COMPLETED" },
			{ channelId: target, eventType: "BACKUP_FAILED" },
			{ channelId: "owned-same-name", eventType: "HUNT_COMPLETED" },
			{ channelId: "foreign-same-name", eventType: "SYSTEM_ERROR" },
		],
	});
	await prisma.notificationLog.createMany({
		data: [
			{
				id: "target-history",
				channelId: target,
				channelType: "WEBHOOK",
				eventType: "HUNT_COMPLETED",
				title: "Synthetic target history",
				body: "Synthetic body",
				status: "sent",
				error: privateDetail,
			},
			{
				id: "foreign-history",
				channelId: "foreign-same-name",
				channelType: "WEBHOOK",
				eventType: "SYSTEM_ERROR",
				title: "Synthetic foreign history",
				body: "Synthetic body",
				status: "failed",
				error: privateDetail,
			},
		],
	});
	await prisma.notificationRule.createMany({
		data: [
			{
				id: "owner-rule",
				userId: "owner",
				name: "Synthetic routing rule",
				action: "route",
				conditions: "[]",
				targetChannelIds: '["owned-target","owned-same-name"]',
			},
			{
				id: "foreign-rule",
				userId: "foreign",
				name: "Synthetic foreign rule",
				action: "route",
				conditions: "[]",
				targetChannelIds: '["foreign-same-name"]',
			},
		],
	});
	// No seeding client may retain a main-file reader during cold startup.
	await prisma.$disconnect();
	await synchronizeSqliteRuntimeSchema(`file:${database}`);
	prisma = createTestPrismaClient(database);
	app = buildServer({
		logger: false,
		env: envSchema.parse({
			NODE_ENV: "test",
			DATABASE_URL: `file:${database}`,
			ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
			SESSION_COOKIE_SECRET: "synthetic-cookie-secret-for-private-fixture",
			SESSION_COOKIE_NAME: "fixture_session",
			COOKIE_SECURE: "false",
			API_RATE_LIMIT_MAX: 10_000,
		}),
	});
	await app.ready();
	const foreign = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("foreign"),
	);
	const expired = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("owner"),
	);
	await prisma.session.updateMany({
		where: { userId: "owner" },
		data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
	});
	const owner = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("owner"),
	);
	ownerCookie = signedCookie(owner.token);
	foreignCookie = signedCookie(foreign.token);
	expiredCookie = signedCookie(expired.token);
	unsignedCookie = `fixture_session=${owner.token}`;
	invalidCookie = `${ownerCookie}invalid`;
});
async function closeServer() {
	// A rejected close must retain the native runtime reference for diagnosis.
	await app?.close();
	await app?.sessionService.drainValidations();
	app = undefined;
}
afterEach(async () => {
	for (const release of releaseBarriers.splice(0)) release();
	try {
		await closeServer();
	} finally {
		vi.restoreAllMocks();
	}
});
function removeFixtureTree() {
	if (directory) {
		expect(dirname(directory)).toBe(fixtureRoot);
		expect(basename(directory).startsWith("notification-channel-delete-")).toBe(true);
		rmSync(directory, { recursive: true, force: true });
	}
}
async function disposeFixture(remove = removeFixtureTree) {
	await closeServer();
	await prisma?.$disconnect();
	// Remove owned files only after both native and observer closure succeed.
	remove();
}
afterAll(() => disposeFixture());
function signedCookie(token: string) {
	return `fixture_session=${encodeURIComponent(app!.signCookie(token))}`;
}
function remove(id = target, cookie = ownerCookie) {
	return app!.inject({
		method: "DELETE",
		url: `/api/notifications/channels/${id}`,
		headers: cookie ? { cookie } : {},
	});
}
async function persisted() {
	return {
		channels: await prisma.notificationChannel.findMany({ orderBy: { id: "asc" } }),
		subscriptions: await prisma.notificationSubscription.findMany({
			orderBy: [{ channelId: "asc" }, { eventType: "asc" }],
		}),
		logs: await prisma.notificationLog.findMany({ orderBy: { id: "asc" } }),
		rules: await prisma.notificationRule.findMany({ orderBy: { id: "asc" } }),
	};
}
function genericFailure(response: { statusCode: number; json: () => unknown; payload: string }) {
	expect(response.statusCode).toBe(500);
	expect(response.json()).toEqual({
		statusCode: 500,
		error: "InternalServerError",
		message: "Internal server error",
	});
	expect(response.payload).not.toContain(privateDetail);
}
// Deterministic seam AFTER real owned SQL selection. The row transfer/removal
// and eventual route deletion remain actual SQLite mutations, not fake ACKs.
function afterOwnedSelection(effect: () => Promise<unknown>) {
	const select = app!.prisma.notificationChannel.findFirst.bind(app!.prisma.notificationChannel);
	// The route awaits this read; the scheduling seam does not use Prisma's
	// fluent relation methods. Narrow only its test typing, not the SQL operation.
	const reads: {
		findFirst: (args?: Parameters<typeof select>[0]) => Promise<Awaited<ReturnType<typeof select>>>;
	} = app!.prisma.notificationChannel;
	let injections = 0;
	vi.spyOn(reads, "findFirst").mockImplementation(async (args) => {
		const row = await select(args);
		if (injections === 0 && row?.id === target && args?.where?.userId === "owner") {
			injections++;
			await effect();
		}
		return row;
	});
	return () => injections;
}

describe("actual signed-session channel DELETE persisted ownership and retention", () => {
	it("retains fixture files and the native server reference when closure refuses", async () => {
		const held = app!;
		const refusal = new Error("Synthetic fixture close refusal");
		const close = vi.spyOn(held, "close").mockRejectedValueOnce(refusal);
		const disconnect = vi.spyOn(prisma, "$disconnect");
		const remove = vi.fn();
		try {
			await expect(disposeFixture(remove)).rejects.toBe(refusal);
			expect(app === held).toBe(true);
			expect(disconnect).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(existsSync(database)).toBe(true);
			expect(existsSync(`${database}.arr-restore-runtime`)).toBe(true);
		} finally {
			// A RED witness must retain/rejoin the actual fixture, never delete it.
			app = held;
			close.mockRestore();
			disconnect.mockRestore();
		}
	});
	it("deletes only selected owned ID, cascades only its subscriptions and preserves history/rules", async () => {
		const before = await persisted();
		const response = await remove();
		const after = await persisted();
		expect(response.statusCode).toBe(204);
		expect(response.payload).toBe("");
		expect(after.channels.map((row) => row.id)).toEqual(["foreign-same-name", "owned-same-name"]);
		expect(after.channels).toEqual([before.channels[0], before.channels[1]]);
		expect(after.subscriptions).toEqual([
			{ channelId: "foreign-same-name", eventType: "SYSTEM_ERROR" },
			{ channelId: "owned-same-name", eventType: "HUNT_COMPLETED" },
		]);
		expect(after.logs).toEqual(before.logs);
		expect(after.rules).toEqual(before.rules);
	});
	it.each(["foreign-same-name", "missing-target"])(
		"rejects %s without altering any persisted rows",
		async (id) => {
			const before = await persisted();
			const response = await remove(id);
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: "Channel not found" });
			expect(await persisted()).toEqual(before);
		},
	);
	it("foreign session cannot delete owner target despite same-name collision", async () => {
		const before = await persisted();
		expect((await remove(target, foreignCookie)).statusCode).toBe(404);
		expect(await persisted()).toEqual(before);
	});
	it.each(["missing", "unsigned", "bad-signature", "unknown", "expired"])(
		"rejects %s session before notification mutation",
		async (kind) => {
			const cookies: Record<string, string> = {
				missing: "",
				unsigned: unsignedCookie,
				"bad-signature": invalidCookie,
				unknown: signedCookie("synthetic-unknown-token"),
				expired: expiredCookie,
			};
			const before = await persisted();
			const response = await remove(target, cookies[kind]);
			expect(response.statusCode).toBe(401);
			expect(response.json()).toEqual({ error: "Authentication required" });
			expect(await persisted()).toEqual(before);
		},
	);
	it("rejects malformed encoded route ID before deletion", async () => {
		const before = await persisted();
		expect((await remove("%ZZ")).statusCode).toBe(400);
		expect(await persisted()).toEqual(before);
	});
	it("fails closed after a real selected row changes owner, retaining transferred relationships", async () => {
		const before = await persisted();
		const injections = afterOwnedSelection(() =>
			prisma.notificationChannel.update({ where: { id: target }, data: { userId: "foreign" } }),
		);
		const response = await remove();
		const after = await persisted();
		expect(injections()).toBe(1);
		// Persisted retention precedes status: a fake404 after deleting the row fails.
		expect(after.channels.map((row) => row.id)).toEqual([
			"foreign-same-name",
			"owned-same-name",
			"owned-target",
		]);
		expect(after.channels[2]).toMatchObject({
			id: "owned-target",
			userId: "foreign",
			name: "Same synthetic name",
		});
		expect(after.channels.slice(0, 2)).toEqual(before.channels.slice(0, 2));
		expect(after.subscriptions).toEqual(before.subscriptions);
		expect(after.logs).toEqual(before.logs);
		expect(after.rules).toEqual(before.rules);
		expect(response.statusCode).toBe(404);
	});
	it("maps genuine already-removed Prisma absence after selection to404, not false204 or500", async () => {
		const before = await persisted();
		const injections = afterOwnedSelection(() =>
			prisma.notificationChannel.delete({ where: { id: target } }),
		);
		const response = await remove();
		const after = await persisted();
		expect(injections()).toBe(1);
		expect(after.channels.map((row) => row.id)).toEqual(["foreign-same-name", "owned-same-name"]);
		expect(after.subscriptions).toEqual([
			{ channelId: "foreign-same-name", eventType: "SYSTEM_ERROR" },
			{ channelId: "owned-same-name", eventType: "HUNT_COMPLETED" },
		]);
		expect(after.logs).toEqual(before.logs);
		expect(after.rules).toEqual(before.rules);
		expect(response.statusCode).toBe(404);
	});
	it("real SQLite delete-abort rolls back target and cascades without claiming success", async () => {
		const before = await persisted();
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER "reject_channel_delete" BEFORE DELETE ON "notification_channels" WHEN OLD.id = 'owned-target' BEGIN SELECT RAISE(ABORT, '${privateDetail}'); END`,
		);
		const response = await remove();
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "DatabaseError",
			message: "Related resource not found",
		});
		expect(response.payload).not.toContain(privateDetail);
		expect(await persisted()).toEqual(before);
	});
	it("lookup dependency fault is not ownership absence or success and preserves rows", async () => {
		const before = await persisted();
		vi.spyOn(app!.prisma.notificationChannel, "findFirst").mockRejectedValueOnce(
			new Error(privateDetail),
		);
		genericFailure(await remove());
		expect(await persisted()).toEqual(before);
	});
	it("characterizes the current global plain-P2025 classifier with sanitized404 and unchanged persistence", async () => {
		const before = await persisted();
		vi.spyOn(app!.prisma.notificationChannel, "delete").mockRejectedValueOnce(
			Object.assign(new Error(privateDetail), { code: "P2025" }),
		);
		// Existing server-level duck classification is distinct from the route's
		// genuine-Prisma-instance catch; root records broader classifier follow-up.
		const response = await remove();
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "DatabaseError", message: "Record not found" });
		expect(response.payload).not.toContain(privateDetail);
		expect(await persisted()).toEqual(before);
	});
	it("confirmed repeated deletion is404 after the one real204", async () => {
		expect((await remove()).statusCode).toBe(204);
		const after = await persisted();
		expect((await remove()).statusCode).toBe(404);
		expect(await persisted()).toEqual(after);
	});
	it("two requests admitted before mutation have one204 and one404 with literal surviving rows", async () => {
		const before = await persisted();
		const select = app!.prisma.notificationChannel.findFirst.bind(app!.prisma.notificationChannel);
		const reads: {
			findFirst: (
				args?: Parameters<typeof select>[0],
			) => Promise<Awaited<ReturnType<typeof select>>>;
		} = app!.prisma.notificationChannel;
		let release!: () => void;
		const barrier = new Promise<void>((finish) => {
			release = finish;
		});
		let admitted = 0;
		releaseBarriers.push(release);
		vi.spyOn(reads, "findFirst").mockImplementation(async (args) => {
			const row = await select(args);
			if (row?.id === target && args?.where?.userId === "owner") {
				admitted++;
				if (admitted === 2) release();
				await barrier;
			}
			return row;
		});
		const responses = await Promise.all([remove(), remove()]);
		const after = await persisted();
		expect(admitted).toBe(2);
		expect(after.channels.map((row) => row.id)).toEqual(["foreign-same-name", "owned-same-name"]);
		expect(after.subscriptions).toEqual([
			{ channelId: "foreign-same-name", eventType: "SYSTEM_ERROR" },
			{ channelId: "owned-same-name", eventType: "HUNT_COMPLETED" },
		]);
		expect(after.logs).toEqual(before.logs);
		expect(after.rules).toEqual(before.rules);
		expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 404]);
	});
});
