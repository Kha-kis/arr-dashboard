import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { NotificationFailureCategory } from "../../lib/notifications/types.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const privateMarker = "synthetic-private-test-credential";
const privateError = `https://synthetic.invalid/${privateMarker} provider response ${privateMarker}`;
const encryptor = new Encryptor(Buffer.alloc(32, 59).toString("base64"));
const originalTime = new Date("2024-06-01T00:00:00Z");
const winnerTime = new Date("2024-07-01T00:00:00Z");
const config = { webhookUrl: `https://synthetic.invalid/${privateMarker}` };
let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let service: NotificationService;
let dispatcher: NotificationDispatcher;
let retry: RetryHandler;
let dedup: DedupGate;
let logs: string[];
let testAction: (testedConfig: Record<string, unknown>) => Promise<void>;
let testCalls: number;
let sendCalls: number;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "notification-test-outcomes-"));
	const path = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(path);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other-owner", username: "synthetic-other-owner" },
		],
	});
}, 30_000);

beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_test_status"');
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	const encrypted = encryptor.encrypt(JSON.stringify(config));
	await prisma.notificationChannel.createMany({
		data: [
			{
				id: "owned",
				userId: "owner",
				name: privateMarker,
				type: "DISCORD",
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
				lastTestedAt: originalTime,
				lastTestResult: "failed",
			},
			{
				id: "other",
				userId: "other-owner",
				name: "Synthetic other",
				type: "DISCORD",
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
				lastTestedAt: originalTime,
				lastTestResult: "success",
			},
		],
	});
	logs = [];
	testCalls = 0;
	sendCalls = 0;
	testAction = async () => {};
	const logger: FastifyBaseLogger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => logs.push(line) },
	);
	dispatcher = new NotificationDispatcher();
	dispatcher.registerSender("DISCORD", {
		test: async (testedConfig) => {
			testCalls++;
			await testAction(testedConfig);
		},
		send: async () => {
			sendCalls++;
			return { success: true, retryable: false };
		},
	});
	dedup = new DedupGate();
	retry = new RetryHandler(
		(type, credentials, payload) => dispatcher.send(type, credentials, payload),
		(...args) => service.logDelivery(...args),
		logger,
	);
	service = new NotificationService(
		prisma,
		encryptor,
		dispatcher,
		logger,
		dedup,
		retry,
		"https://synthetic.invalid",
	);
	app = Fastify({ loggerInstance: logger });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("notificationService", service);
	setupAuthInjection(app, { id: "owner", username: "synthetic-owner" });
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

async function testChannel(id = "owned") {
	return createInjectAuthenticated(app)("POST", `/channels/${id}/test`);
}

async function expectNoDeliveryOrRetry() {
	expect(sendCalls).toBe(0);
	expect(retry.pendingCount).toBe(0);
	expect(await prisma.notificationLog.count()).toBe(0);
}

