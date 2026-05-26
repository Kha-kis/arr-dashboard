/**
 * Integration tests for the public qui webhook receiver (Phase 5.1).
 *
 * The receiver is the only public route in the qui surface — it has to
 * authenticate via `?secret=`, validate the envelope, and persist the
 * raw event. We cover:
 *   - Unknown/missing secret → 401, no DB write.
 *   - Bad envelope → 400, no DB write.
 *   - Happy path → 200, row created, event bus published.
 *   - DB failure → 200 anyway (to suppress qui-side retry storms).
 *   - Hash extraction from each documented payload shape.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { quiEventBus } from "../../lib/qui/event-bus.js";
import { generateQuiWebhookSecret } from "../../lib/qui/webhook-secret.js";
import { registerQuiWebhookRoutes } from "../qui-webhook.js";
import { registerTestErrorHandler } from "./test-helpers.js";

function createMockPrisma(userRow: unknown) {
	return {
		user: {
			findUnique: vi.fn().mockResolvedValue(userRow),
		},
		quiEventLog: {
			create: vi.fn().mockResolvedValue({
				id: "evt-row-1",
				receivedAt: new Date("2026-05-14T10:00:00Z"),
			}),
		},
	};
}

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let secret: { plaintextSecret: string; hashedSecret: string };

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

	app = Fastify();
	app.decorate("prisma", mockPrisma as never);
	registerTestErrorHandler(app);
	await app.register(registerQuiWebhookRoutes);
	await app.ready();
});

afterAll(async () => {
	await app?.close();
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
			url: "/webhooks/qui?secret=" + "z".repeat(43),
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
		expect(createArgs.data.eventType).toBe("torrent_added");
		// Hash extraction must pull the per-torrent hash out of the
		// payload — otherwise the My Events tab can't deep-link to the
		// affected torrent.
		expect(createArgs.data.torrentHash).toBe("a".repeat(40));
		// Bus publish hits exactly one subscriber for this user.
		expect(seen).toHaveLength(1);
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

	it("returns 200 even when the DB insert fails (suppresses qui retry storm)", async () => {
		mockPrisma.quiEventLog.create.mockRejectedValueOnce(new Error("disk full"));
		const res = await app.inject({
			method: "POST",
			url: `/webhooks/qui?secret=${secret.plaintextSecret}`,
			payload: { type: "torrent_added", payload: {} },
		});
		// Why 200: qui will retry on any non-2xx. A persistent DB issue would
		// loop forever. We accept the loss locally (logged via request.log)
		// rather than externalizing the failure as a retry storm.
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toMatchObject({ ok: true, eventId: null });
	});
});
