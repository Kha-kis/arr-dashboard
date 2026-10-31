import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationChannelType } from "@arr/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { DedupGate } from "../../lib/notifications/dedup-gate.js";
import { NotificationFailureError } from "../../lib/notifications/failure-diagnostics.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../lib/notifications/notification-service.js";
import { RetryHandler } from "../../lib/notifications/retry-handler.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const marker = "••••••••";
const secret = "synthetic-private-config-credential";
const encrypted = new Encryptor(Buffer.alloc(32, 47).toString("base64"));
const fixtures: Array<{
	type: NotificationChannelType;
	config: Record<string, unknown>;
	hidden: string[];
}> = [
	{
		type: "DISCORD",
		config: { webhookUrl: `https://synthetic.invalid/webhooks/${secret}` },
		hidden: ["webhookUrl"],
	},
	{
		type: "SLACK",
		config: { webhookUrl: `https://synthetic.invalid/services/${secret}` },
		hidden: ["webhookUrl"],
	},
	{
		type: "TELEGRAM",
		config: { botToken: secret, chatId: "synthetic-chat" },
		hidden: ["botToken"],
	},
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
		hidden: ["password"],
	},
	{
		type: "BROWSER_PUSH",
		config: { endpoint: `https://synthetic.invalid/push/${secret}`, p256dh: secret, auth: secret },
		hidden: ["endpoint", "p256dh", "auth"],
	},
	{ type: "PUSHBULLET", config: { apiToken: secret }, hidden: ["apiToken"] },
	{
		type: "PUSHOVER",
		config: { userKey: secret, apiToken: secret },
		hidden: ["userKey", "apiToken"],
	},
	{
		type: "GOTIFY",
		config: { serverUrl: `https://${secret}@synthetic.invalid/?token=${secret}`, appToken: secret },
		hidden: ["serverUrl", "appToken"],
	},
	{
		type: "NTFY",
		config: {
			serverUrl: `https://synthetic.invalid/${secret}?key=${secret}`,
			topic: "synthetic-topic",
			token: secret,
		},
		hidden: ["serverUrl", "token"],
	},
	{
		type: "WEBHOOK",
		config: {
			url: `https://synthetic.invalid/${secret}`,
			method: "POST",
			headers: { Authorization: `Bearer ${secret}`, "X-Arbitrary-Name": secret },
			secret,
		},
		hidden: ["url", "headers", "secret"],
	},
];
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let service: NotificationService;
let retry: RetryHandler;
let dedup: DedupGate;
let logs: string[];
let pendingUpdate: { enter: () => void; resume: Promise<void> } | undefined;
let pendingUpdateError: Error | undefined;
let testAction: () => Promise<void>;
let testCalls: number;
const testedAt = new Date("2026-10-06T01:00:00.000Z");

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "notification-config-edit-"));
	const path = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(path);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other-owner", username: "synthetic-other" },
		],
	});
}, 30_000);
beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_channel_config_edit"');
	await prisma.notificationChannel.deleteMany({});
	await prisma.notificationLog.deleteMany({});
	logs = [];
	pendingUpdate = undefined;
	pendingUpdateError = undefined;
	const logger: FastifyBaseLogger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => logs.push(line) },
	);
	const dispatcher = new NotificationDispatcher();
	testCalls = 0;
	testAction = async () => {
		throw new Error("Unexpected provider Test");
	};
	// Replace only the external provider boundary; route, service and SQL stay real.
	for (const { type } of fixtures)
		dispatcher.registerSender(type, {
			test: async () => {
				testCalls++;
				await testAction();
			},
			send: async () => {
				throw new Error("Unexpected provider delivery");
			},
		});
	dedup = new DedupGate(60_000);
	retry = new RetryHandler(
		(type, config, payload) => dispatcher.send(type, config, payload),
		(...args) => service.logDelivery(...args),
		logger,
	);
	service = new NotificationService(
		prisma,
		encrypted,
		dispatcher,
		logger,
		dedup,
		retry,
		"https://synthetic.invalid",
	);
	app = Fastify({ loggerInstance: logger });
	// Delay only the real query's admission; all persistence stays real SQLite.
	const scheduledQueries = prisma.$extends({
		query: {
			notificationChannel: {
				async update({ args, query }) {
					const pause = pendingUpdate;
					pendingUpdate = undefined;
					if (pause) {
						pause.enter();
						await pause.resume;
					}
					const failure = pendingUpdateError;
					pendingUpdateError = undefined;
					if (failure) throw failure;
					return query(args);
				},
			},
		},
	});
	// Keep the base client's lifecycle interface, including $on, intact.
	app.decorate(
		"prisma",
		new Proxy(prisma, {
			get(target, property, receiver) {
				if (property === "notificationChannel") return scheduledQueries.notificationChannel;
				return Reflect.get(target, property, receiver);
			},
		}),
	);
	app.decorate("encryptor", encrypted);
	app.decorate("notificationService", service);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
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

