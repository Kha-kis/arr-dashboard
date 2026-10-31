import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockNotificationService, mockGetDeliveryStatistics } = vi.hoisted(() => ({
	mockNotificationService: {
		testChannel: vi.fn().mockResolvedValue({ success: true, statusRecorded: true }),
		getDecryptedConfig: vi
			.fn()
			.mockResolvedValue({ webhookUrl: "https://discord.com/api/webhooks/123" }),
		getChannelTypes: vi.fn().mockReturnValue([]),
	},
	mockGetDeliveryStatistics: vi.fn().mockResolvedValue({ total: 0, sent: 0, failed: 0 }),
}));

vi.mock("../../lib/notifications/statistics.js", () => ({
	getDeliveryStatistics: (...args: unknown[]) => mockGetDeliveryStatistics(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { registerNotificationRoutes } from "../notifications.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const now = new Date("2024-06-01T00:00:00Z");

function makeChannel(overrides: Record<string, unknown> = {}) {
	return {
		id: "ch-1",
		userId: "user-1",
		name: "Discord Alerts",
		type: "DISCORD",
		enabled: true,
		encryptedConfig: "encrypted-config-data",
		configIv: "mock-iv",
		lastTestedAt: null,
		lastTestResult: null,
		lastSentAt: null,
		lastSendResult: null,
		createdAt: now,
		updatedAt: now,
		subscriptions: [],
		...overrides,
	};
}

function makeRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "rule-1",
		userId: "user-1",
		name: "Suppress Hunt Noise",
		enabled: true,
		priority: 0,
		action: "suppress",
		conditions: JSON.stringify([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		]),
		targetChannelIds: null,
		throttleMinutes: null,
		quietHoursStart: null,
		quietHoursEnd: null,
		quietHoursTimezone: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

function createMockPrisma() {
	const executeRaw = vi.fn().mockResolvedValue(1);
	const subscriptionMock = {
		findMany: vi.fn().mockResolvedValue([]),
		deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
		upsert: vi.fn().mockResolvedValue({}),
	};

	return {
		$executeRaw: executeRaw,
		notificationChannel: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockImplementation(({ data }: any) => ({
				id: "ch-new",
				...data,
				lastTestedAt: null,
				lastTestResult: null,
				lastSentAt: null,
				lastSendResult: null,
				createdAt: now,
				updatedAt: now,
			})),
			update: vi.fn().mockImplementation(({ data }: any) => ({
				...makeChannel(),
				...data,
				subscriptions: [],
			})),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		notificationSubscription: subscriptionMock,
		notificationLog: {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		},
		notificationRule: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockImplementation(({ data }: any) => ({
				id: "rule-new",
				...data,
				createdAt: now,
				updatedAt: now,
			})),
			update: vi.fn().mockImplementation(({ data }: any) => ({
				...makeRule(),
				...data,
			})),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		notificationAggregationConfig: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn().mockResolvedValue({}),
		},
		vapidKeys: {
			findUnique: vi.fn().mockResolvedValue({ id: 1, publicKey: "mock-vapid-public-key" }),
		},
		$transaction: vi.fn().mockImplementation(async (fn: any) => {
			return fn({
				$executeRaw: executeRaw,
				notificationSubscription: subscriptionMock,
			});
		}),
	};
}

// ---------------------------------------------------------------------------
// Fastify setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let routeLogs: string[];

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = createMockPrisma();

	routeLogs = [];
	const logger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => routeLogs.push(line) },
	) as unknown as FastifyBaseLogger;
	app = Fastify({ loggerInstance: logger });

	app.decorate("prisma", mockPrisma);
	app.decorate(
		"encryptor",
		createMockEncryptor(
			JSON.stringify({ webhookUrl: "https://discord.com/api/webhooks/original" }),
		),
	);
	app.decorate("notificationService", mockNotificationService);

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerNotificationRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// Channel CRUD
// ===========================================================================

describe("POST /channels", () => {
	it("creates channel with encrypted config and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/channels", {
			body: {
				name: "Discord Alerts",
				type: "DISCORD",
				config: { webhookUrl: "https://discord.com/api/webhooks/123/token" },
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.name).toBe("Discord Alerts");
		expect(body.type).toBe("DISCORD");
		expect(body.id).toBeDefined();

		// Config should be encrypted, not stored as plaintext
		expect((app as any).encryptor.encrypt).toHaveBeenCalled();
		expect(mockPrisma.notificationChannel.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-1",
					encryptedConfig: "encrypted",
					configIv: "mock-iv",
				}),
			}),
		);
	});
});

