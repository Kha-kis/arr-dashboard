import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { channelConfigRevision } from "../../lib/notifications/channel-config-revision.js";
import type { Prisma, PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

const encryptor = new Encryptor(Buffer.alloc(32, 81).toString("base64"));
const endpoint = "https://synthetic.invalid/device-one";
const secondEndpoint = "https://synthetic.invalid/device-two";
const keys = { p256dh: "synthetic-key", auth: "synthetic-auth" };
const proof = new Date("2026-01-01T00:00:00Z");
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance;
type Client = Prisma.TransactionClient | PrismaClient;

beforeAll(async () => {
	directory = mkdtempSync(
		join(resolve(process.env.PUSH_LIFECYCLE_FIXTURE_ROOT ?? tmpdir()), "push-lifecycle-"),
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
	for (const name of [
		"reject_lifecycle_update",
		"reject_lifecycle_insert",
		"reject_lifecycle_lock",
		"read_no_channel_write",
		"read_no_user_write",
		"corrupt_reconnect_readback",
	])
		await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}"`);
	await prisma.notificationRule.deleteMany({});
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	await mount();
});
afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
async function mount(client = prisma) {
	await app?.close();
	app = Fastify({ logger: false });
	app.decorate("prisma", client);
	app.decorate("encryptor", encryptor);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
}
function request(action: string, payload: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url: `/push-subscription/${action}`,
		headers: { "x-test-auth": "1" },
		payload,
	});
}
async function seed(id = "owned", url = endpoint, userId = "owner", enabled = true) {
	const encrypted = encryptor.encrypt(JSON.stringify({ endpoint: url, ...keys }));
	return prisma.notificationChannel.create({
		data: {
			id,
			userId,
			name: "Synthetic retained device",
			type: "BROWSER_PUSH",
			enabled,
			encryptedConfig: encrypted.value,
			configIv: encrypted.iv,
			lastTestedAt: proof,
			lastTestResult: "success",
			lastSentAt: proof,
			lastSendResult: "success",
		},
	});
}
const read = () => prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
async function selector() {
	const result = await request("state", { endpoint });
	expect(result.statusCode).toBe(200);
	return { channelId: "owned", expectedRevision: result.json().configRevision };
}
async function history() {
	await prisma.notificationSubscription.createMany({
		data: [
			{ channelId: "owned", eventType: "HUNT_COMPLETED" },
			{ channelId: "owned", eventType: "LEGACY_TAG" },
		],
	});
	await prisma.notificationLog.create({
		data: {
			id: "history",
			channelId: "owned",
			channelType: "BROWSER_PUSH",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic",
			body: "Synthetic",
			status: "sent",
		},
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
}
function injectSelection(action: (client: Client) => Promise<void>) {
	let injections = 0;
	function wrap(client: Client): Client {
		const channels = new Proxy(client.notificationChannel, {
			get(target, key) {
				if (key === "findMany")
					return async (args: Prisma.NotificationChannelFindManyArgs) => {
						const rows = await target.findMany(args);
						if (args.where?.userId === "owner" && !injections) {
							injections++;
							await action(client);
						}
						return rows;
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return new Proxy(client, {
			get(target, key) {
				if (key === "notificationChannel") return channels;
				if (key === "$transaction")
					return (callback: (tx: Client) => Promise<unknown>) =>
						prisma.$transaction((tx) => callback(wrap(tx)));
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	return { client: wrap(prisma) as PrismaClient, count: () => injections };
}

describe("owned reversible browser push lifecycle on real full-schema SQLite", () => {
	it.each([true, false])(
		"reconnects unreadable selected config retaining enabled=%s and durable history",
		async (enabled) => {
			const outbound = vi
				.spyOn(webpush, "sendNotification")
				.mockRejectedValue(new Error("synthetic-outbound-denied"));
			await seed("owned", endpoint, "owner", enabled);
			await history();
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: { encryptedConfig: "synthetic-corrupt" },
			});
			const before = await read();
			const response = await request("reconnect", {
				channelId: "owned",
				expectedRevision: channelConfigRevision(before),
				endpoint: secondEndpoint,
				keys,
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				channelId: "owned",
				configRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
				state: enabled ? "enabled" : "disabled",
				subscribedEventCount: 1,
			});
			const after = await read();
			expect(
				JSON.parse(encryptor.decrypt({ value: after.encryptedConfig, iv: after.configIv })),
			).toEqual({ endpoint: secondEndpoint, ...keys });
			expect(after).toEqual({
				...before,
				encryptedConfig: expect.any(String),
				configIv: expect.any(String),
				lastTestedAt: null,
				lastTestResult: null,
				updatedAt: expect.any(Date),
			});
			expect(await prisma.notificationSubscription.count()).toBe(2);
			expect(await prisma.notificationLog.count()).toBe(1);
			expect(await prisma.notificationRule.count()).toBe(1);
			expect(await prisma.notificationChannel.count()).toBe(1);
			expect(outbound).not.toHaveBeenCalled();
			expect(
				(await request("state", { channelId: "owned", endpoint: secondEndpoint })).json(),
			).toEqual(response.json());
		},
	);
	it.each(["userId", "type", "name", "enabled", "encryptedConfig", "configIv"])(
		"reconnect fences selected %s changes without partial writes",
		async (field) => {
			await seed();
			const before = await read();
			const injection = injectSelection(async (client) => {
				await client.notificationChannel.update({
					where: { id: "owned" },
					data:
						field === "userId"
							? { userId: "foreign" }
							: field === "type"
								? { type: "WEBHOOK" }
								: field === "name"
									? { name: "Changed" }
									: field === "enabled"
										? { enabled: false }
										: field === "configIv"
											? { configIv: "changed" }
											: { encryptedConfig: "changed" },
				});
			});
			await mount(injection.client);
			expect(
				(
					await request("reconnect", {
						channelId: "owned",
						expectedRevision: channelConfigRevision(before),
						endpoint: secondEndpoint,
						keys,
					})
				).statusCode,
			).toBe(409);
			expect(injection.count()).toBe(1);
			expect(await read()).toEqual(before);
		},
	);
	it("reconnect ignores foreign corrupt sibling evidence and rejects owned duplicate sibling endpoints", async () => {
		await seed();
		const foreign = await seed("foreign-device", secondEndpoint, "foreign");
		await prisma.notificationChannel.update({
			where: { id: foreign.id },
			data: { encryptedConfig: "synthetic-private-corrupt" },
		});
		expect(
			(
				await request("reconnect", {
					channelId: "owned",
					expectedRevision: channelConfigRevision(await read()),
					endpoint: secondEndpoint,
					keys,
				})
			).statusCode,
		).toBe(200);
		await seed("sibling-one", endpoint);
		await seed("sibling-two", endpoint);
		const before = await read();
		expect(
			(
				await request("reconnect", {
					channelId: "owned",
					expectedRevision: channelConfigRevision(before),
					endpoint: "https://synthetic.invalid/third",
					keys,
				})
			).statusCode,
		).toBe(409);
		expect(await read()).toEqual(before);
	});
	it("reconnect rolls back a persisted replacement that cannot be decoded", async () => {
		await seed();
		const before = await read();
		await prisma.$executeRawUnsafe(
			'CREATE TRIGGER corrupt_reconnect_readback AFTER UPDATE ON "notification_channels" BEGIN UPDATE "notification_channels" SET "encryptedConfig" = \'synthetic-private-corrupt\' WHERE "id" = NEW."id"; END',
		);
		const response = await request("reconnect", {
			channelId: "owned",
			expectedRevision: channelConfigRevision(before),
			endpoint: secondEndpoint,
			keys,
		});
		expect(response.statusCode).toBe(409);
		expect(response.body).not.toContain("synthetic-private");
		expect(await read()).toEqual(before);
	});
	it("reconnect denies missing, foreign, wrong-type and stale selected identity without fallback", async () => {
		await seed();
		const before = await read();
		await seed("foreign-device", secondEndpoint, "foreign");
		await seed("wrong-type", secondEndpoint);
		await prisma.notificationChannel.update({
			where: { id: "wrong-type" },
			data: { type: "WEBHOOK" },
		});
		for (const id of ["missing", "foreign-device", "wrong-type"])
			expect(
				(
					await request("reconnect", {
						channelId: id,
						expectedRevision: channelConfigRevision(before),
						endpoint,
						keys,
					})
				).statusCode,
			).toBe(404);
		expect(
			(
				await request("reconnect", {
					channelId: "owned",
					expectedRevision: "b".repeat(64),
					endpoint,
					keys,
				})
			).statusCode,
		).toBe(409);
		expect(await read()).toEqual(before);
	});
	it.each(["duplicate", "unreadable"])("reconnect fails closed on %s sibling", async (kind) => {
		await seed();
		await seed("sibling", secondEndpoint);
		if (kind === "unreadable")
			await prisma.notificationChannel.update({
				where: { id: "sibling" },
				data: { encryptedConfig: "synthetic-private-unreadable" },
			});
		const before = await prisma.notificationChannel.findMany();
		const response = await request("reconnect", {
			channelId: "owned",
			expectedRevision: channelConfigRevision(await read()),
			endpoint: secondEndpoint,
			keys,
		});
		expect(response.statusCode).toBe(409);
		expect(response.body).not.toContain("synthetic-private");
		expect(await prisma.notificationChannel.findMany()).toEqual(before);
	});
	it("reconnect rolls back failed update and row fence", async () => {
		await seed();
		const before = await read();
		const input = {
			channelId: "owned",
			expectedRevision: channelConfigRevision(before),
			endpoint: secondEndpoint,
			keys,
		};
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_lifecycle_update BEFORE UPDATE ON \"notification_channels\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-error'); END",
		);
		const failed = await request("reconnect", input);
		expect(failed.statusCode).toBe(500);
		expect(failed.body).not.toContain("synthetic-private");
		expect(await read()).toEqual(before);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_lifecycle_update");
		const injection = injectSelection(async (client) => {
			await client.notificationChannel.update({ where: { id: "owned" }, data: { enabled: false } });
		});
		await mount(injection.client);
		expect((await request("reconnect", input)).statusCode).toBe(409);
		expect(injection.count()).toBe(1);
		expect(await read()).toEqual(before);
	});
	it("reconnect serializes conflicting revisions and rejects incomplete or extra request fields", async () => {
		await seed();
		const input = {
			channelId: "owned",
			expectedRevision: channelConfigRevision(await read()),
			endpoint: secondEndpoint,
			keys,
		};
		for (const invalid of [
			{ endpoint, keys },
			{ ...input, expectedRevision: undefined },
			{ ...input, extra: true },
			{ ...input, keys: { ...keys, extra: true } },
		])
			expect((await request("reconnect", invalid)).statusCode).toBe(400);
		const responses = await Promise.all([request("reconnect", input), request("reconnect", input)]);
		expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
		expect(await prisma.notificationChannel.count()).toBe(1);
	});
	it("control: actual legacy enrollment uses encrypted owned fixture without enabling disabled row", async () => {
		const before = await seed("owned", endpoint, "owner", false);
		const response = await app.inject({
			method: "POST",
			url: "/push-subscription",
			headers: { "x-test-auth": "1" },
			payload: { endpoint, keys },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: "owned", updated: true });
		expect(await read()).toEqual({ ...before, updatedAt: expect.any(Date) });
	});
	it("observes authoritative unregistered without writes, including foreign same endpoint", async () => {
		await seed("foreign-device", endpoint, "foreign");
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER read_no_channel_write BEFORE UPDATE ON \"notification_channels\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-read-write'); END",
		);
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER read_no_user_write BEFORE UPDATE ON \"User\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-read-lock'); END",
		);
		expect((await request("state", { endpoint })).json()).toEqual({
			channelId: null,
			configRevision: null,
			state: "unregistered",
			subscribedEventCount: 0,
		});
		expect((await request("state", { channelId: "foreign-device" })).statusCode).toBe(404);
		expect(await prisma.notificationChannel.count()).toBe(1);
	});
	it("reads owned enabled and retained disabled state, counting supported events only", async () => {
		await seed();
		await history();
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER read_no_channel_write BEFORE UPDATE ON \"notification_channels\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-read-write'); END",
		);
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER read_no_user_write BEFORE UPDATE ON \"User\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-read-lock'); END",
		);
		const state = await request("state", { endpoint, channelId: "owned" });
		expect(state.statusCode).toBe(200);
		expect(state.json()).toEqual({
			channelId: "owned",
			configRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
			state: "enabled",
			subscribedEventCount: 1,
		});
		await prisma.$executeRawUnsafe("DROP TRIGGER read_no_channel_write");
		await prisma.notificationChannel.update({ where: { id: "owned" }, data: { enabled: false } });
		expect((await request("state", { channelId: "owned" })).json().state).toBe("disabled");
	});
	it.each([{}, { endpoint: "http://127.0.0.1/private" }, { channelId: "" }])(
		"validates selector %j",
		async (payload) => {
			expect((await request("state", payload)).statusCode).toBe(400);
		},
	);
	it("rejects missing handle and mismatched handle/endpoint without fallback", async () => {
		await seed();
		expect((await request("state", { endpoint, channelId: "missing" })).statusCode).toBe(404);
		expect(
			(await request("state", { endpoint: secondEndpoint, channelId: "owned" })).statusCode,
		).toBe(409);
	});
	it.each(["state", "disable", "enable"])(
		"fails closed on duplicated endpoint for %s",
		async (action) => {
			await seed();
			await seed("duplicate");
			const before = await prisma.notificationChannel.findMany();
			const result = await request(action, action === "enable" ? { endpoint, keys } : { endpoint });
			expect(result.statusCode).toBe(409);
			expect(await prisma.notificationChannel.findMany()).toEqual(before);
		},
	);
	it.each(["state", "disable", "enable"])(
		"fails closed on unreadable matching evidence for %s",
		async (action) => {
			await seed();
			await seed("corrupt", secondEndpoint);
			await prisma.notificationChannel.update({
				where: { id: "corrupt" },
				data: { encryptedConfig: "synthetic-private-corrupt" },
			});
			const before = await prisma.notificationChannel.findMany();
			const response = await request(
				action,
				action === "enable" ? { endpoint, keys } : { endpoint },
			);
			expect(response.statusCode).toBe(409);
			expect(response.body).not.toContain("synthetic-private");
			expect(await prisma.notificationChannel.findMany()).toEqual(before);
		},
	);
	it("disables only selected device and retains config/proof/rules/history/subscriptions", async () => {
		const before = await seed();
		const other = await seed("second", secondEndpoint);
		await history();
		const result = await request("disable", { endpoint, ...(await selector()) });
		expect(result.statusCode).toBe(200);
		expect(result.json().state).toBe("disabled");
		expect(await read()).toEqual({ ...before, enabled: false, updatedAt: expect.any(Date) });
		expect(await prisma.notificationChannel.findUnique({ where: { id: "second" } })).toEqual(other);
		expect(await prisma.notificationSubscription.count()).toBe(2);
		expect(await prisma.notificationLog.count()).toBe(1);
		expect(await prisma.notificationRule.count()).toBe(1);
		expect(
			(
				await request("disable", {
					channelId: "owned",
					expectedRevision: result.json().configRevision,
				})
			).json(),
		).toEqual(result.json());
	});
	it("requires current revision for handle mutations and rejects stale settings", async () => {
		await seed();
		const selected = await selector();
		expect((await request("disable", { channelId: "owned" })).statusCode).toBe(400);
		expect((await request("enable", { endpoint, keys, channelId: "owned" })).statusCode).toBe(400);
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { name: "Synthetic changed" },
		});
		expect((await request("disable", selected)).statusCode).toBe(409);
		expect((await request("enable", { ...selected, endpoint, keys })).statusCode).toBe(409);
		expect((await read()).enabled).toBe(true);
	});
	it.each(["disable", "enable"])("rolls back actual SQL failures during %s", async (action) => {
		const before = await seed("owned", endpoint, "owner", action === "disable");
		const selected = await selector();
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_lifecycle_update BEFORE UPDATE ON \"notification_channels\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-database-error'); END",
		);
		const response = await request(action, {
			...selected,
			endpoint,
			...(action === "enable" ? { keys } : {}),
		});
		expect(response.statusCode).toBe(500);
		expect(response.body).not.toContain("synthetic-private");
		expect(await read()).toEqual(before);
	});
	it.each(["userId", "type", "name", "enabled", "encryptedConfig"])(
		"fences execution-time %s changes",
		async (field) => {
			await seed();
			const selected = await selector();
			const injection = injectSelection(async (client) => {
				await client.notificationChannel.update({
					where: { id: "owned" },
					data:
						field === "userId"
							? { userId: "foreign" }
							: field === "type"
								? { type: "WEBHOOK" }
								: field === "enabled"
									? { enabled: false }
									: field === "encryptedConfig"
										? { encryptedConfig: "synthetic-replaced" }
										: { name: "Synthetic changed" },
				});
			});
			await mount(injection.client);
			expect((await request("disable", { endpoint, ...selected })).statusCode).toBe(409);
			expect(injection.count()).toBe(1);
			expect((await read()).enabled).toBe(true);
			expect((await read()).userId).toBe("owner");
		},
	);
	it("explicitly enables a disabled endpoint while legacy enrollment remains disabled", async () => {
		const before = await seed("owned", endpoint, "owner", false);
		const legacy = await app.inject({
			method: "POST",
			url: "/push-subscription",
			headers: { "x-test-auth": "1" },
			payload: { endpoint, keys },
		});
		expect(legacy.json()).toEqual({ id: "owned", updated: true });
		expect((await read()).enabled).toBe(false);
		const result = await request("enable", { endpoint, keys });
		expect(result.statusCode).toBe(200);
		expect(result.json().state).toBe("enabled");
		expect(await read()).toEqual({ ...before, enabled: true, updatedAt: expect.any(Date) });
	});
	it("retains same channel on changed endpoint and key rotation, invalidating only Test proof", async () => {
		const before = await seed("owned", endpoint, "owner", false);
		await history();
		const result = await request("enable", {
			...(await selector()),
			endpoint: secondEndpoint,
			keys: { p256dh: "rotated", auth: "rotated-auth" },
		});
		expect(result.statusCode).toBe(200);
		expect(result.json().channelId).toBe("owned");
		expect(result.json().subscribedEventCount).toBe(1);
		const after = await read();
		expect(
			JSON.parse(encryptor.decrypt({ value: after.encryptedConfig, iv: after.configIv })),
		).toEqual({ endpoint: secondEndpoint, p256dh: "rotated", auth: "rotated-auth" });
		expect(after).toMatchObject({
			name: before.name,
			enabled: true,
			lastTestedAt: null,
			lastTestResult: null,
			lastSentAt: proof,
			lastSendResult: "success",
		});
		expect(await prisma.notificationChannel.count()).toBe(1);
		expect(await prisma.notificationLog.count()).toBe(1);
		expect(await prisma.notificationRule.count()).toBe(1);
	});
	it("preserves semantic no-op config/proof and refuses another device endpoint rebind", async () => {
		const before = await seed();
		expect((await request("enable", { endpoint, keys, ...(await selector()) })).statusCode).toBe(
			200,
		);
		expect(await read()).toEqual({ ...before, updatedAt: expect.any(Date) });
		await seed("second", secondEndpoint);
		expect(
			(await request("enable", { endpoint: secondEndpoint, keys, ...(await selector()) }))
				.statusCode,
		).toBe(409);
		expect(await prisma.notificationChannel.count()).toBe(2);
	});
	it("admits one new device without automatic subscriptions and enforces ten-device cap", async () => {
		const response = await request("enable", { endpoint, keys });
		expect(response.statusCode).toBe(200);
		expect(response.json().subscribedEventCount).toBe(0);
		for (let index = 1; index < 10; index++)
			await seed(`cap-${index}`, `https://synthetic.invalid/cap-${index}`);
		expect((await request("enable", { endpoint: secondEndpoint, keys })).statusCode).toBe(400);
		expect(await prisma.notificationChannel.count()).toBe(10);
		expect(await prisma.notificationSubscription.count()).toBe(0);
	});
	it("serializes concurrent same-endpoint admission and distinct-device cap", async () => {
		const same = await Promise.all([
			request("enable", { endpoint, keys }),
			request("enable", { endpoint, keys }),
		]);
		expect(same.map((value) => value.statusCode)).toEqual([200, 200]);
		expect(await prisma.notificationChannel.count()).toBe(1);
		for (let index = 1; index < 9; index++)
			await seed(`cap-${index}`, `https://synthetic.invalid/cap-${index}`);
		const distinct = await Promise.all([
			request("enable", { endpoint: secondEndpoint, keys }),
			request("enable", { endpoint: "https://synthetic.invalid/device-three", keys }),
		]);
		expect(distinct.map((value) => value.statusCode).sort()).toEqual([200, 400]);
		expect(await prisma.notificationChannel.count()).toBe(10);
	});
	it("fails lock or insert honestly and permits explicit retry", async () => {
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_lifecycle_lock BEFORE UPDATE ON \"User\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-lock-error'); END",
		);
		expect((await request("enable", { endpoint, keys })).statusCode).toBe(500);
		expect(await prisma.notificationChannel.count()).toBe(0);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_lifecycle_lock");
		await prisma.$executeRawUnsafe(
			"CREATE TRIGGER reject_lifecycle_insert BEFORE INSERT ON \"notification_channels\" BEGIN SELECT RAISE(ABORT, 'synthetic-private-insert-error'); END",
		);
		expect((await request("enable", { endpoint, keys })).statusCode).toBe(500);
		expect(await prisma.notificationChannel.count()).toBe(0);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_lifecycle_insert");
		expect((await request("enable", { endpoint, keys })).statusCode).toBe(200);
		expect(await prisma.notificationChannel.count()).toBe(1);
	});
	it("never decodes foreign corrupt config or lets a foreign handle create/adopt", async () => {
		await seed("foreign-device", endpoint, "foreign");
		await prisma.notificationChannel.update({
			where: { id: "foreign-device" },
			data: { encryptedConfig: "synthetic-private-corrupt" },
		});
		expect((await request("state", { endpoint })).json()).toEqual({
			channelId: null,
			configRevision: null,
			state: "unregistered",
			subscribedEventCount: 0,
		});
		expect(
			(
				await request("enable", {
					endpoint,
					keys,
					channelId: "foreign-device",
					expectedRevision: "a".repeat(64),
				})
			).statusCode,
		).toBe(404);
		expect((await request("disable", { endpoint })).statusCode).toBe(404);
		expect(await prisma.notificationChannel.count()).toBe(1);
	});
	it.each(["userId", "type", "name", "enabled", "configIv"])(
		"enable fences execution-time %s changes and rolls back",
		async (field) => {
			await seed("owned", endpoint, "owner", false);
			const selected = await selector();
			const injection = injectSelection(async (client) => {
				await client.notificationChannel.update({
					where: { id: "owned" },
					data:
						field === "userId"
							? { userId: "foreign" }
							: field === "type"
								? { type: "WEBHOOK" }
								: field === "enabled"
									? { enabled: true }
									: field === "configIv"
										? { configIv: "synthetic-replaced" }
										: { name: "Synthetic changed" },
				});
			});
			await mount(injection.client);
			expect(
				(await request("enable", { endpoint: secondEndpoint, keys, ...selected })).statusCode,
			).toBe(409);
			expect(injection.count()).toBe(1);
			expect((await read()).enabled).toBe(false);
			expect((await read()).userId).toBe("owner");
		},
	);
});
