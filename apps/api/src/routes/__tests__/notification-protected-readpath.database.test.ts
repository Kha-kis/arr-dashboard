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

// Isolate startup side effects, not the actual server's inline session hook,
// error handler, protected gate, cookie signing, session SQL or notification SQL.
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

// envSchema's boolean parser imports loggers.api; prevent filesystem logging
// at module load. buildServer({ logger: false }) keeps Fastify's own null logger.
vi.mock("../../lib/logger.js", () => ({
	logger: {},
	loggers: { api: {}, auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const fixtureRoot = resolve(tmpdir());
const now = new Date("2026-01-31T12:00:00.000Z");
const privateMarker = "synthetic-private-read-dependency";
const routes = ["logs", "statistics"] as const;
let directory: string;
let database: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;
let ownerCookie: string;
let foreignCookie: string;
let expiredCookie: string;
let unsignedCookie: string;
let badSignatureCookie: string;

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, "notification-protected-readpath-"));
	chmodSync(directory, 0o700);
	database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// Full actual schema, explicit private DB, no repository dotenv/config load,
	// client generation, inherited DATABASE_URL, or live infrastructure.
	writeFileSync(
		config,
		`import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(api, "package.json"))});
const { defineConfig } = require('prisma/config');
if (process.env.DATABASE_URL !== ${JSON.stringify(`file:${database}`)}) throw new Error('Unowned fixture database');
export default defineConfig({ schema: ${JSON.stringify(join(api, "prisma/schema.prisma"))}, datasource: { url: process.env.DATABASE_URL } });`,
		{ mode: 0o600 },
	);
	const env = Object.fromEntries(
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
			...env,
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
	await prisma.session.deleteMany({});
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	await prisma.notificationChannel.createMany({
		data: [
			{
				id: "owned-channel",
				userId: "owner",
				name: "Synthetic owned",
				type: "DISCORD",
				encryptedConfig: "unused",
				configIv: "unused",
			},
			{
				id: "foreign-channel",
				userId: "foreign",
				name: "Synthetic foreign",
				type: "DISCORD",
				encryptedConfig: "unused",
				configIv: "unused",
			},
		],
	});
	await prisma.notificationLog.createMany({
		data: [
			log("owned-old", "2026-01-30T10:00:00.000Z"),
			log("owned-new", "2026-01-30T11:00:00.000Z", "failed"),
			log("foreign-log", "2026-01-30T12:00:00.000Z", "dead_letter", "foreign-channel"),
		],
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
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
		data: { expiresAt: new Date("2026-01-30T12:00:00.000Z") },
	});
	// Create the independent active owner session after expiring its predecessor.
	const activeOwner = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("owner"),
	);
	ownerCookie = signedCookie(activeOwner.token);
	foreignCookie = signedCookie(foreign.token);
	expiredCookie = signedCookie(expired.token);
	unsignedCookie = `fixture_session=${activeOwner.token}`;
	badSignatureCookie = `${ownerCookie}invalid`;
});

async function closeFixtureServer() {
	// A rejected close must retain the native runtime reference for diagnosis.
	await app?.close();
	await app?.sessionService.drainValidations();
	app = undefined;
}