describe("PUT /channels/:id", () => {
	it("retains the owned encrypted identity when masked settings are unchanged", async () => {
		mockPrisma.notificationChannel.findFirst.mockResolvedValue(makeChannel());

		const res = await injectAuthenticated("PUT", "/channels/ch-1", {
			body: {
				config: { webhookUrl: "••••••••" }, // Redacted — should preserve original
			},
		});

		expect(res.statusCode).toBe(200);

		// Should have decrypted existing config to get the original value
		expect((app as any).encryptor.decrypt).toHaveBeenCalledWith({
			value: "encrypted-config-data",
			iv: "mock-iv",
		});

		// Equivalent settings must not rotate identity or discard existing Test evidence.
		expect(mockPrisma.notificationChannel.update).toHaveBeenCalledWith({
			where: {
				id: "ch-1",
				userId: "user-1",
				type: "DISCORD",
				name: "Discord Alerts",
				enabled: true,
				encryptedConfig: "encrypted-config-data",
				configIv: "mock-iv",
			},
			data: {},
			include: { subscriptions: true },
		});
	});

	it("returns 404 for non-owned channel", async () => {
		mockPrisma.notificationChannel.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("PUT", "/channels/ch-999", {
			body: { name: "Hacked Channel" },
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("Channel not found");
	});
});

describe("DELETE /channels/:id", () => {
	it("deletes owned channel and returns 204", async () => {
		mockPrisma.notificationChannel.findFirst.mockResolvedValue(makeChannel());

		const res = await injectAuthenticated("DELETE", "/channels/ch-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.notificationChannel.delete).toHaveBeenCalledWith({
			where: { id: "ch-1", userId: "user-1" },
		});
	});

	it("returns 404 for non-owned channel", async () => {
		mockPrisma.notificationChannel.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("DELETE", "/channels/ch-999");

		expect(res.statusCode).toBe(404);
	});
});

// ===========================================================================
// Channel test send
// ===========================================================================

describe("POST /channels/:id/test", () => {
	it("calls notificationService.testChannel and returns success", async () => {
		const res = await injectAuthenticated("POST", "/channels/ch-1/test");

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ success: true, statusRecorded: true });
		expect(mockNotificationService.testChannel).toHaveBeenCalledWith("ch-1", "user-1");
	});

	it("returns 400 when test delivery fails", async () => {
		mockNotificationService.testChannel.mockRejectedValueOnce(new Error("Connection refused"));

		const res = await injectAuthenticated("POST", "/channels/ch-1/test");

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Test failed");
	});

	it("preserves a confirmed Test whose status could not be recorded", async () => {
		mockNotificationService.testChannel.mockResolvedValueOnce({
			success: true,
			statusRecorded: false,
		});
		const res = await injectAuthenticated("POST", "/channels/ch-1/test");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ success: true, statusRecorded: false });
		expect(mockPrisma.notificationChannel.updateMany).not.toHaveBeenCalled();
	});

	it("maps a failed outcome category without writing status again", async () => {
		mockNotificationService.testChannel.mockResolvedValueOnce({
			success: false,
			statusRecorded: false,
			failureCategory: "authentication",
		});
		const res = await injectAuthenticated("POST", "/channels/ch-1/test");
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			success: false,
			statusRecorded: false,
			failureCategory: "authentication",
			error: "Test failed",
			message: "Provider authentication failed. Check channel credentials and permissions.",
		});
		expect(mockPrisma.notificationChannel.updateMany).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// Subscriptions bulk upsert
// ===========================================================================

describe("PUT /subscriptions", () => {
	it("filters out subscriptions for non-owned channels", async () => {
		// User owns only ch-1
		mockPrisma.notificationChannel.findMany.mockResolvedValue([{ id: "ch-1" }]);
		const txMock = {
			$executeRaw: vi.fn().mockResolvedValue(1),
			notificationChannel: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "ch-1", name: "Synthetic channel", type: "DISCORD" }]),
			},
			notificationSubscription: {
				findMany: vi.fn().mockResolvedValue([{ channelId: "ch-1", eventType: "HUNT_COMPLETED" }]),
				deleteMany: vi.fn(),
				upsert: vi.fn(),
			},
		};
		mockPrisma.$transaction.mockImplementation(async (fn) => fn(txMock));

		const res = await injectAuthenticated("PUT", "/subscriptions", {
			body: {
				subscriptions: [
					{ channelId: "ch-1", eventType: "HUNT_COMPLETED", enabled: true },
					{ channelId: "ch-other-user", eventType: "HUNT_COMPLETED", enabled: true }, // should be filtered
				],
			},
		});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			success: true,
			omittedCount: 1,
			grid: {
				channels: [{ id: "ch-1", name: "Synthetic channel", type: "DISCORD" }],
				events: expect.arrayContaining(["HUNT_COMPLETED"]),
				subscriptions: [{ channelId: "ch-1", eventType: "HUNT_COMPLETED" }],
			},
		});

		// Transaction should have been called
		expect(mockPrisma.$transaction).toHaveBeenCalled();

		// Only ch-1 subscription should have been upserted, not ch-other-user
		expect(txMock.notificationSubscription.upsert).toHaveBeenCalledTimes(1);
		expect(txMock.notificationSubscription.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { channelId_eventType: { channelId: "ch-1", eventType: "HUNT_COMPLETED" } },
			}),
		);
	});
});

