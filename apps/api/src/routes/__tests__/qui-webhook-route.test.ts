/**
 * Integration tests for the public qui webhook receiver (Phase 5.1).
 *
 * The receiver is the only public route in the qui surface — it has to
 * authenticate via `?secret=`, validate the envelope, and persist the
 * raw event. We cover:
 *   - Unknown/missing secret → 401, no DB write.
 *   - Bad envelope → 400, no DB write.
 *   - Happy path → 200, row created, event bus published.
 *   - DB failure → 503 for recognized transient failures, 500 otherwise.
 *   - Hash extraction from each documented payload shape.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quiEventBus } from "../../lib/qui/event-bus.js";
import { generateQuiWebhookSecret } from "../../lib/qui/webhook-secret.js";
import { buildQuiDeploymentId, buildQuiNotificationTargetOwnerId } from "../qui/webhook-routes.js";
import { registerQuiWebhookRoutes } from "../qui-webhook.js";
import { registerTestErrorHandler } from "./test-helpers.js";

function createMockPrisma(userRow: unknown) {
	return {
		user: {
			findUnique: vi.fn().mockResolvedValue(userRow),
		},
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue({ id: "qui-1", baseUrl: "http://qui.test" }),
		},
		quiEventLog: {
			create: vi.fn().mockResolvedValue({
				id: "evt-row-1",
				receivedAt: new Date("2026-05-14T10:00:00Z"),
			}),
		},
		quiActivityLog: {
			create: vi.fn().mockResolvedValue({ id: "activity-1" }),
			findFirst: vi.fn().mockResolvedValue(null),
			deleteMany: vi.fn(),
		},
	};
}

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let secret: { plaintextSecret: string; hashedSecret: string };
let serializedLogs: string[];

beforeEach(async () => {
	vi.clearAllMocks();
	quiEventBus.clearForTests();
	secret = generateQuiWebhookSecret();
	mockPrisma = createMockPrisma({ id: "user-1" });
	// Lookup is keyed by hash — the route never receives the user row
	// unless the inbound secret hashes to a known value. Tests that want
	// the "miss" path null out the mock per-case.
	mockPrisma.user.findUnique.mockImplementation(
		async ({ where }: { where: { hashedQuiWebhookSecret: string } }) =>
			where.hashedQuiWebhookSecret === secret.hashedSecret ? { id: "user-1" } : null,
	);

	serializedLogs = [];
	app = Fastify({
		logController: new Fastify.LogController({ disableRequestLogging: true }),
		logger: { level: "info", stream: { write: (record) => serializedLogs.push(record) } },
	});
	app.decorate("prisma", mockPrisma as never);
	app.decorate("installationId", "installation-1");
	app.decorate("installationIdIsPersistent", true);
	registerTestErrorHandler(app);
	await app.register(rateLimit);
	await app.register(registerQuiWebhookRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});

describe("POST /webhooks/qui", () => {
	it("returns 401 when no secret query param is supplied", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/webhooks/qui",
			payload: { type: "torrent_added", payload: {} },
		});
		expect(res.statusCode).toBe(401);
		// No DB write on auth failure — drops noise from random probes.
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("returns 401 when the secret does not match any user", async () => {
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${"z".repeat(43)}`,
			payload: { type: "torrent_added", payload: {} },
		});
		expect(res.statusCode).toBe(401);
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("returns 400 on a malformed envelope (missing required keys)", async () => {
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { hello: "world" },
		});
		// Envelope validation runs after auth so the operator sees the
		// real error (not a 401 cover) when their qui-side schema drifts.
		expect(res.statusCode).toBe(400);
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("persists the event and publishes to the event bus on the happy path", async () => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: {
				type: "torrent_added",
				payload: { hash: "a".repeat(40), name: "demo" },
			},
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toMatchObject({ ok: true, eventId: "evt-row-1" });
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledOnce();
		const createArgs = mockPrisma.quiEventLog.create.mock.calls[0]?.[0];
		expect(createArgs.data.userId).toBe("user-1");
		expect(createArgs.data.serviceInstanceId).toBeNull();
		expect(createArgs.data.eventType).toBe("torrent_added");
		// Hash extraction must pull the per-torrent hash out of the
		// payload — otherwise the My Events tab can't deep-link to the
		// affected torrent.
		expect(createArgs.data.torrentHash).toBe("a".repeat(40));
		// Bus publish hits exactly one subscriber for this user.
		expect(seen).toHaveLength(1);
	});

	it("authenticates and persists the registered qUI source instance", async () => {
		const deploymentId = buildQuiDeploymentId("user-1", "http://qui.test");
		const owner = buildQuiNotificationTargetOwnerId("installation-1", "user-1", "qui-1");
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${deploymentId}&owner=${owner}`,
			payload: {
				type: "torrent_added",
				payload: { hash: "a".repeat(40) },
			},
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.serviceInstance.findFirst).toHaveBeenCalledWith({
			where: { id: "qui-1", userId: "user-1", service: "QUI" },
			select: { id: true, baseUrl: true },
		});
		const createArgs = mockPrisma.quiEventLog.create.mock.calls[0]?.[0];
		expect(createArgs.data.serviceInstanceId).toBe("qui-1");
	});

	it("preserves the event when its correlated qUI instance is deleted during persistence", async () => {
		const deploymentId = buildQuiDeploymentId("user-1", "http://qui.test");
		const owner = buildQuiNotificationTargetOwnerId("installation-1", "user-1", "qui-1");
		mockPrisma.quiEventLog.create
			.mockRejectedValueOnce(
				Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }),
			)
			.mockResolvedValueOnce({
				id: "evt-row-1",
				receivedAt: new Date("2026-05-14T10:00:00Z"),
			});

		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${deploymentId}&owner=${owner}`,
			payload: {
				type: "torrent_added",
				payload: { hash: "a".repeat(40) },
			},
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toMatchObject({ ok: true, eventId: "evt-row-1" });
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledTimes(2);
		expect(mockPrisma.quiEventLog.create.mock.calls[0]?.[0].data.serviceInstanceId).toBe("qui-1");
		expect(mockPrisma.quiEventLog.create.mock.calls[1]?.[0].data.serviceInstanceId).toBeNull();
	});

	it("rejects source attribution with a different installation owner", async () => {
		const deploymentId = buildQuiDeploymentId("user-1", "http://qui.test");
		const otherOwner = buildQuiNotificationTargetOwnerId("other-installation", "user-1", "qui-1");

		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${deploymentId}&owner=${otherOwner}`,
			payload: { type: "torrent_added", payload: {} },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload)).toEqual({ error: "Invalid webhook source" });
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("rejects source attribution without a persistent installation identity", async () => {
		app.installationIdIsPersistent = false;
		const deploymentId = buildQuiDeploymentId("user-1", "http://qui.test");
		const owner = buildQuiNotificationTargetOwnerId("installation-1", "user-1", "qui-1");

		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${deploymentId}&owner=${owner}`,
			payload: { type: "torrent_added", payload: {} },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload)).toEqual({ error: "Invalid webhook source" });
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("rejects a source instance that is not a qUI instance owned by the secret's user", async () => {
		mockPrisma.serviceInstance.findFirst.mockResolvedValueOnce(null);

		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=other-instance&deploymentId=${"a".repeat(24)}`,
			payload: { type: "torrent_added", payload: {} },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload)).toEqual({ error: "Invalid webhook source" });
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("rejects attribution from a target bound to the instance's previous deployment", async () => {
		const previousDeploymentId = buildQuiDeploymentId("user-1", "http://previous-qui.test");

		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${previousDeploymentId}`,
			payload: { type: "torrent_added", payload: {} },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload)).toEqual({ error: "Invalid webhook source" });
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("normalizes qUI's Shoutrrr JSON notification body", async () => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: {
				title: "Torrent added",
				message: "Instance: qbit-main\nTorrent: Example.Release [aaaaaaaa]\nState: downloading",
			},
		});

		expect(res.statusCode).toBe(200);
		const createArgs = mockPrisma.quiEventLog.create.mock.calls[0]?.[0];
		expect(createArgs.data.eventType).toBe("torrent_added");
		expect(createArgs.data.torrentHash).toBeNull();
		expect(JSON.parse(createArgs.data.payload)).toEqual({
			type: "torrent_added",
			payload: {
				title: "Torrent added",
				message: "Instance: qbit-main\nTorrent: Example.Release [aaaaaaaa]\nState: downloading",
			},
		});
		expect(seen).toHaveLength(1);
	});

	it("keeps unknown qUI notification titles instead of rejecting new event definitions", async () => {
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: {
				title: "Future qUI event",
				message: "Instance: qbit-main\nDetail: something changed",
			},
		});

		expect(res.statusCode).toBe(200);
		const createArgs = mockPrisma.quiEventLog.create.mock.calls[0]?.[0];
		expect(createArgs.data.eventType).toBe("notification");
		expect(JSON.parse(createArgs.data.payload).payload.title).toBe("Future qUI event");
	});

	it("extracts hash from infoHash, torrent.hash, and torrents[0].hash shapes", async () => {
		const variants = [
			{ infoHash: "b".repeat(40) },
			{ torrent: { hash: "c".repeat(40) } },
			{ torrents: [{ hash: "d".repeat(40) }] },
		];
		for (const payload of variants) {
			mockPrisma.quiEventLog.create.mockClear();
			await app.inject({
				method: "POST",
				url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
				payload: { type: "torrent_added", payload },
			});
			const args = mockPrisma.quiEventLog.create.mock.calls[0]?.[0];
			expect(args.data.torrentHash).toMatch(/^[bcd]{40}$/);
		}
	});

	it.each([
		{ code: "P1001" },
		{ code: "P1002" },
		{ code: "P1008" },
		{ code: "P1017" },
		{ code: "P2024" },
		{ code: "P2034" },
		{ code: "SQLITE_BUSY" },
		{ code: "SQLITE_BUSY_TIMEOUT" },
		{ code: "SQLITE_BUSY_SNAPSHOT" },
		{ code: "SQLITE_LOCKED" },
		{ code: "40001" },
		{ code: "40P01" },
		{ errorCode: "P1001" },
		{ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } } },
	])("returns 503 without publishing or acknowledging an unavailable save: %j", async (error) => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		mockPrisma.quiEventLog.create.mockRejectedValueOnce(error);
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added", payload: {} },
		});
		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.payload)).toEqual({ error: "Event persistence unavailable" });
		expect(seen).toEqual([]);
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledOnce();
	});

	it.each([
		new Error("database is locked"),
		{ code: "P2003" },
		{ code: "P2002" },
		{ code: "P2028" },
		{ code: "P2010" },
		{ code: "private-error-code" },
		{ code: { toString: () => "SQLITE_BUSY" } },
		Object.create({ code: "SQLITE_BUSY" }),
		Object.defineProperty({}, "code", {
			get: () => {
				throw new Error("private accessor");
			},
		}),
	])("returns 500 for unknown or non-transient persistence failures: %j", async (error) => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		mockPrisma.quiEventLog.create.mockRejectedValueOnce(error);
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added", payload: {} },
		});
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.payload)).toEqual({ error: "Event persistence failed" });
		expect(seen).toEqual([]);
	});

	it("accepts a fresh retry only after its event is saved", async () => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		mockPrisma.quiEventLog.create.mockRejectedValueOnce({ code: "SQLITE_BUSY" });
		const request = {
			method: "POST" as const,
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added", payload: { hash: "a".repeat(40) } },
		};
		const failed = await app.inject(request);
		expect(failed.statusCode).toBe(503);
		expect(seen).toEqual([]);
		const saved = await app.inject(request);
		expect(saved.statusCode).toBe(200);
		expect(saved.json()).toEqual({ ok: true, eventId: "evt-row-1" });
		expect(seen).toEqual([
			{
				id: "evt-row-1",
				type: "torrent_added",
				torrentHash: "a".repeat(40),
				receivedAt: "2026-05-14T10:00:00.000Z",
			},
		]);
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		"keeps persistence diagnostics private when activity logging fails=%s",
		async (activityFails) => {
			const privateData = [
				secret.plaintextSecret,
				"private-title",
				"https://private.example/token",
				"SELECT private_column FROM secret_table",
			];
			const error = Object.assign(new Error(privateData.join(" ")), {
				code: "SQLITE_BUSY",
				meta: { sql: privateData },
			});
			mockPrisma.quiEventLog.create.mockRejectedValueOnce(error);
			if (activityFails) mockPrisma.quiActivityLog.create.mockRejectedValueOnce(error);
			const res = await app.inject({
				method: "POST",
				url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
				payload: { type: "private-event-type", payload: { title: "private-title" } },
			});
			expect(res.statusCode).toBe(503);
			const activityData = mockPrisma.quiActivityLog.create.mock.calls[0]?.[0].data;
			expect(activityData).toMatchObject({
				userId: "user-1",
				eventType: "qui_webhook_dropped",
				severity: "error",
			});
			expect(JSON.parse(activityData.details)).toEqual({ reason: "storage-unavailable" });
			const diagnostics = res.payload + serializedLogs.join("") + JSON.stringify(activityData);
			for (const value of [...privateData, "private-event-type"])
				expect(diagnostics).not.toContain(value);
			expect(serializedLogs.join("")).toContain("storage-unavailable");
		},
	);

	it("returns a failed save when the uncorrelated FK fallback also fails", async () => {
		const seen: unknown[] = [];
		quiEventBus.subscribe("user-1", (msg) => seen.push(msg));
		mockPrisma.quiEventLog.create
			.mockRejectedValueOnce(Object.assign(new Error("FK"), { code: "P2003" }))
			.mockRejectedValueOnce({ code: "SQLITE_BUSY" });
		const deploymentId = buildQuiDeploymentId("user-1", "http://qui.test");
		const owner = buildQuiNotificationTargetOwnerId("installation-1", "user-1", "qui-1");
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}&instanceId=qui-1&deploymentId=${deploymentId}&owner=${owner}`,
			payload: { type: "torrent_added", payload: {} },
		});
		expect(res.statusCode).toBe(503);
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledTimes(2);
		expect(mockPrisma.quiEventLog.create.mock.calls[1]?.[0].data.serviceInstanceId).toBeNull();
		expect(seen).toEqual([]);
	});

	it.each(["publish", "listener"])(
		"keeps %s failure nonfatal and its diagnostics private after saving",
		async (failure) => {
			const error = new Error(`private-SSE-error ${secret.plaintextSecret}`);
			if (failure === "publish")
				vi.spyOn(quiEventBus, "publish").mockImplementationOnce(() => {
					throw error;
				});
			else
				quiEventBus.subscribe("user-1", () => {
					throw error;
				});
			const res = await app.inject({
				method: "POST",
				url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
				payload: { type: "private-event-type", payload: {} },
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ ok: true, eventId: "evt-row-1" });
			expect(mockPrisma.quiActivityLog.create).not.toHaveBeenCalled();
			expect(serializedLogs.join("")).not.toContain("private-SSE-error");
			expect(serializedLogs.join("")).not.toContain(secret.plaintextSecret);
			expect(serializedLogs.join("")).not.toContain("private-event-type");
		},
	);

	it("retains the 64 KiB body limit without saving oversized events", async () => {
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added", payload: "x".repeat(65_536) },
		});
		expect(res.statusCode).toBe(413);
		expect(mockPrisma.quiEventLog.create).not.toHaveBeenCalled();
	});

	it("retains the per-route request limit", async () => {
		for (let i = 0; i < 30; i++) {
			const res = await app.inject({
				method: "POST",
				url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
				payload: { type: "torrent_added" },
			});
			expect(res.statusCode).toBe(200);
		}
		const limited = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added" },
		});
		expect(limited.statusCode).toBe(429);
		expect(mockPrisma.quiEventLog.create).toHaveBeenCalledTimes(30);
	});
});
