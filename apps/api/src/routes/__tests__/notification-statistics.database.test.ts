import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

const now = new Date("2026-01-31T12:00:00.000Z");
const since = "2026-01-24T12:00:00.000Z";
const observedEmptyQueue = {
	state: "observed",
	observedAt: "2026-01-31T12:00:00.000Z",
	events: { ready: 0, deferred: 0, aggregating: 0 },
	deliveries: { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 },
	oldestDueAt: null,
};
const privateMarker = "synthetic-private-statistics-body";
const fixtureRoot = resolve(tmpdir());
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, "notification-statistics-"));
	chmodSync(directory, 0o700);
	const database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// Full real schema, but never load repository dotenv/configuration or use
	// an inherited database URL. The private CLI config owns this exact target.
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
	// Freeze Date only; Fastify, Prisma, and test waits keep their real timers.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
});

afterEach(async () => {
	vi.useRealTimers();
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
				expect(basename(directory).startsWith("notification-statistics-")).toBe(true);
				rmSync(directory, { recursive: true, force: true });
			}
		}
	}
});

function get(query = "?days=7") {
	return app!.inject({
		method: "GET",
		url: `/statistics${query}`,
		headers: { "x-test-auth": "1" },
	});
}

function log(
	id: string,
	sentAt: string,
	status = "sent",
	channelId = "owned",
	eventType = "HUNT_COMPLETED",
) {
	return {
		id,
		channelId,
		channelType: "DISCORD",
		eventType,
		title: privateMarker,
		body: privateMarker,
		error: privateMarker,
		status,
		sentAt: new Date(sentAt),
	};
}