// ===========================================================================
// Rules CRUD
// ===========================================================================

describe("POST /rules", () => {
	it("creates rule with serialized conditions and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/rules", {
			body: {
				name: "Suppress Hunt Noise",
				action: "suppress",
				conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.name).toBe("Suppress Hunt Noise");
		expect(body.action).toBe("suppress");
		expect(body.conditions).toEqual([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		]);

		// Conditions should be stored as JSON string in DB
		expect(mockPrisma.notificationRule.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-1",
					conditions: JSON.stringify([
						{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
					]),
				}),
			}),
		);
	});
});

describe("DELETE /rules/:id", () => {
	it("deletes owned rule and returns 204", async () => {
		mockPrisma.notificationRule.findFirst.mockResolvedValue(makeRule());

		const res = await injectAuthenticated("DELETE", "/rules/rule-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.notificationRule.delete).toHaveBeenCalledWith({
			where: { id: "rule-1", userId: "user-1" },
		});
	});

	it("returns 404 for non-owned rule", async () => {
		mockPrisma.notificationRule.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("DELETE", "/rules/rule-999");

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("Rule not found");
	});
});

// ===========================================================================
// GET /channels/:id/config — decrypted config
// ===========================================================================

describe("GET /channels/:id/config", () => {
	it("returns decrypted config via notificationService", async () => {
		const res = await injectAuthenticated("GET", "/channels/ch-1/config");

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).webhookUrl).toBeDefined();
		expect(mockNotificationService.getDecryptedConfig).toHaveBeenCalledWith("ch-1", "user-1");
	});

	it("returns 404 when channel not found", async () => {
		mockNotificationService.getDecryptedConfig.mockRejectedValueOnce(
			new Error("Channel not found"),
		);

		const res = await injectAuthenticated("GET", "/channels/ch-999/config");

		expect(res.statusCode).toBe(404);
	});
});

