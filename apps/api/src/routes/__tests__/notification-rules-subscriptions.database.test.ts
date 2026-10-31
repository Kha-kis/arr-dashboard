import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { NotificationEventType } from "@arr/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import type { Prisma, PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { setupAuthInjection } from "./test-helpers.js";

const encryptor = new Encryptor(Buffer.alloc(32, 72).toString("base64"));
const conditions = [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }];
const ruleInput = { name: "Synthetic rule", action: "suppress", conditions };
const proofTime = new Date("2026-01-01T00:00:00Z");
const triggers = [
	"reject_rule_update",
	"reject_rule_delete",
	"reject_subscription_fence",
	"reject_late_subscription",
];
const fixtureRoot = resolve(process.env.RULES_SUBSCRIPTIONS_FIXTURE_ROOT ?? tmpdir());
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, "notification-rules-subscriptions-"));
	chmodSync(directory, 0o700);
	const database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// Use the actual full schema with a private config: repository Prisma config
	// loads dotenv, which must not load developer credentials into this fixture.
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
	for (const trigger of triggers)
		await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`);
	await prisma.notificationRule.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	await mount();
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
				expect(basename(directory).startsWith("notification-rules-subscriptions-")).toBe(true);
				rmSync(directory, { recursive: true, force: true });
			}
		}
	}
});

async function mount(client = prisma) {
	await app?.close();
	app = Fastify({ logger: false });
	app.decorate("prisma", client);
	app.decorate("encryptor", encryptor);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
	app.setErrorHandler((error, _request, reply) =>
		reply
			.status(error instanceof Error && error.name === "ZodValidationError" ? 400 : 500)
			.send({ error: "Synthetic fixture failure" }),
	);
	await app.register(registerNotificationRoutes);
	await app.ready();
}

function send(
	method: "GET" | "POST" | "PUT" | "DELETE",
	url: string,
	payload?: Record<string, unknown>,
) {
	return app!.inject({
		method,
		url,
		headers: { "x-test-auth": "1" },
		...(payload === undefined ? {} : { payload }),
	});
}

function seedRule(
	id = "owned-rule",
	userId = "owner",
	extra: Partial<Prisma.NotificationRuleUncheckedCreateInput> = {},
) {
	return prisma.notificationRule.create({
		data: { id, userId, ...ruleInput, conditions: JSON.stringify(conditions), ...extra },
	});
}

function seedChannel(id = "owned", userId = "owner") {
	const encrypted = encryptor.encrypt(JSON.stringify({ url: "https://synthetic.invalid/unused" }));
	return prisma.notificationChannel.create({
		data: {
			id,
			userId,
			name: "Synthetic channel",
			type: "WEBHOOK",
			enabled: false,
			encryptedConfig: encrypted.value,
			configIv: encrypted.iv,
			lastTestedAt: proofTime,
			lastTestResult: "success",
			lastSentAt: proofTime,
			lastSendResult: "success",
		},
	});
}

const subscriptions = () =>
	prisma.notificationSubscription.findMany({
		orderBy: [{ channelId: "asc" }, { eventType: "asc" }],
	});
const sub = (channelId: string, eventType: NotificationEventType, enabled: boolean) => ({
	channelId,
	eventType,
	enabled,
});

// Only deterministic scheduling is injected. The selection, injected write and
// later route mutations all use real Prisma/SQLite. This is not proof of an
// actual transfer API, cross-process concurrency, PostgreSQL or provider behavior.
function afterSelection(
	model: "notificationRule" | "notificationChannel",
	operation: "findFirst" | "findMany",
	selectedId: string,
	mutation: (client: PrismaClient) => Promise<unknown>,
) {
	let injections = 0;
	function wrap(client: PrismaClient): PrismaClient {
		return new Proxy(client, {
			get(target, key) {
				if (key === model)
					return new Proxy(target[model], {
						get(delegate, method) {
							if (method === operation)
								return async (args: any) => {
									const rows = await (delegate[method] as (args: any) => Promise<any>)(args);
									const matched = Array.isArray(rows)
										? rows.some((row) => row.id === selectedId)
										: rows?.id === selectedId;
									if (!injections && args?.where?.userId === "owner" && matched) {
										injections++;
										await mutation(client);
									}
									return rows;
								};
							const value = Reflect.get(delegate, method);
							return typeof value === "function" ? value.bind(delegate) : value;
						},
					});
				if (key === "$transaction")
					return (callback: any, options: any) =>
						target.$transaction((tx: any) => callback(wrap(tx)), options);
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	return { client: wrap(prisma), injections: () => injections };
}

describe("notification rules real database boundary", () => {
	it("persists literal create/read/update/delete values and excludes foreign rows", async () => {
		await seedRule("foreign-rule", "foreign");
		const created = await send("POST", "/rules", {
			...ruleInput,
			enabled: false,
			priority: 7,
			action: "route",
			targetChannelIds: ["owned"],
			throttleMinutes: 15,
		});
		expect(created.statusCode).toBe(201);
		const id = created.json().id;
		const row = await prisma.notificationRule.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({
			userId: "owner",
			name: "Synthetic rule",
			enabled: false,
			priority: 7,
			action: "route",
			conditions: '[{"field":"eventType","operator":"equals","value":"HUNT_COMPLETED"}]',
			targetChannelIds: '["owned"]',
			throttleMinutes: 15,
		});
		const list = await send("GET", "/rules");
		expect(list.statusCode).toBe(200);
		expect(list.json().map((rule: { id: string }) => rule.id)).toEqual([id]);
		expect(list.json()[0].conditions).toEqual([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		]);
		expect(
			(await send("PUT", `/rules/${id}`, { name: "Updated literal", action: "throttle" }))
				.statusCode,
		).toBe(200);
		expect(await prisma.notificationRule.findUniqueOrThrow({ where: { id } })).toMatchObject({
			name: "Updated literal",
			action: "throttle",
		});
		expect((await send("DELETE", `/rules/${id}`)).statusCode).toBe(204);
		expect(await prisma.notificationRule.count({ where: { id } })).toBe(0);
		expect(await prisma.notificationRule.count({ where: { id: "foreign-rule" } })).toBe(1);
	});

	it("preserves every unsupplied setting during a name-only update", async () => {
		const original = await seedRule("owned-rule", "owner", {
			enabled: false,
			priority: 13,
			action: "quiet_hours",
			targetChannelIds: '["owned"]',
			throttleMinutes: 9,
			quietHoursStart: "22:00",
			quietHoursEnd: "08:00",
			quietHoursTimezone: "UTC",
		});
		expect((await send("PUT", "/rules/owned-rule", { name: "Renamed" })).statusCode).toBe(200);
		const row = await prisma.notificationRule.findUniqueOrThrow({ where: { id: original.id } });
		expect(row).toMatchObject({ ...original, name: "Renamed", updatedAt: expect.any(Date) });
	});

	it("an enabled-only toggle preserves priority and explicit false/zero persist", async () => {
		await seedRule("owned-rule", "owner", { priority: 13 });
		expect((await send("PUT", "/rules/owned-rule", { enabled: false })).statusCode).toBe(200);
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: "owned-rule" } }),
		).toMatchObject({ enabled: false, priority: 13 });
		expect((await send("PUT", "/rules/owned-rule", { priority: 0 })).statusCode).toBe(200);
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: "owned-rule" } }),
		).toMatchObject({ enabled: false, priority: 0 });
	});

	it.each(["PUT", "DELETE"] as const)(
		"%s rejects foreign and missing rules without mutation",
		async (method) => {
			const initial = await seedRule("foreign-rule", "foreign");
			for (const id of ["foreign-rule", "missing-rule"])
				expect(
					(await send(method, `/rules/${id}`, method === "PUT" ? { name: "Unwanted" } : undefined))
						.statusCode,
				).toBe(404);
			expect(await prisma.notificationRule.findMany()).toEqual([initial]);
		},
	);

	it.each([{}, { quietHoursStart: "22:00" }, { quietHoursEnd: "08:00" }])(
		"quiet-hours create rejects missing times: %j",
		async (partial) => {
			expect(
				(await send("POST", "/rules", { ...ruleInput, action: "quiet_hours", ...partial }))
					.statusCode,
			).toBe(400);
			expect(await prisma.notificationRule.count()).toBe(0);
		},
	);

	it.each([{}, { quietHoursStart: "22:00" }, { quietHoursEnd: "08:00" }])(
		"quiet-hours transition rejects missing merged times: %j",
		async (partial) => {
			const initial = await seedRule();
			expect(
				(await send("PUT", "/rules/owned-rule", { action: "quiet_hours", ...partial })).statusCode,
			).toBe(400);
			expect(
				await prisma.notificationRule.findUniqueOrThrow({ where: { id: initial.id } }),
			).toEqual(initial);
		},
	);

	it("quiet-hours create and merged partial updates preserve valid times", async () => {
		const created = await send("POST", "/rules", {
			...ruleInput,
			action: "quiet_hours",
			quietHoursStart: "22:00",
			quietHoursEnd: "08:00",
			quietHoursTimezone: "UTC",
		});
		expect(created.statusCode).toBe(201);
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: created.json().id } }),
		).toMatchObject({
			quietHoursStart: "22:00",
			quietHoursEnd: "08:00",
			quietHoursTimezone: "UTC",
		});
		await seedRule("owned-rule", "owner", { quietHoursStart: "22:00", quietHoursEnd: "08:00" });
		expect((await send("PUT", "/rules/owned-rule", { action: "quiet_hours" })).statusCode).toBe(
			200,
		);
		expect((await send("PUT", "/rules/owned-rule", { quietHoursStart: "21:00" })).statusCode).toBe(
			200,
		);
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: "owned-rule" } }),
		).toMatchObject({ action: "quiet_hours", quietHoursStart: "21:00", quietHoursEnd: "08:00" });
	});

	it.each(["PUT", "DELETE"] as const)(
		"%s rejects ownership loss after the real selection",
		async (method) => {
			const initial = await seedRule();
			const race = afterSelection("notificationRule", "findFirst", initial.id, (client) =>
				client.notificationRule.update({ where: { id: initial.id }, data: { userId: "foreign" } }),
			);
			await mount(race.client);
			const response = await send(
				method,
				`/rules/${initial.id}`,
				method === "PUT" ? { name: "Unwanted mutation" } : undefined,
			);
			expect(race.injections()).toBe(1);
			expect(await prisma.notificationRule.findUnique({ where: { id: initial.id } })).toMatchObject(
				{ userId: "foreign", name: "Synthetic rule" },
			);
			expect(response.statusCode).toBe(404);
		},
	);

	it.each(["PUT", "DELETE"] as const)(
		"%s rejects disappearance after the real selection",
		async (method) => {
			await seedRule();
			const race = afterSelection("notificationRule", "findFirst", "owned-rule", (client) =>
				client.notificationRule.delete({ where: { id: "owned-rule" } }),
			);
			await mount(race.client);
			expect(
				(
					await send(
						method,
						"/rules/owned-rule",
						method === "PUT" ? { name: "Unwanted" } : undefined,
					)
				).statusCode,
			).toBe(404);
			expect(race.injections()).toBe(1);
			expect(await prisma.notificationRule.count()).toBe(0);
		},
	);

	it("rejects a concurrent config edit that invalidates merged quiet-hours validation", async () => {
		await seedRule("owned-rule", "owner", { quietHoursStart: "22:00", quietHoursEnd: "08:00" });
		const race = afterSelection("notificationRule", "findFirst", "owned-rule", (client) =>
			client.notificationRule.update({
				where: { id: "owned-rule" },
				data: { quietHoursEnd: null },
			}),
		);
		await mount(race.client);
		const response = await send("PUT", "/rules/owned-rule", { action: "quiet_hours" });
		expect(race.injections()).toBe(1);
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({
			code: "RULE_SETTINGS_CONFLICT",
			message: expect.any(String),
		});
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: "owned-rule" } }),
		).toMatchObject({ action: "suppress", quietHoursStart: "22:00", quietHoursEnd: null });
	});

	it("rejects a concurrent name change even when updatedAt is unchanged", async () => {
		const initial = await seedRule();
		const race = afterSelection("notificationRule", "findFirst", initial.id, (client) =>
			client.notificationRule.update({
				where: { id: initial.id },
				data: { name: "Other saved edit", updatedAt: initial.updatedAt },
			}),
		);
		await mount(race.client);
		expect((await send("PUT", `/rules/${initial.id}`, { name: "Stale edit" })).statusCode).toBe(
			409,
		);
		expect(race.injections()).toBe(1);
		expect(
			await prisma.notificationRule.findUniqueOrThrow({ where: { id: initial.id } }),
		).toMatchObject({ name: "Other saved edit", updatedAt: initial.updatedAt });
	});

	it.each(["PUT", "DELETE"] as const)(
		"%s propagates arbitrary real database failures without claiming success",
		async (method) => {
			const initial = await seedRule();
			await prisma.$executeRawUnsafe(
				`CREATE TRIGGER "reject_rule_${method === "PUT" ? "update" : "delete"}" BEFORE ${method === "PUT" ? "UPDATE" : "DELETE"} ON notification_rules BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`,
			);
			expect(
				(
					await send(
						method,
						`/rules/${initial.id}`,
						method === "PUT" ? { name: "Unwanted" } : undefined,
					)
				).statusCode,
			).toBe(500);
			expect(
				await prisma.notificationRule.findUniqueOrThrow({ where: { id: initial.id } }),
			).toEqual(initial);
		},
	);

	it("rejects malformed rule fields without persistence", async () => {
		await seedRule();
		expect((await send("POST", "/rules", { ...ruleInput, conditions: [] })).statusCode).toBe(400);
		expect((await send("PUT", "/rules/owned-rule", { quietHoursStart: "25:00" })).statusCode).toBe(
			400,
		);
		expect(
			(await prisma.notificationRule.findUniqueOrThrow({ where: { id: "owned-rule" } }))
				.quietHoursStart,
		).toBeNull();
	});
});

describe("notification subscriptions real database boundary", () => {
	it("saves owned entries while preserving foreign and unsubmitted rows and channel metadata", async () => {
		const channel = await seedChannel();
		await seedChannel("foreign-channel", "foreign");
		await seedChannel("unsubmitted");
		await prisma.notificationSubscription.createMany({
			data: [
				{ channelId: "owned", eventType: "HUNT_COMPLETED" },
				{ channelId: "foreign-channel", eventType: "HUNT_COMPLETED" },
				{ channelId: "unsubmitted", eventType: "BACKUP_FAILED" },
				{ channelId: "unsubmitted", eventType: "LEGACY_EVENT" },
			],
		});
		const response = await send("PUT", "/subscriptions", {
			subscriptions: [
				sub("owned", "HUNT_COMPLETED", false),
				sub("owned", "BACKUP_FAILED", true),
				sub("foreign-channel", "HUNT_COMPLETED", false),
				sub("foreign-channel", "BACKUP_FAILED", true),
				sub("missing", "HUNT_COMPLETED", true),
				sub("missing", "HUNT_COMPLETED", true),
			],
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			success: true,
			omittedCount: 4,
			grid: {
				channels: [
					{ id: "owned", name: "Synthetic channel", type: "WEBHOOK" },
					{ id: "unsubmitted", name: "Synthetic channel", type: "WEBHOOK" },
				],
				events: expect.arrayContaining(["HUNT_COMPLETED", "BACKUP_FAILED"]),
				subscriptions: [
					{ channelId: "owned", eventType: "BACKUP_FAILED" },
					{ channelId: "unsubmitted", eventType: "BACKUP_FAILED" },
					{ channelId: "unsubmitted", eventType: "LEGACY_EVENT" },
				],
			},
		});
		expect(await subscriptions()).toEqual([
			{ channelId: "foreign-channel", eventType: "HUNT_COMPLETED" },
			{ channelId: "owned", eventType: "BACKUP_FAILED" },
			{ channelId: "unsubmitted", eventType: "BACKUP_FAILED" },
			{ channelId: "unsubmitted", eventType: "LEGACY_EVENT" },
		]);
		expect(
			await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channel.id } }),
		).toEqual(channel);
		const grid = await send("GET", "/subscriptions");
		expect(grid.statusCode).toBe(200);
		expect(
			grid
				.json()
				.channels.map((row: { id: string }) => row.id)
				.sort(),
		).toEqual(["owned", "unsubmitted"]);
		expect(grid.json()).toEqual(response.json().grid);
	});

	it("rolls back writes when reading the resulting grid fails inside the transaction", async () => {
		await seedChannel();
		await prisma.notificationSubscription.create({
			data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
		});
		let readsFailed = 0;
		const client = new Proxy(prisma, {
			get(target, key) {
				if (key === "$transaction") {
					return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
						target.$transaction((tx) =>
							callback(
								new Proxy(tx, {
									get(transaction, model) {
										if (model === "notificationSubscription") {
											return new Proxy(transaction.notificationSubscription, {
												get(delegate, operation) {
													if (operation === "findMany")
														return async () => {
															readsFailed++;
															throw new Error("Synthetic result read failure");
														};
													const value = Reflect.get(delegate, operation);
													return typeof value === "function" ? value.bind(delegate) : value;
												},
											});
										}
										const value = Reflect.get(transaction, model);
										return typeof value === "function" ? value.bind(transaction) : value;
									},
								}),
							),
						);
				}
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await mount(client);
		const response = await send("PUT", "/subscriptions", {
			subscriptions: [sub("owned", "HUNT_COMPLETED", false), sub("owned", "BACKUP_FAILED", true)],
		});
		expect(response.statusCode).toBe(500);
		expect(readsFailed).toBe(1);
		expect(response.json()).not.toHaveProperty("success", true);
		expect(await subscriptions()).toEqual([{ channelId: "owned", eventType: "HUNT_COMPLETED" }]);
	});

	it.each([true, false])(
		"rejects ownership loss for enabled=%s and rolls back the whole mixed batch",
		async (enabled) => {
			await seedChannel();
			await seedChannel("other-owned");
			await prisma.notificationSubscription.create({
				data: { channelId: "other-owned", eventType: "BACKUP_FAILED" },
			});
			if (!enabled)
				await prisma.notificationSubscription.create({
					data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
				});
			const initial = await subscriptions();
			const race = afterSelection("notificationChannel", "findMany", "owned", (client) =>
				client.notificationChannel.update({ where: { id: "owned" }, data: { userId: "foreign" } }),
			);
			await mount(race.client);
			const response = await send("PUT", "/subscriptions", {
				subscriptions: [
					sub("other-owned", "BACKUP_FAILED", false),
					sub("owned", "HUNT_COMPLETED", enabled),
					sub("other-owned", "SYSTEM_STARTUP", true),
				],
			});
			expect(race.injections()).toBe(1);
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({
				code: "SUBSCRIPTION_OWNERSHIP_CONFLICT",
				message: expect.any(String),
			});
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).userId,
			).toBe("foreign");
			expect(await subscriptions()).toEqual(initial);
			// A deliberate retry freshly filters the now-foreign channel and applies
			// the remaining owned entries under the existing filtering policy.
			expect(
				(
					await send("PUT", "/subscriptions", {
						subscriptions: [
							sub("other-owned", "BACKUP_FAILED", false),
							sub("owned", "HUNT_COMPLETED", enabled),
							sub("other-owned", "SYSTEM_STARTUP", true),
						],
					})
				).statusCode,
			).toBe(200);
			expect(await subscriptions()).toEqual(
				enabled
					? [{ channelId: "other-owned", eventType: "SYSTEM_STARTUP" }]
					: [
							{ channelId: "other-owned", eventType: "SYSTEM_STARTUP" },
							{ channelId: "owned", eventType: "HUNT_COMPLETED" },
						],
			);
		},
	);

	it("rejects disappearance after selection without changing other owned entries", async () => {
		await seedChannel();
		await seedChannel("other-owned");
		await prisma.notificationSubscription.create({
			data: { channelId: "other-owned", eventType: "BACKUP_FAILED" },
		});
		const race = afterSelection("notificationChannel", "findMany", "owned", (client) =>
			client.notificationChannel.delete({ where: { id: "owned" } }),
		);
		await mount(race.client);
		expect(
			(
				await send("PUT", "/subscriptions", {
					subscriptions: [
						sub("other-owned", "BACKUP_FAILED", false),
						sub("owned", "HUNT_COMPLETED", true),
					],
				})
			).statusCode,
		).toBe(409);
		expect(race.injections()).toBe(1);
		expect(await subscriptions()).toEqual([
			{ channelId: "other-owned", eventType: "BACKUP_FAILED" },
		]);
	});

	it("rolls back real late insertion failure and allows explicit idempotent retry", async () => {
		await seedChannel();
		await prisma.notificationSubscription.create({
			data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
		});
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_late_subscription BEFORE INSERT ON notification_subscriptions WHEN NEW.eventType = 'BACKUP_FAILED' BEGIN SELECT RAISE(ABORT, 'synthetic late insertion failure'); END",
		);
		const payload = {
			subscriptions: [
				sub("owned", "HUNT_COMPLETED", false),
				sub("owned", "SYSTEM_STARTUP", true),
				sub("owned", "BACKUP_FAILED", true),
			],
		};
		expect((await send("PUT", "/subscriptions", payload)).statusCode).toBe(500);
		expect(await subscriptions()).toEqual([{ channelId: "owned", eventType: "HUNT_COMPLETED" }]);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_late_subscription");
		for (let repeat = 0; repeat < 2; repeat++) {
			expect((await send("PUT", "/subscriptions", payload)).statusCode).toBe(200);
			expect(await subscriptions()).toEqual([
				{ channelId: "owned", eventType: "BACKUP_FAILED" },
				{ channelId: "owned", eventType: "SYSTEM_STARTUP" },
			]);
		}
	});

	it("propagates real fence database failure without changing subscriptions", async () => {
		const channel = await seedChannel();
		await prisma.notificationSubscription.create({
			data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
		});
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_subscription_fence BEFORE UPDATE ON notification_channels BEGIN SELECT RAISE(ABORT, 'synthetic fence failure'); END",
		);
		expect(
			(
				await send("PUT", "/subscriptions", {
					subscriptions: [sub("owned", "HUNT_COMPLETED", false)],
				})
			).statusCode,
		).toBe(500);
		expect(await subscriptions()).toEqual([{ channelId: "owned", eventType: "HUNT_COMPLETED" }]);
		expect(
			await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channel.id } }),
		).toEqual(channel);
	});

	it("preserves empty, identical and conflicting duplicate behavior without changing channel metadata", async () => {
		const channel = await seedChannel();
		for (const entries of [
			[sub("owned", "HUNT_COMPLETED", true), sub("owned", "HUNT_COMPLETED", true)],
			[],
			[sub("owned", "HUNT_COMPLETED", true), sub("owned", "HUNT_COMPLETED", false)],
		]) {
			expect((await send("PUT", "/subscriptions", { subscriptions: entries })).statusCode).toBe(
				200,
			);
			expect(await subscriptions()).toEqual([{ channelId: "owned", eventType: "HUNT_COMPLETED" }]);
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channel.id } }),
			).toEqual(channel);
		}
	});

	it("rejects malformed subscription events without writes", async () => {
		await seedChannel();
		expect(
			(
				await send("PUT", "/subscriptions", {
					subscriptions: [{ channelId: "owned", eventType: "INVALID", enabled: true }],
				})
			).statusCode,
		).toBe(400);
		expect(await subscriptions()).toEqual([]);
	});
});
