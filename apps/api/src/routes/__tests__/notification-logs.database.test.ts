import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

const fixtureRoot = resolve(tmpdir());
const privateError = "synthetic-private-delivery-error";
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, "notification-history-"));
	chmodSync(directory, 0o700);
	const database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// The CLI uses the full actual schema but no repository dotenv or inherited
	// database URL. This exact private target is also used by the real client.
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
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	await prisma.notificationChannel.createMany({
		data: [
			{
				id: "owned",
				userId: "owner",
				name: "Synthetic",
				type: "DISCORD",
				encryptedConfig: "unused",
				configIv: "unused",
			},
			{
				id: "owned-second",
				userId: "owner",
				name: "Synthetic second",
				type: "DISCORD",
				encryptedConfig: "unused",
				configIv: "unused",
			},
			{
				id: "foreign",
				userId: "foreign",
				name: "Synthetic foreign",
				type: "DISCORD",
				encryptedConfig: "unused",
				configIv: "unused",
			},
		],
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
	app = undefined;
});

afterAll(async () => {
	try {
		await app?.close();
	} finally {
		try {
			await prisma?.$disconnect();
		} finally {
			if (directory) {
				expect(dirname(directory)).toBe(fixtureRoot);
				expect(basename(directory).startsWith("notification-history-")).toBe(true);
				rmSync(directory, { recursive: true, force: true });
			}
		}
	}
});

function get(query = "") {
	return app!.inject({ method: "GET", url: `/logs${query}`, headers: { "x-test-auth": "1" } });
}

function log(
	id: string,
	minute: number,
	status = "sent",
	channelId = "owned",
	eventType = "HUNT_COMPLETED",
) {
	return {
		id,
		channelId,
		channelType: "DISCORD",
		eventType,
		title: `Synthetic ${id}`,
		body: `Synthetic body ${id}`,
		status,
		error: privateError,
		retryCount: 2,
		sentAt: new Date(`2026-01-31T12:${String(minute).padStart(2, "0")}:00.000Z`),
	};
}

function ids(response: { json: () => { logs: Array<{ id: string }> } }) {
	return response.json().logs.map((row) => row.id);
}