describe("notification failure boundaries", () => {
	const privateDetail =
		"private-sentinel https://secret-user:short-pass@private.invalid/hook?token=short-token provider-body";

	it.each([
		["Error", new Error(privateDetail)],
		["structured throw", { message: privateDetail, cause: new Error(privateDetail) }],
		["string throw", privateDetail],
	])(
		"keeps test %s out of response and persisted status while retaining failure",
		async (_label, error) => {
			mockNotificationService.testChannel.mockRejectedValueOnce(error);
			const res = await injectAuthenticated("POST", "/channels/ch-1/test");
			expect(res.statusCode).toBe(400);
			expect(res.json()).toEqual({
				success: false,
				failureCategory: "unknown",
				statusRecorded: false,
				error: "Test failed",
				message: "Delivery was not confirmed. Check channel settings and provider availability.",
			});
			expect(res.payload).not.toContain("private-sentinel");
			expect(mockPrisma.notificationChannel.updateMany).not.toHaveBeenCalled();
			expect(mockPrisma.notificationChannel.update).not.toHaveBeenCalled();
			expect(routeLogs.join("")).not.toContain("private-sentinel");
		},
	);

	it("does not attempt a blind status write when the service unexpectedly throws", async () => {
		mockNotificationService.testChannel.mockRejectedValueOnce(new Error(privateDetail));
		mockPrisma.notificationChannel.updateMany.mockRejectedValueOnce(new Error(privateDetail));
		const res = await injectAuthenticated("POST", "/channels/ch-1/test");
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe("Test failed");
		expect(res.json()).toMatchObject({
			success: false,
			statusRecorded: false,
			failureCategory: "unknown",
		});
		expect(mockPrisma.notificationChannel.updateMany).not.toHaveBeenCalled();
		expect(res.payload).not.toContain("private-sentinel");
		expect(routeLogs.join("")).not.toContain("private-sentinel");
	});

	it.each([new Error(privateDetail), new SyntaxError(privateDetail)])(
		"does not expose config-read exceptions in response or actual Pino logs",
		async (error) => {
			mockNotificationService.getDecryptedConfig.mockRejectedValueOnce(error);
			const res = await injectAuthenticated("GET", "/channels/ch-1/config");
			expect(res.statusCode).toBe(500);
			expect(res.json()).toEqual({
				error: "Failed to read channel config",
				message:
					"Notification channel settings could not be read. Try reopening settings; if this persists, check the channel configuration.",
			});
			expect(res.payload).not.toContain("private-sentinel");
			expect(routeLogs.join("")).not.toContain("private-sentinel");
			expect(routeLogs.map((line) => JSON.parse(line))).toContainEqual(
				expect.objectContaining({
					operation: "notification-config-read",
					status: "failed",
					msg: "Failed to read notification channel config",
				}),
			);
		},
	);

	it.each(["GET", "PUT"] as const)(
		"projects legacy provider status text safely in %s channel responses",
		async (method) => {
			const row = makeChannel({
				lastTestResult: `failed: ${privateDetail}`,
				lastSendResult: privateDetail,
			});
			mockPrisma.notificationChannel.findMany.mockResolvedValue([row]);
			mockPrisma.notificationChannel.findFirst.mockResolvedValue(row);
			mockPrisma.notificationChannel.update.mockResolvedValue(row);
			const res = await injectAuthenticated(
				method,
				method === "GET" ? "/channels" : "/channels/ch-1",
				method === "PUT" ? { body: { enabled: false } } : {},
			);
			expect(res.statusCode).toBe(200);
			const returned = method === "GET" ? res.json()[0] : res.json();
			expect(returned.lastTestResult).toBe("failed");
			expect(res.payload).not.toContain("private-sentinel");
			if (method === "GET") expect(returned.lastSendResult).toBe("failed");
		},
	);

	it("projects only config status metadata, preserving the existing safe edit config", async () => {
		mockNotificationService.getDecryptedConfig.mockResolvedValueOnce({
			id: "ch-1",
			name: "Synthetic channel",
			type: "TELEGRAM",
			enabled: true,
			config: { botToken: "••••••••", chatId: "synthetic-chat" },
			lastTestedAt: now,
			lastTestResult: privateDetail,
			lastSentAt: now,
			lastSendResult: privateDetail,
		});
		const res = await injectAuthenticated("GET", "/channels/ch-1/config");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			config: { botToken: "••••••••", chatId: "synthetic-chat" },
			lastTestResult: "failed",
			lastSendResult: "failed",
		});
		expect(res.payload).not.toContain("private-sentinel");
	});

	it("does not republish provider errors from legacy delivery-log records", async () => {
		mockPrisma.notificationChannel.findMany.mockResolvedValue([{ id: "ch-1" }]);
		mockPrisma.notificationLog.findMany.mockResolvedValue([
			{
				id: "log-1",
				channelId: "ch-1",
				channelType: "TELEGRAM",
				eventType: "HUNT_COMPLETED",
				title: "Synthetic event",
				body: "Synthetic body",
				status: "failed",
				error: privateDetail,
				retryCount: 2,
				sentAt: now,
			},
		]);
		mockPrisma.notificationLog.count.mockResolvedValue(1);
		const res = await injectAuthenticated("GET", "/logs");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			logs: [
				{
					status: "failed",
					error: "Delivery was not confirmed. Check channel settings and provider availability.",
					retryCount: 2,
				},
			],
			total: 1,
			page: 1,
			limit: 50,
		});
		expect(res.payload).not.toContain("private-sentinel");
		expect(mockPrisma.notificationLog.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { channelId: { in: ["ch-1"] } },
			}),
		);
	});

	it("preserves successful and never-tested channel states rather than inventing a failure", async () => {
		mockPrisma.notificationChannel.findMany.mockResolvedValue([
			makeChannel({ lastTestResult: "success", lastSendResult: "success" }),
			makeChannel({ id: "ch-2", lastTestResult: null, lastSendResult: null }),
		]);
		const res = await injectAuthenticated("GET", "/channels");
		expect(
			res
				.json()
				.map((row: { lastTestResult: string | null; lastSendResult: string | null }) => [
					row.lastTestResult,
					row.lastSendResult,
				]),
		).toEqual([
			["success", "success"],
			[null, null],
		]);
	});
});