describe("real notification Test outcome and persistence boundary", () => {
	it("records a confirmed Test only on its owned connection and admits exactly one Test", async () => {
		testAction = async (testedConfig) => {
			expect(testedConfig).toEqual(config);
		};
		const response = await testChannel();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ success: true, statusRecorded: true });
		const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
		expect(row.lastTestResult).toBe("success");
		expect(row.lastTestedAt!.getTime()).toBeGreaterThan(originalTime.getTime());
		expect(
			(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } })).lastTestedAt,
		).toEqual(originalTime);
		expect(testCalls).toBe(1);
		await expectNoDeliveryOrRetry();
	});

	const categories: Array<[NotificationFailureCategory, string]> = [
		[
			"authentication",
			"Provider authentication failed. Check channel credentials and permissions.",
		],
		[
			"rate-limited",
			"Provider rate limited delivery. Wait before retrying; check the provider limits.",
		],
		[
			"provider-unavailable",
			"Provider is unavailable. Check provider availability before retrying.",
		],
		["timeout", "Delivery timed out. Check provider availability and network connectivity."],
		["transport", "Network delivery failed. Check connectivity, TLS and proxy settings."],
		["rejected", "Provider rejected delivery. Check channel settings and recipient permissions."],
		[
			"subscription-expired",
			"Browser push subscription expired. Enable browser notifications again.",
		],
		[
			"configuration",
			"Channel configuration could not be read. Check and re-save channel settings.",
		],
		["unsupported", "Channel delivery is unsupported. Check the channel type and server setup."],
		[
			"retry-exhausted",
			"Delivery was not confirmed after retries. Check channel settings and provider availability.",
		],
		[
			"shutdown",
			"Pending delivery was not confirmed before shutdown. Check delivery history after startup.",
		],
		["unknown", "Delivery was not confirmed. Check channel settings and provider availability."],
	];
	it.each(categories)(
		"preserves typed %s failure through actual service and route",
		async (category, message) => {
			testAction = async () => {
				throw new NotificationFailureError(category);
			};
			const response = await testChannel();
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				success: false,
				error: "Test failed",
				message,
				failureCategory: category,
				statusRecorded: true,
			});
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }))
					.lastTestResult,
			).toBe("failed");
			expect(response.payload + logs.join("\n")).not.toContain(privateMarker);
			expect(testCalls).toBe(1);
			await expectNoDeliveryOrRetry();
		},
	);

	it.each(["success", "failure"] as const)(
		"keeps provider %s when real SQL rejects status persistence",
		async (outcome) => {
			testAction = async () => {
				if (outcome === "failure") throw new NotificationFailureError("authentication");
			};
			await prisma.$executeRawUnsafe(
				`CREATE TRIGGER "reject_test_status" BEFORE UPDATE OF "lastTestedAt", "lastTestResult" ON "notification_channels" BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`,
			);
			const response = await testChannel();
			expect(response.statusCode).toBe(outcome === "success" ? 200 : 400);
			expect(response.json()).toMatchObject(
				outcome === "success"
					? { success: true, statusRecorded: false }
					: { success: false, failureCategory: "authentication", statusRecorded: false },
			);
			const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } });
			expect(row.lastTestedAt).toEqual(originalTime);
			expect(row.lastTestResult).toBe("failed");
			expect(response.payload + logs.join("\n")).not.toContain(privateMarker);
			expect(logs.map((line) => JSON.parse(line))).toContainEqual(
				expect.objectContaining({
					operation: "notification-test-status-write",
					status: "failed",
				}),
			);
			expect(testCalls).toBe(1);
			await expectNoDeliveryOrRetry();
		},
	);

	it.each(["success", "failure"] as const)(
		"service itself persists its %s outcome",
		async (outcome) => {
			testAction = async () => {
				if (outcome === "failure") throw new NotificationFailureError("timeout");
			};
			expect(await service.testChannel("owned", "owner")).toEqual(
				outcome === "success"
					? { success: true, statusRecorded: true }
					: { success: false, failureCategory: "timeout", statusRecorded: true },
			);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }))
					.lastTestResult,
			).toBe(outcome === "success" ? "success" : "failed");
		},
	);

	for (const outcome of ["success", "failure"] as const) {
		it.each(["credentials", "ciphertext", "iv", "type", "owner", "delete"] as const)(
			`${outcome} completion cannot overwrite changed %s`,
			async (change) => {
				const entered = deferred();
				const release = deferred();
				testAction = async () => {
					entered.resolve();
					await release.promise;
					if (outcome === "failure") throw new NotificationFailureError("authentication");
				};
				const pending = testChannel();
				await entered.promise;
				try {
					if (change === "delete")
						await prisma.notificationChannel.delete({ where: { id: "owned" } });
					else {
						const replacement = encryptor.encrypt(
							JSON.stringify({ webhookUrl: "https://synthetic.invalid/new" }),
						);
						await prisma.notificationChannel.update({
							where: { id: "owned" },
							data: {
								lastTestedAt: winnerTime,
								lastTestResult: "winner-status",
								...(change === "credentials"
									? { encryptedConfig: replacement.value, configIv: replacement.iv }
									: {}),
								...(change === "ciphertext" ? { encryptedConfig: replacement.value } : {}),
								...(change === "iv" ? { configIv: replacement.iv } : {}),
								...(change === "type" ? { type: "SLACK" } : {}),
								...(change === "owner" ? { userId: "other-owner" } : {}),
							},
						});
					}
				} finally {
					release.resolve();
				}
				const response = await pending;
				const row = await prisma.notificationChannel.findUnique({ where: { id: "owned" } });
				if (change === "delete") expect(row).toBeNull();
				else
					expect(row).toMatchObject({ lastTestedAt: winnerTime, lastTestResult: "winner-status" });
				expect(response.statusCode).toBe(outcome === "success" ? 200 : 400);
				expect(response.json()).toMatchObject({
					success: outcome === "success",
					statusRecorded: false,
				});
				expect(testCalls).toBe(1);
				await expectNoDeliveryOrRetry();
			},
		);
	}

	it("independent metadata and diagnostics updates do not invalidate the tested connection", async () => {
		const entered = deferred();
		const release = deferred();
		testAction = async () => {
			entered.resolve();
			await release.promise;
		};
		const pending = testChannel();
		await entered.promise;
		try {
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: {
					name: "Renamed synthetic channel",
					enabled: false,
					lastSentAt: winnerTime,
					lastSendResult: "failed",
					lastTestedAt: winnerTime,
					lastTestResult: "failed",
				},
			});
		} finally {
			release.resolve();
		}
		expect((await pending).json()).toEqual({ success: true, statusRecorded: true });
		expect(
			await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "owned" } }),
		).toMatchObject({
			name: "Renamed synthetic channel",
			enabled: false,
			lastSentAt: winnerTime,
			lastSendResult: "failed",
			lastTestResult: "success",
		});
	});

	it.each(["other", "missing"])(
		"does not admit a sender or alter diagnostics for unavailable owned target %s",
		async (id) => {
			const response = await testChannel(id);
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				success: false,
				failureCategory: "unknown",
				statusRecorded: false,
			});
			expect(testCalls).toBe(0);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: "other" } }))
					.lastTestedAt,
			).toEqual(originalTime);
			await expectNoDeliveryOrRetry();
		},
	);

	it.each(["ciphertext", "json", "null", "array", "schema"])(
		"rejects corrupt %s configuration before sender admission",
		async (corruption) => {
			const value =
				corruption === "json"
					? `not-json-${privateMarker}`
					: corruption === "null"
						? "null"
						: corruption === "array"
							? "[]"
							: JSON.stringify({ webhookUrl: 12 });
			const encrypted = encryptor.encrypt(value);
			await prisma.notificationChannel.update({
				where: { id: "owned" },
				data: {
					encryptedConfig: corruption === "ciphertext" ? privateMarker : encrypted.value,
					configIv: encrypted.iv,
				},
			});
			const response = await testChannel();
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				success: false,
				failureCategory: "configuration",
				statusRecorded: true,
			});
			expect(response.payload + logs.join("\n")).not.toContain(privateMarker);
			expect(testCalls).toBe(0);
			await expectNoDeliveryOrRetry();
		},
	);

	it("reports an unregistered sender as unsupported with no provider admission", async () => {
		const encrypted = encryptor.encrypt(
			JSON.stringify({
				endpoint: "https://synthetic.invalid/push",
				p256dh: "synthetic-key",
				auth: "synthetic-auth",
			}),
		);
		await prisma.notificationChannel.update({
			where: { id: "owned" },
			data: {
				type: "BROWSER_PUSH",
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
			},
		});
		const response = await testChannel();
		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			success: false,
			failureCategory: "unsupported",
			statusRecorded: true,
		});
		expect(testCalls).toBe(0);
		await expectNoDeliveryOrRetry();
	});

	it.each(["error", "string", "shape", "invalid typed category"])(
		"keeps untrusted %s failure unknown and private",
		async (shape) => {
			const invalid = new NotificationFailureError("authentication");
			Object.defineProperty(invalid, "category", { value: privateError });
			testAction = async () => {
				throw shape === "error"
					? new Error(privateError)
					: shape === "string"
						? privateError
						: shape === "shape"
							? { category: "authentication", message: privateError }
							: invalid;
			};
			const response = await testChannel();
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				success: false,
				failureCategory: "unknown",
				statusRecorded: true,
			});
			expect(response.payload + logs.join("\n")).not.toContain(privateMarker);
			expect(testCalls).toBe(1);
			await expectNoDeliveryOrRetry();
		},
	);
});
