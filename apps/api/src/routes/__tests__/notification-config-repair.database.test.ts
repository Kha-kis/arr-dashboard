import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { NotificationChannelType } from "@arr/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { DedupGate } from "../../lib/notifications/dedup-gate.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../lib/notifications/notification-service.js";
import { RetryHandler } from "../../lib/notifications/retry-handler.js";
import type { Prisma, PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

const secret = "synthetic-private-repair-secret";
const encryptor = new Encryptor(Buffer.alloc(32, 83).toString("base64"));
const proof = new Date("2026-01-01T00:00:00Z");
const fixtures: Array<{ type: NotificationChannelType; config: Record<string, unknown> }> = [
	{ type: "DISCORD", config: { webhookUrl: `https://synthetic.invalid/${secret}` } },
	{ type: "SLACK", config: { webhookUrl: `https://synthetic.invalid/${secret}` } },
	{ type: "TELEGRAM", config: { botToken: secret, chatId: "synthetic-chat" } },
	{
		type: "EMAIL",
		config: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: secret,
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
	},
	{
		type: "BROWSER_PUSH",
		config: { endpoint: `https://synthetic.invalid/${secret}`, p256dh: secret, auth: secret },
	},
	{ type: "PUSHBULLET", config: { apiToken: secret } },
	{ type: "PUSHOVER", config: { userKey: secret, apiToken: secret } },
	{ type: "GOTIFY", config: { serverUrl: "https://synthetic.invalid", appToken: secret } },
	{ type: "NTFY", config: { serverUrl: "https://synthetic.invalid", topic: "synthetic-topic" } },
	{ type: "WEBHOOK", config: { url: `https://synthetic.invalid/${secret}`, method: "POST" } },
];
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let service: NotificationService;
let retry: RetryHandler;
let dedup: DedupGate;
let logs: string[];
let externalCalls: number;
const guards: string[] = [];

beforeAll(async () => {
	directory = mkdtempSync(
		join(resolve(process.env.CONFIG_REPAIR_FIXTURE_ROOT ?? tmpdir()), "config-repair-"),
	);
	chmodSync(directory, 0o700);
	const database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	writeFileSync(
		config,
		`import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(api, "package.json"))});
const { defineConfig } = require('prisma/config');
if (process.env.DATABASE_URL !== ${JSON.stringify(`file:${database}`)}) throw new Error('Unowned fixture');
export default defineConfig({ schema: ${JSON.stringify(join(api, "prisma/schema.prisma"))}, datasource: { url: process.env.DATABASE_URL } });`,
		{ mode: 0o600 },
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			["PATH", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH", "SystemRoot"].includes(key),
		),
	);
	execFileSync(
		process.execPath,
		[
			join(
				dirname(require.resolve("prisma/package.json")),
				require("prisma/package.json").bin.prisma,
			),
			"db",
			"push",
			"--config",
			config,
		],
		{
			cwd: directory,
			env: {
				...env,
				CI: "1",
				CHECKPOINT_DISABLE: "1",
				DATABASE_URL: `file:${database}`,
				TMPDIR: directory,
			},
			timeout: 30000,
			stdio: "pipe",
		},
	);
	chmodSync(database, 0o600);
	prisma = createTestPrismaClient(database);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "foreign", username: "synthetic-foreign" },
		],
	});
}, 30000);
beforeEach(async () => {
	for (const name of guards.splice(0))
		await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}"`);
	await prisma.notificationRule.deleteMany({});
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	logs = [];
	externalCalls = 0;
	await mount();
});
afterEach(async () => {
	await app?.close();
	await service?.shutdown();
	await retry?.flush();
	dedup?.destroy();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
async function mount(client = prisma) {
	await app?.close();
	await service?.shutdown();
	await retry?.flush();
	dedup?.destroy();
	const logger: FastifyBaseLogger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => logs.push(line) },
	);
	app = Fastify({ loggerInstance: logger });
	app.decorate("prisma", client);
	app.decorate("encryptor", encryptor);
	// Replace only external senders; the service, routes, encryption and SQL stay real.
	const dispatcher = new NotificationDispatcher();
	for (const { type } of fixtures)
		dispatcher.registerSender(type, {
			test: async () => {
				externalCalls++;
				throw new Error("Unexpected Test");
			},
			send: async () => {
				externalCalls++;
				throw new Error("Unexpected send");
			},
		});
	dedup = new DedupGate(60_000);
	retry = new RetryHandler(
		(type, config, payload) => dispatcher.send(type, config, payload),
		(...args) => service.logDelivery(...args),
		logger,
	);
	service = new NotificationService(
		client,
		encryptor,
		dispatcher,
		logger,
		dedup,
		retry,
		"https://synthetic.invalid",
	);
	app.decorate("notificationService", service);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
}
async function seed(
	type: NotificationChannelType = "WEBHOOK",
	config: unknown = {
		url: "https://synthetic.invalid/original",
		headers: { Authorization: secret },
		secret,
	},
	id = "owned",
	userId = "owner",
) {
	const encrypted = encryptor.encrypt(typeof config === "string" ? config : JSON.stringify(config));
	return prisma.notificationChannel.create({
		data: {
			id,
			userId,
			name: "Synthetic same-name channel",
			type,
			enabled: false,
			encryptedConfig: encrypted.value,
			configIv: encrypted.iv,
			lastTestedAt: proof,
			lastTestResult: "success",
			lastSentAt: proof,
			lastSendResult: "failed",
		},
	});
}
async function populate() {
	await seed("WEBHOOK", { url: "https://synthetic.invalid/foreign" }, "foreign-channel", "foreign");
	await prisma.notificationSubscription.create({
		data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
	});
	await prisma.notificationRule.create({
		data: {
			id: "rule",
			userId: "owner",
			name: "Synthetic",
			action: "route",
			conditions: "[]",
			targetChannelIds: '["owned"]',
		},
	});
	await prisma.notificationLog.create({
		data: {
			id: "history",
			channelId: "owned",
			channelType: "WEBHOOK",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic",
			body: "Synthetic",
			status: "sent",
		},
	});
}
async function snapshot() {
	return {
		channels: await prisma.notificationChannel.findMany({ orderBy: { id: "asc" } }),
		subscriptions: await prisma.notificationSubscription.findMany(),
		rules: await prisma.notificationRule.findMany(),
		history: await prisma.notificationLog.findMany(),
		users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
	};
}
const row = () => prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
const read = (id = "owned") =>
	app.inject({ method: "GET", url: `/channels/${id}/edit-state`, headers: { "x-test-auth": "1" } });