describe("registered notification statistics route against persisted delivery rows", () => {
	// Removing either date bound or the owned-channel filter must change these
	// literal results; no mock bypasses the real query/serialization boundary.
	it("does not classify an unfamiliar persisted status as confirmed channel or daily failure", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("known-sent", "2026-01-25T09:00:00.000Z"),
				log("known-failed", "2026-01-25T10:00:00.000Z", "failed"),
				log("known-dead", "2026-01-25T11:00:00.000Z", "dead_letter"),
				log("unclassified", "2026-01-25T12:00:00.000Z", "legacy_pending"),
				log("foreign-unknown", "2026-01-25T12:00:00.000Z", "legacy_pending", "foreign"),
				log("future-unknown", "2026-01-31T12:00:00.001Z", "legacy_pending"),
			],
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		const stats = response.json();
		// One sent and two confirmed unsuccessful outcomes; the fourth owned row
		// has no classified outcome. Its event remains visible without guessing.
		expect.soft(stats.totals).toEqual({
			sent: 1,
			failed: 1,
			deadLetter: 1,
			unclassified: 1,
			total: 4,
			successRate: 33.33,
		});
		expect(stats.perEventType).toEqual([{ eventType: "HUNT_COMPLETED", count: 4 }]);
		expect.soft(stats.perChannel).toEqual([
			{
				channelId: "owned",
				channelType: "DISCORD",
				sent: 1,
				failed: 2,
				unclassified: 1,
				successRate: 33.33,
			},
		]);
		expect
			.soft(stats.dailyTrend)
			.toEqual([{ date: "2026-01-25", sent: 1, failed: 2, unclassified: 1 }]);
		expect(response.payload).not.toContain(privateMarker);
	});

	it("does not turn unknown-only history into confirmed failures", async () => {
		await prisma.notificationLog.create({
			data: log("unclassified-only", "2026-01-25T12:00:00.000Z", "legacy_pending"),
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		const stats = response.json();
		expect
			.soft(stats.totals)
			.toEqual({ sent: 0, failed: 0, deadLetter: 0, unclassified: 1, total: 1, successRate: 0 });
		expect(stats.perEventType).toEqual([{ eventType: "HUNT_COMPLETED", count: 1 }]);
		expect.soft(stats.perChannel[0].failed).toBe(0);
		expect.soft(stats.dailyTrend[0].failed).toBe(0);
		expect.soft(stats.perChannel[0].unclassified).toBe(1);
		expect.soft(stats.dailyTrend[0].unclassified).toBe(1);
		expect(response.payload).not.toContain(privateMarker);
	});

	it("excludes future rows beyond the advertised until, including the millisecond edge", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("now", "2026-01-31T12:00:00.000Z"),
				log("future-edge", "2026-01-31T12:00:00.001Z", "failed"),
				log("future-day", "2026-02-01T00:00:00.000Z", "dead_letter"),
			],
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			queue: observedEmptyQueue,
			period: { days: 7, since, until: "2026-01-31T12:00:00.000Z" },
			totals: { sent: 1, failed: 0, deadLetter: 0, unclassified: 0, total: 1, successRate: 100 },
			perChannel: [
				{
					channelId: "owned",
					channelType: "DISCORD",
					sent: 1,
					failed: 0,
					unclassified: 0,
					successRate: 100,
				},
			],
			perEventType: [{ eventType: "HUNT_COMPLETED", count: 1 }],
			dailyTrend: [{ date: "2026-01-31", sent: 1, failed: 0, unclassified: 0 }],
		});
		expect(response.payload).not.toContain(privateMarker);
	});

	it("includes the lower edge and returns hand-counted owned outcomes without payloads", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("before", "2026-01-24T11:59:59.999Z"),
				log("edge", since),
				log("sent", "2026-01-25T09:00:00.000Z"),
				log("failed", "2026-01-25T10:00:00.000Z", "failed"),
				log("dead", "2026-01-25T11:00:00.000Z", "dead_letter", "owned", "BACKUP_FAILED"),
				log("foreign", "2026-01-25T12:00:00.000Z", "sent", "foreign"),
			],
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			queue: observedEmptyQueue,
			period: { days: 7, since, until: "2026-01-31T12:00:00.000Z" },
			totals: { sent: 2, failed: 1, deadLetter: 1, unclassified: 0, total: 4, successRate: 50 },
			perChannel: [
				{
					channelId: "owned",
					channelType: "DISCORD",
					sent: 2,
					failed: 2,
					unclassified: 0,
					successRate: 50,
				},
			],
			perEventType: [
				{ eventType: "HUNT_COMPLETED", count: 3 },
				{ eventType: "BACKUP_FAILED", count: 1 },
			],
			dailyTrend: [
				{ date: "2026-01-24", sent: 1, failed: 0, unclassified: 0 },
				{ date: "2026-01-25", sent: 1, failed: 2, unclassified: 0 },
			],
		});
		expect(response.payload).not.toContain(privateMarker);
	});

	it("returns authoritative empty aggregates when an owned channel has no rows", async () => {
		await prisma.notificationLog.create({
			data: log("foreign", "2026-01-25T12:00:00.000Z", "sent", "foreign"),
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json().totals).toEqual({
			sent: 0,
			failed: 0,
			deadLetter: 0,
			unclassified: 0,
			total: 0,
			successRate: 0,
		});
		expect(response.json().perChannel).toEqual([]);
		expect(response.json().perEventType).toEqual([]);
		expect(response.json().dailyTrend).toEqual([]);
	});

	it("with no owned channels returns empty without querying unrelated delivery history", async () => {
		await prisma.notificationChannel.deleteMany({ where: { userId: "owner" } });
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "notification_logs" RENAME TO "fixture_hidden_logs"',
		);
		try {
			const response = await get();
			expect(response.statusCode).toBe(200);
			expect(response.json().totals.total).toBe(0);
			expect(response.json().perChannel).toEqual([]);
		} finally {
			await prisma.$executeRawUnsafe(
				'ALTER TABLE "fixture_hidden_logs" RENAME TO "notification_logs"',
			);
		}
	});

	it("database read failure is an error, not fabricated zero-success statistics", async () => {
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "notification_logs" RENAME TO "fixture_hidden_logs"',
		);
		try {
			const response = await get();
			expect(response.statusCode).toBe(500);
			expect(response.json()).toEqual({ error: "Internal Server Error" });
		} finally {
			await prisma.$executeRawUnsafe(
				'ALTER TABLE "fixture_hidden_logs" RENAME TO "notification_logs"',
			);
		}
	});

	it.each(["0", "366", "1.5", "invalid", "-1"])("rejects invalid days=%s", async (days) => {
		const response = await get(`?days=${days}`);
		expect(response.statusCode).toBe(400);
		expect(response.json()).not.toHaveProperty("totals");
	});

	it("uses the default 30-day window when the query is omitted", async () => {
		await prisma.notificationLog.createMany({
			data: [
				log("included", "2026-01-05T12:00:00.000Z"),
				log("too-old", "2026-01-01T11:59:59.999Z"),
			],
		});
		const response = await get("");
		expect(response.statusCode).toBe(200);
		expect(response.json().period).toEqual({
			days: 30,
			since: "2026-01-01T12:00:00.000Z",
			until: "2026-01-31T12:00:00.000Z",
		});
		expect(response.json().totals).toEqual({
			sent: 1,
			failed: 0,
			deadLetter: 0,
			unclassified: 0,
			total: 1,
			successRate: 100,
		});
	});

	it.each([
		[7, 1],
		[14, 2],
		[30, 3],
		[90, 4],
	])("applies the selected %i-day window to real persisted rows", async (days, sent) => {
		await prisma.notificationLog.createMany({
			data: [
				log("within-week", "2026-01-30T12:00:00.000Z"),
				log("within-fortnight", "2026-01-21T12:00:00.000Z"),
				log("within-month", "2026-01-11T12:00:00.000Z"),
				log("within-quarter", "2025-12-02T12:00:00.000Z"),
			],
		});
		const response = await get(`?days=${days}`);
		expect(response.statusCode).toBe(200);
		expect(response.json().period.days).toBe(days);
		expect(response.json().totals).toEqual({
			sent,
			failed: 0,
			deadLetter: 0,
			unclassified: 0,
			total: sent,
			successRate: 100,
		});
	});
});