afterEach(async () => {
	try {
		await closeFixtureServer();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

function removeFixtureTree() {
	if (directory) {
		expect(dirname(directory)).toBe(fixtureRoot);
		expect(basename(directory).startsWith("notification-protected-readpath-")).toBe(true);
		rmSync(directory, { recursive: true, force: true });
	}
}
async function disposeFixture(remove = removeFixtureTree) {
	await closeFixtureServer();
	await prisma?.$disconnect();
	// Remove owned files only after both native and observer closure succeed.
	remove();
}
afterAll(() => disposeFixture());

function signedCookie(token: string) {
	return `fixture_session=${encodeURIComponent(app!.signCookie(token))}`;
}

function log(id: string, sentAt: string, status = "sent", channelId = "owned-channel") {
	return {
		id,
		channelId,
		channelType: "DISCORD",
		eventType: "HUNT_COMPLETED",
		title: `Synthetic ${id}`,
		body: `Synthetic body ${id}`,
		error: privateMarker,
		status,
		sentAt: new Date(sentAt),
	};
}

function get(route: (typeof routes)[number], cookie = ownerCookie, query = "") {
	return app!.inject({
		method: "GET",
		url: `/api/notifications/${route}${query}`,
		headers: cookie ? { cookie } : {},
	});
}

function assertGenericFailure(response: {
	statusCode: number;
	json: () => unknown;
	payload: string;
}) {
	expect(response.statusCode).toBe(500);
	expect(response.json()).toEqual({
		statusCode: 500,
		error: "InternalServerError",
		message: "Internal server error",
	});
	expect(response.payload).not.toContain(privateMarker);
}

describe("actual server notification session-to-owner read and error boundary", () => {
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
	// These cases catch a weakened protected gate or unsigned/expired session
	// admission. Call-through spies establish that 401 precedes notification SQL.
	for (const route of routes) {
		it.each(["missing", "bad-signature", "unsigned", "unknown", "expired"])(
			`rejects %s cookie before ${route} reads`,
			async (kind) => {
				const channelRead = vi.spyOn(app!.prisma.notificationChannel, "findMany");
				const logRead = vi.spyOn(app!.prisma.notificationLog, "findMany");
				const logCount = vi.spyOn(app!.prisma.notificationLog, "count");
				const cookies: Record<string, string> = {
					missing: "",
					"bad-signature": badSignatureCookie,
					unsigned: unsignedCookie,
					unknown: signedCookie("synthetic-unknown-session"),
					expired: expiredCookie,
				};
				const response = await get(route, cookies[kind]);
				expect(response.statusCode).toBe(401);
				expect(response.json()).toEqual({ error: "Authentication required" });
				expect(channelRead).not.toHaveBeenCalled();
				expect(logRead).not.toHaveBeenCalled();
				expect(logCount).not.toHaveBeenCalled();
			},
		);
	}

	it.each(routes)(
		"rejects header and query identity claims without a session for %s",
		async (route) => {
			const channelRead = vi.spyOn(app!.prisma.notificationChannel, "findMany");
			const response = await app!.inject({
				method: "GET",
				url: `/api/notifications/${route}?userId=owner&ownerId=owner&instanceId=synthetic-instance`,
				headers: {
					"x-test-auth": "1",
					"x-user-id": "owner",
					"x-instance-id": "synthetic-instance",
				},
			});
			expect(response.statusCode).toBe(401);
			expect(response.json()).toEqual({ error: "Authentication required" });
			expect(channelRead).not.toHaveBeenCalled();
		},
	);

	// Removing the route's owner predicate, pagination or error projection changes
	// these literal HTTP responses against persisted owned and foreign evidence.
	it("returns paginated owned History and sanitizes delivery errors through real session admission", async () => {
		const first = await get("logs", ownerCookie, "?page=1&limit=1");
		expect(first.statusCode).toBe(200);
		expect(first.json()).toEqual({
			logs: [
				{
					id: "owned-new",
					channelId: "owned-channel",
					channelType: "DISCORD",
					eventType: "HUNT_COMPLETED",
					title: "Synthetic owned-new",
					body: "Synthetic body owned-new",
					status: "failed",
					error: "Delivery was not confirmed. Check channel settings and provider availability.",
					retryCount: 0,
					sentAt: "2026-01-30T11:00:00.000Z",
				},
			],
			total: 2,
			page: 1,
			limit: 1,
		});
		const second = await get("logs", ownerCookie, "?page=2&limit=1");
		expect(second.statusCode).toBe(200);
		expect(second.json()).toMatchObject({ total: 2, page: 2, limit: 1 });
		expect(second.json().logs.map((row: { id: string }) => row.id)).toEqual(["owned-old"]);
		expect(first.payload + second.payload).not.toContain("foreign-log");
		expect(first.payload + second.payload).not.toContain(privateMarker);
		const inaccessible = await get("logs", ownerCookie, "?channelId=foreign-channel");
		expect(inaccessible.statusCode).toBe(200);
		expect(inaccessible.json()).toEqual({ logs: [], total: 0, page: 1, limit: 50 });
	});

	it("returns literal owned Statistics without notification payloads or foreign evidence", async () => {
		const response = await get(
			"statistics",
			ownerCookie,
			"?days=7&userId=foreign&channelId=foreign-channel",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			period: { days: 7, since: "2026-01-24T12:00:00.000Z", until: "2026-01-31T12:00:00.000Z" },
			totals: { sent: 1, failed: 1, deadLetter: 0, total: 2, successRate: 50, unclassified: 0 },
			perChannel: [
				{
					channelId: "owned-channel",
					channelType: "DISCORD",
					sent: 1,
					failed: 1,
					successRate: 50,
					unclassified: 0,
				},
			],
			perEventType: [{ eventType: "HUNT_COMPLETED", count: 2 }],
			dailyTrend: [{ date: "2026-01-30", sent: 1, failed: 1, unclassified: 0 }],
			queue: {
				state: "observed",
				observedAt: "2026-01-31T12:00:00.000Z",
				oldestDueAt: null,
				events: { ready: 0, deferred: 0, aggregating: 0 },
				deliveries: { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 },
			},
		});
		expect(response.payload).not.toContain(privateMarker);
		expect(response.payload).not.toContain("Synthetic");
		expect(response.payload).not.toContain("foreign-channel");
	});

	it("isolates interleaved independently signed owners and a following anonymous request", async () => {
		const [ownerHistory, foreignStats, foreignHistory, ownerStats] = await Promise.all([
			get("logs", ownerCookie),
			get("statistics", foreignCookie),
			get("logs", foreignCookie),
			get("statistics", ownerCookie),
		]);
		for (const response of [ownerHistory, foreignStats, foreignHistory, ownerStats]) {
			expect(response.statusCode).toBe(200);
		}
		expect(ownerHistory.json().logs.map((row: { id: string }) => row.id)).toEqual([
			"owned-new",
			"owned-old",
		]);
		expect(foreignHistory.json().logs.map((row: { id: string }) => row.id)).toEqual([
			"foreign-log",
		]);
		expect(ownerStats.json().totals).toEqual({
			sent: 1,
			failed: 1,
			deadLetter: 0,
			total: 2,
			successRate: 50,
			unclassified: 0,
		});
		expect(foreignStats.json().totals).toEqual({
			sent: 0,
			failed: 0,
			deadLetter: 1,
			total: 1,
			successRate: 0,
			unclassified: 0,
		});
		expect(foreignStats.json().perChannel).toEqual([
			{
				channelId: "foreign-channel",
				channelType: "DISCORD",
				sent: 0,
				failed: 1,
				successRate: 0,
				unclassified: 0,
			},
		]);
		const anonymous = await get("logs", "");
		expect(anonymous.statusCode).toBe(401);
		expect(anonymous.json()).toEqual({ error: "Authentication required" });
	});

	// A route validation bypass or replacement error handler would change the
	// public category/field-error shape, even though auth itself still succeeds.
	it.each([
		["logs", "?since=synthetic-invalid-date", "since"],
		["logs", "?until=", "until"],
		["statistics", "?days=0", "days"],
		["statistics", "?days=366", "days"],
	] as const)("serializes actual application validation for %s %s", async (route, query, field) => {
		const channelRead = vi.spyOn(app!.prisma.notificationChannel, "findMany");
		const response = await get(route, ownerCookie, query);
		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			error: "ZodValidationError",
			message: "Invalid payload",
			details: { formErrors: [], fieldErrors: { [field]: expect.any(Array) } },
		});
		expect(response.json().details.fieldErrors[field].length).toBeGreaterThan(0);
		expect(response.payload).not.toContain("synthetic-invalid-date");
		expect(channelRead).not.toHaveBeenCalled();
	});

	for (const route of routes) {
		it(`contains a one-shot session lookup failure and recovers ${route} with real SQL`, async () => {
			vi.spyOn(app!.prisma.session, "findUnique").mockRejectedValueOnce(new Error(privateMarker));
			assertGenericFailure(await get(route));
			const recovery = await get(route);
			expect(recovery.statusCode).toBe(200);
			expect(route === "logs" ? recovery.json().total : recovery.json().totals.total).toBe(2);
		});

		it(`contains a one-shot notification query failure and recovers ${route} with real SQL`, async () => {
			vi.spyOn(app!.prisma.notificationLog, "findMany").mockRejectedValueOnce(
				new Error(privateMarker),
			);
			assertGenericFailure(await get(route));
			const recovery = await get(route);
			expect(recovery.statusCode).toBe(200);
			expect(route === "logs" ? recovery.json().total : recovery.json().totals.total).toBe(2);
		});

		it(`maps a known Prisma query failure without leaking details and recovers ${route}`, async () => {
			vi.spyOn(app!.prisma.notificationLog, "findMany").mockRejectedValueOnce(
				Object.assign(new Error(privateMarker), { code: "P2025" }),
			);
			const response = await get(route);
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: "DatabaseError", message: "Record not found" });
			expect(response.payload).not.toContain(privateMarker);
			const recovery = await get(route);
			expect(recovery.statusCode).toBe(200);
			expect(route === "logs" ? recovery.json().total : recovery.json().totals.total).toBe(2);
		});
	}
});