describe("registered notification history against persisted delivery rows", () => {
	// Removing the owner predicate, sort, skip/take or a filter changes these
	// literal results. No mock bypasses actual SQL or route serialization.
	it("paginates newest-first owned rows and counts the same scoped inventory", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("oldest", 1),
				log("middle", 2, "failed", "owned-second"),
				log("newest", 3),
				log("foreign", 4, "sent", "foreign"),
			],
		});
		const first = await get("?page=1&limit=2");
		expect(first.statusCode).toBe(200);
		expect(ids(first)).toEqual(["newest", "middle"]);
		expect(first.json()).toMatchObject({ total: 3, page: 1, limit: 2 });
		const second = await get("?page=2&limit=2");
		expect(ids(second)).toEqual(["oldest"]);
		expect(second.json()).toMatchObject({ total: 3, page: 2, limit: 2 });
		expect(first.payload + second.payload).not.toContain("Synthetic foreign");
	});

	it("returns a positive total with no rows on an out-of-range page, without clamping", async () => {
		await prisma.notificationLog.createMany({ data: [log("one", 1), log("two", 2)] });
		const response = await get("?page=3&limit=1");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ logs: [], total: 2, page: 3, limit: 1 });
	});

	it("uses page 1 and limit 50 when omitted", async () => {
		await prisma.notificationLog.createMany({ data: [log("one", 1), log("two", 2)] });
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(ids(response)).toEqual(["two", "one"]);
		expect(response.json()).toMatchObject({ total: 2, page: 1, limit: 50 });
	});

	it("combines owned channel, status, event and inclusive date bounds", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("before", 1, "failed"),
				log("lower", 2, "failed"),
				log("upper", 3, "failed"),
				log("after", 4, "failed"),
				log("wrong-status", 2),
				log("wrong-event", 2, "failed", "owned", "BACKUP_FAILED"),
				log("other-owned", 2, "failed", "owned-second"),
				log("foreign", 2, "failed", "foreign"),
			],
		});
		const response = await get(
			"?page=1&limit=15&channelId=owned&status=failed&eventType=HUNT_COMPLETED&since=2026-01-31T12%3A02%3A00.000Z&until=2026-01-31T12%3A03%3A00.000Z",
		);
		expect(response.statusCode).toBe(200);
		expect(ids(response)).toEqual(["upper", "lower"]);
		expect(response.json()).toMatchObject({ total: 2, page: 1, limit: 15 });
	});

	it.each([
		["sent", ["sent"]],
		["failed", ["failed"]],
		["dead_letter", ["dead"]],
	])("filters %s delivery outcomes", async (status, expected) => {
		await prisma.notificationLog.createMany({
			data: [log("sent", 1), log("failed", 2, "failed"), log("dead", 3, "dead_letter")],
		});
		const response = await get(`?status=${status}`);
		expect(response.statusCode).toBe(200);
		expect(ids(response)).toEqual(expected);
		expect(response.json().total).toBe(1);
	});

	it.each(["foreign", "missing"])(
		"returns no history for inaccessible channel %s",
		async (channel) => {
			await prisma.notificationLog.createMany({
				data: [log("owned", 1), log("foreign", 2, "sent", "foreign")],
			});
			const response = await get(`?channelId=${channel}&page=2&limit=15`);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ logs: [], total: 0, page: 2, limit: 15 });
		},
	);

	it("returns genuine zero-total empty results, including no owned channels", async () => {
		await prisma.notificationLog.createMany({ data: [log("foreign", 1, "sent", "foreign")] });
		await prisma.notificationChannel.deleteMany({ where: { userId: "owner" } });
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ logs: [], total: 0, page: 1, limit: 50 });
	});

	it("sanitizes historical delivery errors without dropping authorized log fields", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("sent", 1),
				log("failed", 2, "failed"),
				{ ...log("null", 3, "failed"), error: null },
			],
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json().logs).toEqual([
			{
				id: "null",
				channelId: "owned",
				channelType: "DISCORD",
				eventType: "HUNT_COMPLETED",
				title: "Synthetic null",
				body: "Synthetic body null",
				status: "failed",
				error: null,
				retryCount: 2,
				sentAt: "2026-01-31T12:03:00.000Z",
			},
			{
				id: "failed",
				channelId: "owned",
				channelType: "DISCORD",
				eventType: "HUNT_COMPLETED",
				title: "Synthetic failed",
				body: "Synthetic body failed",
				status: "failed",
				error: "Delivery was not confirmed. Check channel settings and provider availability.",
				retryCount: 2,
				sentAt: "2026-01-31T12:02:00.000Z",
			},
			{
				id: "sent",
				channelId: "owned",
				channelType: "DISCORD",
				eventType: "HUNT_COMPLETED",
				title: "Synthetic sent",
				body: "Synthetic body sent",
				status: "sent",
				error: null,
				retryCount: 2,
				sentAt: "2026-01-31T12:01:00.000Z",
			},
		]);
		expect(response.payload).not.toContain(privateError);
	});

	it.each(["since", "until"])(
		"rejects malformed %s rather than silently widening the history",
		async (field) => {
			await prisma.notificationLog.create({ data: log("must-not-leak-through-invalid-filter", 1) });
			const response = await get(`?${field}=synthetic-invalid-date`);
			expect(response.statusCode).toBe(400);
			expect(response.json()).not.toHaveProperty("logs");
			expect(response.payload).not.toContain("Synthetic must-not-leak");
		},
	);

	it.each(["since", "until"])(
		"rejects an explicitly empty %s instead of dropping the bound",
		async (field) => {
			const response = await get(`?${field}=`);
			expect(response.statusCode).toBe(400);
			expect(response.json()).not.toHaveProperty("logs");
		},
	);

	it("preserves previously accepted parseable date-only bounds", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("included", 1),
				{ ...log("too-old", 2), sentAt: new Date("2026-01-30T12:00:00Z") },
			],
		});
		const response = await get("?since=2026-01-31&until=2026-02-01");
		expect(response.statusCode).toBe(200);
		expect(ids(response)).toEqual(["included"]);
		expect(response.json().total).toBe(1);
	});

	it.each([
		"page=0",
		"page=-1",
		"page=1.5",
		"page=invalid",
		"limit=0",
		"limit=101",
		"limit=1.5",
		"status=invalid",
	])("rejects invalid query %s", async (query) => {
		const response = await get(`?${query}`);
		expect(response.statusCode).toBe(400);
		expect(response.json()).not.toHaveProperty("logs");
	});

	it("read failure stays an error and a subsequent GET recovers without modifying delivery rows", async () => {
		await prisma.notificationLog.create({ data: log("retained", 1) });
		const before = await prisma.notificationLog.findMany();
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "notification_logs" RENAME TO "fixture_hidden_logs"',
		);
		try {
			const failed = await get();
			expect(failed.statusCode).toBe(500);
			expect(failed.json()).toEqual({ error: "Internal Server Error" });
		} finally {
			await prisma.$executeRawUnsafe(
				'ALTER TABLE "fixture_hidden_logs" RENAME TO "notification_logs"',
			);
		}
		const recovered = await get();
		expect(recovered.statusCode).toBe(200);
		expect(ids(recovered)).toEqual(["retained"]);
		expect(await prisma.notificationLog.findMany()).toEqual(before);
	});
});