async function channel(
	type: NotificationChannelType,
	config: unknown,
	id = "owned",
	userId = "owner",
) {
	const value = encrypted.encrypt(typeof config === "string" ? config : JSON.stringify(config));
	return prisma.notificationChannel.create({
		data: {
			id,
			userId,
			name: "Synthetic channel",
			type,
			encryptedConfig: value.value,
			configIv: value.iv,
		},
	});
}
async function stored(id = "owned") {
	const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id } });
	return JSON.parse(encrypted.decrypt({ value: row.encryptedConfig, iv: row.configIv }));
}
function read(id = "owned") {
	return createInjectAuthenticated(app)("GET", `/channels/${id}/config`);
}
function save(config: Record<string, unknown>, id = "owned") {
	return createInjectAuthenticated(app)("PUT", `/channels/${id}`, {
		body: { name: "Renamed synthetic channel", config },
	});
}
function pauseNextUpdate() {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		release = resolve;
	});
	pendingUpdate = { enter, resume };
	return { entered, release };
}

async function recordDiagnostics(result: "success" | "failed" = "success", id = "owned") {
	return prisma.notificationChannel.update({
		where: { id },
		data: {
			lastTestedAt: testedAt,
			lastTestResult: result,
			lastSentAt: testedAt,
			lastSendResult: "failed",
		},
	});
}