const save = (config: Record<string, unknown>, expectedRevision: string, id = "owned") =>
	app.inject({
		method: "PUT",
		url: `/channels/${id}`,
		headers: { "x-test-auth": "1" },
		payload: { config, expectedRevision },
	});
async function corrupt() {
	await prisma.notificationChannel.update({
		where: { id: "owned" },
		data: { encryptedConfig: secret },
	});
}
async function guardWrites() {
	for (const table of [
		"notification_channels",
		"notification_subscriptions",
		"notification_rules",
		"notification_logs",
		"User",
	])
		for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
			const name = `repair_read_${table}_${operation}`;
			guards.push(name);
			await prisma.$executeRawUnsafe(
				`CREATE TRIGGER "${name}" BEFORE ${operation} ON "${table}" BEGIN SELECT RAISE(ABORT, 'synthetic-private-write'); END`,
			);
		}
}
function queryBoundary(lookup?: () => Promise<void>, update?: () => Promise<void>) {
	const channels = new Proxy(prisma.notificationChannel, {
		get(target, key) {
			if (key === "findFirst" && lookup)
				return async (args: Prisma.NotificationChannelFindFirstArgs) => {
					await lookup();
					return target.findFirst(args);
				};
			if (key === "update" && update)
				return async (args: Prisma.NotificationChannelUpdateArgs) => {
					await update();
					return target.update(args);
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(prisma, {
		get(target, key) {
			if (key === "notificationChannel") return channels;
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("configuration repair admission: actual Fastify routes, auth injected, real populated SQLite", () => {
	it.each(["decrypt", "json", "schema"])(
		"classifies %s corruption with metadata only and zero writes",
		async (kind) => {
			await seed(
				"WEBHOOK",
				kind === "json" ? `{${secret}` : kind === "schema" ? { secret } : undefined,
			);
			if (kind === "decrypt") await corrupt();
			await populate();
			const before = await snapshot();
			await guardWrites();
			const ordinary = await app.inject({
				method: "GET",
				url: "/channels/owned/config",
				headers: { "x-test-auth": "1" },
			});
			expect(ordinary.statusCode).toBe(500);
			expect(ordinary.body).not.toContain(secret);
			const response = await read();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				id: "owned",
				name: "Synthetic same-name channel",
				type: "WEBHOOK",
				enabled: false,
				configRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
				state: "repair-required",
			});
			expect(await snapshot()).toEqual(before);
			expect(response.body + logs.join("")).not.toContain(secret);
			for (const forbidden of [
				"encryptedConfig",
				"configIv",
				"lastTest",
				"subscriptions",
				"history",
				"ciphertext",
				"reason",
			])
				expect(response.body).not.toContain(forbidden);
			expect(externalCalls).toBe(0);
		},
	);
	it.each(fixtures)(
		"reports supported $type as readable without delivery proof",
		async ({ type, config }) => {
			await seed(type, config);
			await populate();
			const before = await snapshot();
			await guardWrites();
			const response = await read();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				id: "owned",
				type,
				enabled: false,
				state: "readable",
				configRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(Object.keys(response.json()).sort()).toEqual([
				"configRevision",
				"enabled",
				"id",
				"name",
				"state",
				"type",
			]);
			expect(await snapshot()).toEqual(before);
			expect(response.body + logs.join("")).not.toContain(secret);
			expect(externalCalls).toBe(0);
		},
	);
	it.each(["missing", "foreign-channel"])("does not disclose or admit %s", async (id) => {
		await seed();
		await populate();
		const response = await read(id);
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Channel not found" });
	});
	it("rejects unsupported stored type instead of offering a guessed repair", async () => {
		await seed();
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { type: "UNSUPPORTED" },
		});
		const response = await read();
		expect(response.statusCode).toBe(500);
		expect(response.body).not.toContain("repair-required");
	});
	it("database lookup failure remains a generic error with no private logs", async () => {
		await seed();
		await mount(
			queryBoundary(async () => {
				throw new Error(secret);
			}),
		);
		const response = await read();
		expect(response.statusCode).toBe(500);
		expect(response.body + logs.join("")).not.toContain(secret);
		expect(response.body).not.toContain("repair-required");
	});
	it("fresh reads observe repaired config, supported type changes and ownership loss", async () => {
		await seed();
		await corrupt();
		const first = await read();
		expect(first.statusCode).toBe(200);
		const encrypted = encryptor.encrypt(JSON.stringify({ apiToken: secret }));
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { type: "PUSHBULLET", encryptedConfig: encrypted.value, configIv: encrypted.iv },
		});
		const current = await read();
		expect(current.json()).toMatchObject({ type: "PUSHBULLET", state: "readable" });
		expect(current.json().configRevision).not.toBe(first.json().configRevision);
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { userId: "foreign" },
		});
		expect((await read()).statusCode).toBe(404);
	});
	it.each(fixtures)(
		"complete $type replacement stays owned/encrypted and retains relationships",
		async ({ type, config }) => {
			await seed(type);
			await corrupt();
			await populate();
			const before = await snapshot();
			const state = await read();
			expect(state.statusCode).toBe(200);
			const response = await save(config, state.json().configRevision);
			expect(response.statusCode).toBe(200);
			const current = await row();
			expect(current).toMatchObject({
				id: "owned",
				userId: "owner",
				name: before.channels[1]!.name,
				type,
				enabled: false,
				lastTestedAt: null,
				lastTestResult: null,
				lastSentAt: proof,
				lastSendResult: "failed",
			});
			expect(current.encryptedConfig).not.toContain(secret);
			expect(
				JSON.parse(encryptor.decrypt({ value: current.encryptedConfig, iv: current.configIv })),
			).toEqual(config);
			const after = await snapshot();
			expect(after.channels[0]).toEqual(before.channels[0]);
			expect(after.subscriptions).toEqual(before.subscriptions);
			expect(after.rules).toEqual(before.rules);
			expect(after.history).toEqual(before.history);
			expect(response.body + logs.join("")).not.toContain(secret);
			expect(externalCalls).toBe(0);
			expect((await read()).json().state).toBe("readable");
		},
	);
	it.each([
		{ config: {}, status: 400 },
		{ config: { url: "invalid" }, status: 400 },
		{ config: { url: "••••••••" }, status: 500 },
		{ config: { url: "https://synthetic.invalid", secret: "••••••••" }, status: 500 },
	])(
		"invalid/incomplete/retained replacement $config writes nothing",
		async ({ config, status }) => {
			await seed();
			await corrupt();
			const state = await read();
			expect(state.statusCode).toBe(200);
			const before = await snapshot();
			// Retained values with unreadable storage use the unchanged route's generic failure.
			expect((await save(config, state.json().configRevision)).statusCode).toBe(status);
			expect(await snapshot()).toEqual(before);
		},
	);
	it("omitted optional fields clear old values on full valid replacement", async () => {
		await seed();
		const state = await read();
		expect(state.statusCode).toBe(200);
		expect(
			(await save({ url: "https://synthetic.invalid/new" }, state.json().configRevision))
				.statusCode,
		).toBe(200);
		const current = await row();
		expect(
			JSON.parse(encryptor.decrypt({ value: current.encryptedConfig, iv: current.configIv })),
		).toEqual({ url: "https://synthetic.invalid/new", method: "POST" });
	});
	it.each(["config", "owner", "type", "delete"])(
		"fences %s change after repair read without clobbering winner",
		async (change) => {
			await seed();
			await corrupt();
			const state = await read();
			expect(state.statusCode).toBe(200);
			if (change === "delete") await prisma.notificationChannel.delete({ where: { id: "owned" } });
			else
				await prisma.notificationChannel.update({
					where: { id: "owned" },
					data:
						change === "owner"
							? { userId: "foreign" }
							: change === "type"
								? { type: "EMAIL" }
								: { encryptedConfig: "winning-ciphertext" },
				});
			const before = await snapshot();
			expect(
				(await save({ url: "https://synthetic.invalid/new" }, state.json().configRevision))
					.statusCode,
			).toBe(change === "owner" || change === "delete" ? 404 : 409);
			expect(await snapshot()).toEqual(before);
		},
	);
	it.each(["config", "owner", "type"])(
		"fences %s race during the PUT read/write gap",
		async (change) => {
			await seed();
			await corrupt();
			const state = await read();
			expect(state.statusCode).toBe(200);
			await mount(
				queryBoundary(undefined, async () => {
					await prisma.notificationChannel.update({
						where: { id: "owned" },
						data:
							change === "owner"
								? { userId: "foreign" }
								: change === "type"
									? { type: "EMAIL" }
									: { encryptedConfig: "winning-ciphertext" },
					});
				}),
			);
			expect(
				(await save({ url: "https://synthetic.invalid/new" }, state.json().configRevision))
					.statusCode,
			).toBe(change === "owner" ? 404 : 409);
			const current = await row();
			expect(current.lastTestedAt).toEqual(proof);
			expect(
				change === "owner"
					? current.userId
					: change === "type"
						? current.type
						: current.encryptedConfig,
			).toBe(change === "owner" ? "foreign" : change === "type" ? "EMAIL" : "winning-ciphertext");
		},
	);
	it("database write failure does not acknowledge a successful repair", async () => {
		await seed();
		await corrupt();
		const state = await read();
		expect(state.statusCode).toBe(200);
		const before = await snapshot();
		await mount(
			queryBoundary(undefined, async () => {
				throw new Error(secret);
			}),
		);
		expect(
			(await save({ url: "https://synthetic.invalid/new" }, state.json().configRevision))
				.statusCode,
		).toBe(500);
		expect(await snapshot()).toEqual(before);
	});
});
