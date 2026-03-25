import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockNotificationService, mockGetDeliveryStatistics } = vi.hoisted(() => ({
	mockNotificationService: {
		testChannel: vi.fn().mockResolvedValue(undefined),
		getDecryptedConfig: vi.fn().mockResolvedValue({ webhookUrl: "https://discord.com/api/webhooks/123" }),
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

import Fastify from "fastify";
import { registerNotificationRoutes } from "../notifications.js";
import { setupAuthInjection, createInjectAuthenticated, createMockEncryptor, registerTestErrorHandler } from "./test-helpers.js";

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
		conditions: JSON.stringify([{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }]),
		targetChannelIds: null,
		throttleMinutes: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

function createMockPrisma() {
	const subscriptionMock = {
		findMany: vi.fn().mockResolvedValue([]),
		deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
		upsert: vi.fn().mockResolvedValue({}),
	};

	return {
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

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = createMockPrisma();

	app = Fastify();

	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor(
		JSON.stringify({ webhookUrl: "https://discord.com/api/webhooks/original" }),
	));
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
	it("merges redacted config fields with existing decrypted values", async () => {
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

		// Should re-encrypt the merged config (original webhookUrl preserved)
		expect((app as any).encryptor.encrypt).toHaveBeenCalled();
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
			where: { id: "ch-1" },
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
		expect(JSON.parse(res.payload).success).toBe(true);
		expect(mockNotificationService.testChannel).toHaveBeenCalledWith("ch-1", "user-1");
	});

	it("returns 400 when test delivery fails", async () => {
		mockNotificationService.testChannel.mockRejectedValueOnce(new Error("Connection refused"));

		const res = await injectAuthenticated("POST", "/channels/ch-1/test");

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Test failed");
	});
});

// ===========================================================================
// Subscriptions bulk upsert
// ===========================================================================

describe("PUT /subscriptions", () => {
	it("filters out subscriptions for non-owned channels", async () => {
		// User owns only ch-1
		mockPrisma.notificationChannel.findMany.mockResolvedValue([{ id: "ch-1" }]);

		const res = await injectAuthenticated("PUT", "/subscriptions", {
			body: {
				subscriptions: [
					{ channelId: "ch-1", eventType: "HUNT_COMPLETED", enabled: true },
					{ channelId: "ch-other-user", eventType: "HUNT_COMPLETED", enabled: true }, // should be filtered
				],
			},
		});

		expect(res.statusCode).toBe(200);

		// Transaction should have been called
		expect(mockPrisma.$transaction).toHaveBeenCalled();

		// Only ch-1 subscription should have been upserted, not ch-other-user
		const txFn = mockPrisma.$transaction.mock.calls[0]![0];
		const txMock = {
			notificationSubscription: {
				deleteMany: vi.fn(),
				upsert: vi.fn(),
			},
		};
		await txFn(txMock);

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
		expect(body.conditions).toEqual([{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }]);

		// Conditions should be stored as JSON string in DB
		expect(mockPrisma.notificationRule.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-1",
					conditions: JSON.stringify([{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }]),
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
			where: { id: "rule-1" },
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
		mockNotificationService.getDecryptedConfig.mockRejectedValueOnce(new Error("Channel not found"));

		const res = await injectAuthenticated("GET", "/channels/ch-999/config");

		expect(res.statusCode).toBe(404);
	});
});