describe("notification configuration editing with real encryption and populated SQLite", () => {
	it.each(["success", "failed"] as const)(
		"clears previous %s Test evidence when credentials, recipient or transport settings change",
		async (result) => {
			const original = fixtures.find((f) => f.type === "EMAIL")!.config;
			await channel("EMAIL", original);
			await channel("EMAIL", original, "other", "other-owner");
			const other = await recordDiagnostics(result, "other");
			const history = await prisma.notificationLog.create({
				data: {
					channelId: "owned",
					channelType: "EMAIL",
					eventType: "BACKUP_COMPLETED",
					title: "Synthetic history",
					body: "Synthetic body",
					status: "sent",
				},
			});
			for (const config of [
				{ ...original, password: "synthetic-replacement" },
				{ ...original, to: "replacement@synthetic.invalid" },
				{ ...original, port: 465, secure: true },
			]) {
				const before = await recordDiagnostics(result);
				const response = await save(config);
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({ lastTestedAt: null, lastTestResult: null });
				const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
				expect(row).toMatchObject({
					lastTestedAt: null,
					lastTestResult: null,
					lastSentAt: testedAt,
					lastSendResult: "failed",
				});
				expect(row.encryptedConfig).not.toBe(before.encryptedConfig);
				expect(row.configIv).not.toBe(before.configIv);
				expect(await stored()).toEqual(config);
				expect((await createInjectAuthenticated(app)("GET", "/channels")).json()[0]).toMatchObject({
					lastTestedAt: null,
					lastTestResult: null,
				});
			}
			expect(await prisma.notificationLog.findMany()).toEqual([history]);
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } }),
			).toEqual(other);
			expect(testCalls).toBe(0);
		},
	);

	it.each(["success", "failed"] as const)(
		"preserves %s diagnostics on metadata-only edits",
		async (result) => {
			await channel("DISCORD", fixtures[0]!.config);
			const before = await recordDiagnostics(result);
			const response = await createInjectAuthenticated(app)("PUT", "/channels/owned", {
				body: { name: "Renamed metadata", enabled: false },
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				lastTestedAt: testedAt.toISOString(),
				lastTestResult: result,
			});
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toMatchObject({
				encryptedConfig: before.encryptedConfig,
				configIv: before.configIv,
				lastTestedAt: testedAt,
				lastTestResult: result,
				lastSentAt: testedAt,
				lastSendResult: "failed",
			});
			expect(testCalls).toBe(0);
		},
	);

	it.each(["full", "masked"] as const)(
		"preserves encrypted config and Test evidence for %s normalized settings",
		async (kind) => {
			const original = {
				url: "https://synthetic.invalid/hook",
				headers: { "X-First": "one", "X-Second": "two" },
			};
			await channel("WEBHOOK", original);
			const before = await recordDiagnostics("failed");
			const incoming =
				kind === "masked"
					? { ...(await read()).json().config, method: "POST" }
					: { headers: { "X-Second": "two", "X-First": "one" }, method: "POST", url: original.url };
			const response = await save(incoming);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				lastTestedAt: testedAt.toISOString(),
				lastTestResult: "failed",
			});
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toMatchObject({
				encryptedConfig: before.encryptedConfig,
				configIv: before.configIv,
				lastTestedAt: testedAt,
				lastTestResult: "failed",
			});
			expect(await stored()).toEqual(original);
			expect(testCalls).toBe(0);
		},
	);

	it.each(["ciphertext", "json", "schema"] as const)(
		"repairs corrupt stored %s with a valid full replacement and clears Test evidence",
		async (kind) => {
			await channel(
				"DISCORD",
				kind === "json" ? "invalid-json" : kind === "schema" ? {} : fixtures[0]!.config,
			);
			await recordDiagnostics("success");
			if (kind === "ciphertext")
				await prisma.notificationChannel.update({
					where: { id: "owned" },
					data: { encryptedConfig: "invalid ciphertext" },
				});
			const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			expect((await save({ webhookUrl: marker })).statusCode).toBe(500);
			expect((await save({ webhookUrl: "invalid URL" })).statusCode).toBe(400);
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toEqual(before);
			const config = { webhookUrl: "https://replacement.synthetic.invalid/hook" };
			const response = await save(config);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ lastTestedAt: null, lastTestResult: null });
			expect(await stored()).toEqual(config);
			expect(testCalls).toBe(0);
		},
	);

	it("does not clear a winning connection's Test evidence when replacement loses the SQL fence", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		await recordDiagnostics("success");
		const pause = pauseNextUpdate();
		const saving = save({ webhookUrl: "https://losing.synthetic.invalid/hook" });
		await pause.entered;
		try {
			const config = { webhookUrl: "https://winning.synthetic.invalid/hook" };
			const value = encrypted.encrypt(JSON.stringify(config));
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: { encryptedConfig: value.value, configIv: value.iv, lastTestResult: "failed" },
			});
			const winner = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			pause.release();
			const response = await saving;
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ code: "CHANNEL_SETTINGS_CONFLICT" });
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toEqual(winner);
			expect(await stored()).toEqual(config);
		} finally {
			pause.release();
			await saving;
		}
	});

	it.each([
		["changed", "success"],
		["changed", "failed"],
		["equivalent", "success"],
		["equivalent", "failed"],
	] as const)(
		"fences a late %s connection Test with provider %s after editing",
		async (kind, result) => {
			await channel("DISCORD", fixtures[0]!.config);
			await recordDiagnostics("success");
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				release = resolve;
			});
			testAction = async () => {
				enter();
				await resume;
				if (result === "failed") throw new NotificationFailureError("authentication");
			};
			const testing = createInjectAuthenticated(app)("POST", "/channels/owned/test");
			await entered;
			try {
				const config =
					kind === "changed"
						? { webhookUrl: "https://replacement.synthetic.invalid/hook" }
						: { webhookUrl: marker };
				expect((await save(config)).statusCode).toBe(200);
				release();
				const response = await testing;
				expect(response.statusCode).toBe(result === "success" ? 200 : 400);
				expect(response.json()).toMatchObject({
					success: result === "success",
					statusRecorded: kind === "equivalent",
				});
				const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
				if (kind === "changed")
					expect(row).toMatchObject({ lastTestedAt: null, lastTestResult: null });
				else {
					expect(row.lastTestResult).toBe(result);
					expect(row.lastTestedAt).not.toBeNull();
				}
				expect(testCalls).toBe(1);
				expect(await prisma.notificationLog.count()).toBe(0);
			} finally {
				release();
				await testing;
			}
		},
	);
	it("returns an opaque settings revision that ignores delivery diagnostics but changes with editable settings", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const before = await read();
		expect(before.json().configRevision).toMatch(/^[a-f0-9]{64}$/);
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { lastTestedAt: new Date(), lastTestResult: "success" },
		});
		expect((await read()).json().configRevision).toBe(before.json().configRevision);
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { name: "Changed elsewhere" },
		});
		expect((await read()).json().configRevision).not.toBe(before.json().configRevision);
		expect(before.payload).not.toContain(secret);
		for (const privateField of ["userId", "encryptedConfig", "configIv"]) {
			expect(before.json()).not.toHaveProperty(privateField);
		}
	});

	it("keeps a conditional edit valid across diagnostic and subscription commits before its SQL write", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const draft = (await read()).json();
		const pause = pauseNextUpdate();
		const saving = createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: {
				name: "Saved after diagnostics",
				config: draft.config,
				expectedRevision: draft.configRevision,
			},
		});
		await pause.entered;
		try {
			const testedAt = new Date("2026-01-01T00:00:00.000Z");
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: {
					lastTestedAt: testedAt,
					lastTestResult: "success",
					lastSentAt: testedAt,
					lastSendResult: "failed",
				},
			});
			await prisma.notificationSubscription.create({
				data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
			});
			pause.release();
			const response = await saving;
			expect(response.statusCode).toBe(200);
			expect(response.json().subscriptions).toEqual(["HUNT_COMPLETED"]);
			const result = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			expect(result).toMatchObject({
				name: "Saved after diagnostics",
				lastTestedAt: testedAt,
				lastTestResult: "success",
				lastSentAt: testedAt,
				lastSendResult: "failed",
			});
			expect(await stored()).toEqual(fixtures[0]!.config);
		} finally {
			pause.release();
			await saving;
		}
	});

	it.each(["deleted", "changed-owner"])(
		"returns an owned 404 when the target is %s before the SQL write",
		async (kind) => {
			await channel("DISCORD", fixtures[0]!.config);
			await recordDiagnostics("failed");
			const draft = (await read()).json();
			const pause = pauseNextUpdate();
			const saving = createInjectAuthenticated(app)("PUT", "/channels/owned", {
				body: {
					name: "Must not apply",
					config: draft.config,
					expectedRevision: draft.configRevision,
				},
			});
			await pause.entered;
			try {
				if (kind === "deleted") await prisma.notificationChannel.delete({ where: { id: "owned" } });
				else
					await prisma.notificationChannel.update({
						where: { id: "owned" },
						data: { userId: "other-owner" },
					});
				const winner = await prisma.notificationChannel.findUnique({ where: { id: "owned" } });
				pause.release();
				const response = await saving;
				expect(response.statusCode).toBe(404);
				expect(response.json()).toEqual({ error: "Channel not found" });
				expect(await prisma.notificationChannel.findUnique({ where: { id: "owned" } })).toEqual(
					winner,
				);
			} finally {
				pause.release();
				await saving;
			}
		},
	);

	it("fences a legacy metadata-only patch against intervening credential rotation", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const pause = pauseNextUpdate();
		const saving = createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: { enabled: false },
		});
		await pause.entered;
		try {
			const changed = encrypted.encrypt(
				JSON.stringify({ webhookUrl: "https://new.synthetic.invalid/hook" }),
			);
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: { encryptedConfig: changed.value, configIv: changed.iv },
			});
			const winner = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			pause.release();
			const response = await saving;
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ code: "CHANNEL_SETTINGS_CONFLICT" });
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toEqual(winner);
		} finally {
			pause.release();
			await saving;
		}
	});

	it("does not misclassify an arbitrary coded write error as a settings conflict", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		pendingUpdateError = Object.assign(new Error("synthetic write fault"), { code: "P2025" });
		const response = await save({ webhookUrl: marker });
		expect(response.statusCode).toBe(500);
		expect(response.json()).not.toHaveProperty("code", "CHANNEL_SETTINGS_CONFLICT");
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			before,
		);
	});

	it("rejects stale retained settings before decrypting a now-corrupted current config", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const draft = (await read()).json();
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { encryptedConfig: "invalid ciphertext" },
		});
		const winner = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		const response = await createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: {
				name: "Must not apply",
				config: draft.config,
				expectedRevision: draft.configRevision,
			},
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ code: "CHANNEL_SETTINGS_CONFLICT" });
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			winner,
		);
	});

	it("rejects a stale conditional browser draft and allows explicit fresh-read recovery", async () => {
		await channel("WEBHOOK", fixtures.find((f) => f.type === "WEBHOOK")!.config);
		const draft = (await read()).json();
		const current = {
			...fixtures.find((f) => f.type === "WEBHOOK")!.config,
			url: "https://new.synthetic.invalid/hook",
			method: "PUT",
			secret: "synthetic-new-current",
		};
		const changed = encrypted.encrypt(JSON.stringify(current));
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: {
				name: "Current other-tab name",
				enabled: false,
				encryptedConfig: changed.value,
				configIv: changed.iv,
			},
		});
		const winner = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		const response = await createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: {
				name: "Stale draft",
				enabled: true,
				config: draft.config,
				expectedRevision: draft.configRevision ?? "a".repeat(64),
			},
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ code: "CHANNEL_SETTINGS_CONFLICT" });
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			winner,
		);
		const fresh = (await read()).json();
		const retryResponse = await createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: {
				name: "Reapplied draft",
				config: fresh.config,
				expectedRevision: fresh.configRevision,
			},
		});
		expect(retryResponse.statusCode).toBe(200);
		expect(await stored()).toEqual(current);
		expect(response.payload + logs.join("\n")).not.toContain("synthetic-new-current");
	});

	it.each(["credentials", "metadata"])(
		"rejects an intervening real database %s commit even for a legacy caller",
		async (kind) => {
			await channel("DISCORD", fixtures[0]!.config);
			await recordDiagnostics("success");
			const draft = (await read()).json().config;
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((done) => {
				enter = done;
			});
			const resume = new Promise<void>((done) => {
				release = done;
			});
			pendingUpdate = { enter, resume };
			const stale = save(draft);
			await entered;
			try {
				const changed = encrypted.encrypt(
					JSON.stringify({ webhookUrl: "https://new.synthetic.invalid/webhook" }),
				);
				await prisma.notificationChannel.update({
					where: { id: "owned" },
					data:
						kind === "credentials"
							? { encryptedConfig: changed.value, configIv: changed.iv }
							: { name: "Committed winner", enabled: false },
				});
				const winner = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: "owned" },
				});
				release();
				const response = await stale;
				expect(response.statusCode).toBe(409);
				expect(
					await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
				).toEqual(winner);
			} finally {
				release();
				await stale;
			}
		},
	);

	it("rejects malformed revision without changing the owned row", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		const response = await createInjectAuthenticated(app)("PUT", "/channels/owned", {
			body: { name: "Must not apply", expectedRevision: "invalid" },
		});
		expect(response.statusCode).toBe(400);
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			before,
		);
	});

	it.each(fixtures)(
		"$type hides credentials and retains the exact owned config on rename",
		async ({ type, config, hidden }) => {
			await channel(type, config);
			const before = await recordDiagnostics("success");
			await channel(type, config, "other", "other-owner");
			const otherBefore = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: "other" },
			});
			const response = await read();
			expect(response.statusCode).toBe(200);
			expect(response.payload).not.toContain(secret);
			const projected = response.json().config;
			for (const key of hidden) expect(projected[key]).toBe(marker);
			for (const [key, value] of Object.entries(config))
				if (!hidden.includes(key)) expect(projected[key]).toEqual(value);
			expect((await save(projected)).statusCode).toBe(200);
			expect((await save(config)).statusCode).toBe(200);
			expect(await stored()).toEqual(config);
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toMatchObject({
				encryptedConfig: before.encryptedConfig,
				configIv: before.configIv,
				lastTestedAt: testedAt,
				lastTestResult: "success",
			});
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } }),
			).toEqual(otherBefore);
			expect(logs.join("\n")).not.toContain(secret);
		},
	);

	it("retains current server credentials after a stale edit read, then replaces and explicitly clears optional values", async () => {
		const original = fixtures.find((f) => f.type === "WEBHOOK")!.config;
		await channel("WEBHOOK", original);
		const projected = (await read()).json().config;
		const current = {
			...original,
			secret: "synthetic-new-stored-secret",
			headers: { Authorization: "synthetic-new-stored-header" },
		};
		const value = encrypted.encrypt(JSON.stringify(current));
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: { encryptedConfig: value.value, configIv: value.iv },
		});
		expect((await save(projected)).statusCode).toBe(200);
		expect(await stored()).toEqual(current);
		const replaced = {
			...projected,
			url: "https://replacement.synthetic.invalid/hook",
			secret: "synthetic-replacement",
			headers: { "X-New-Header": "synthetic-new" },
		};
		expect((await save(replaced)).statusCode).toBe(200);
		expect(await stored()).toEqual(replaced);
		expect((await save({ ...replaced, secret: "", headers: {} })).statusCode).toBe(200);
		expect(await stored()).toEqual({ ...replaced, secret: "", headers: {} });
	});

	it.each([
		{
			type: "EMAIL" as const,
			config: fixtures.find((f) => f.type === "EMAIL")!.config,
			request: { ...fixtures.find((f) => f.type === "EMAIL")!.config, host: marker },
		},
		{
			type: "WEBHOOK" as const,
			config: { url: "https://synthetic.invalid/hook", method: "POST" },
			request: { url: "https://synthetic.invalid/hook", method: "POST", secret: marker },
		},
	])(
		"rejects retention of a nonsecret or missing field without applying the accompanying rename: $type",
		async ({ type, config, request }) => {
			await channel(type, config);
			const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			expect((await save(request)).statusCode).toBe(400);
			expect(
				await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
			).toEqual(before);
		},
	);

	it("does not resolve retained values from a different owner's same-name channel", async () => {
		await channel("DISCORD", fixtures[0]!.config, "other", "other-owner");
		const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } });
		expect((await read("other")).statusCode).toBe(404);
		expect((await save({ webhookUrl: marker }, "other")).statusCode).toBe(404);
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } })).toEqual(
			before,
		);
	});

	it.each([
		null,
		[],
		{ url: { nested: secret } },
		{ url: `https://synthetic.invalid/${secret}`, headers: { nested: { token: secret } } },
	])("fails closed on malformed stored config without exposing it: %#", async (config) => {
		await channel("WEBHOOK", config);
		const response = await read();
		expect(response.statusCode).toBe(500);
		expect(response.payload).not.toContain(secret);
		expect(logs.join("\n")).not.toContain(secret);
	});

	it("rejects a retained-value placeholder on create rather than storing it as a new credential", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/channels", {
			body: { name: "Synthetic new", type: "PUSHBULLET", config: { apiToken: marker } },
		});
		expect(response.statusCode).toBe(400);
		expect(await prisma.notificationChannel.count()).toBe(0);
	});

	it("keeps config and rename atomic on a real write fault, then retries the same owned edit", async () => {
		await channel("DISCORD", fixtures[0]!.config);
		await recordDiagnostics("failed");
		const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		const config = { webhookUrl: "https://replacement.synthetic.invalid/hook" };
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_channel_config_edit BEFORE UPDATE ON notification_channels WHEN NEW.id = 'owned' BEGIN SELECT RAISE(ABORT, 'synthetic_config_write_failure'); END`,
		);
		expect((await save(config)).statusCode).toBe(500);
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			before,
		);
		await prisma.$executeRawUnsafe('DROP TRIGGER "reject_channel_config_edit"');
		expect((await save(config)).statusCode).toBe(200);
		expect(await stored()).toEqual(config);
		expect(
			await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
		).toMatchObject({
			lastTestedAt: null,
			lastTestResult: null,
			lastSentAt: testedAt,
			lastSendResult: "failed",
		});
		expect(
			(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).name,
		).toBe("Renamed synthetic channel");
	});

	it("does not leak corrupted retained-config plaintext or apply a partial rename", async () => {
		await channel("DISCORD", `invalid-json-${secret}`);
		await recordDiagnostics("failed");
		const before = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		const response = await save({ webhookUrl: marker });
		expect(response.statusCode).toBe(500);
		expect(response.payload).not.toContain(secret);
		expect(logs.join("\n")).not.toContain(secret);
		expect(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } })).toEqual(
			before,
		);
	});
});
