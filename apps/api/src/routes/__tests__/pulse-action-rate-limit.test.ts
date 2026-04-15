/**
 * Rate-limit test for POST /pulse/:id/action.
 *
 * The action route declares `config: { rateLimit: { max: 10, timeWindow:
 * "1m" } }`, which @fastify/rate-limit applies as a per-route override
 * on top of whatever global limit is registered. This test boots a
 * minimal Fastify app with the plugin registered (matching the
 * production topology), sends 11 successful requests against the route,
 * and asserts the 11th is rejected with 429.
 *
 * Why this matters: without this guard, a runaway script (or an
 * overeager operator mashing "Refresh now") can hammer upstream
 * Plex/Tautulli via cache.refresh. 10/min is generous for real operator
 * use — a human clicking one button per minute stays well under — but
 * bot-scale abuse trips 429 before upstream suffers.
 */

import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scheduler getters + refreshers — stubbed so the dispatcher short-circuits
// to scheduler.start (always ok) without touching anything real. We're
// testing the route's rate limiter, not any of the dispatch branches.
const huntingScheduler = {
	isRunning: vi.fn<() => boolean>().mockReturnValue(false),
	start: vi.fn(),
	stop: vi.fn(),
};
vi.mock("../../lib/hunting/scheduler.js", () => ({
	getHuntingScheduler: () => huntingScheduler,
}));
vi.mock("../../lib/queue-cleaner/scheduler.js", () => ({
	getQueueCleanerScheduler: () => ({
		isRunning: () => false,
		start: vi.fn(),
		stop: vi.fn(),
	}),
}));
vi.mock("../../lib/plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: vi.fn(),
}));
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: vi.fn(),
}));
vi.mock("../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: vi.fn(),
}));
vi.mock("../../lib/tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: vi.fn(),
}));
// No collectors — this test never calls GET /pulse.
vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [],
}));

import { registerPulseRoutes } from "../pulse.js";
import { registerTestErrorHandler } from "./test-helpers.js";

const AUTH_HEADER = "x-test-auth";
let app: FastifyInstance;

function setupAuthGate(app: FastifyInstance) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = { id: "rate-user", username: "admin" };
			req.sessionToken = "mock-session-token";
		}
	});
}

async function injectAction() {
	return app.inject({
		method: "POST",
		url: "/pulse/sig-1/action",
		headers: {
			[AUTH_HEADER]: "1",
			"content-type": "application/json",
			// Stable synthetic IP so every request maps to the same rate-limit
			// bucket — otherwise fastify-rate-limit keys off req.ip which in
			// the test harness can drift.
			"x-forwarded-for": "203.0.113.42",
		},
		payload: JSON.stringify({
			kind: "scheduler.enable",
			target: { jobId: "hunting" },
			label: "Enable",
			confirmLabel: "Click again to enable",
			destructive: false,
		}),
	});
}

beforeEach(async () => {
	huntingScheduler.isRunning.mockReturnValue(false);
	huntingScheduler.start.mockReset();

	app = Fastify({ logger: false, trustProxy: true });
	setupAuthGate(app);
	// Stubs the dispatcher touches on successful scheduler.enable.
	app.decorate("schedulerRegistry", { list: () => [], markEnabled: () => {} } as unknown as never);
	app.decorate("prisma", { cacheRefreshStatus: { upsert: async () => ({}) } } as unknown as never);
	// Generous global default — the per-route override is what we're
	// testing, so the global must not trip first.
	await app.register(fastifyRateLimit, { max: 10000, timeWindow: "1m" });
	registerTestErrorHandler(app);
	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("POST /pulse/:id/action — rate limit", () => {
	it("allows 10 requests/min from the same client and 429s the 11th", async () => {
		const codes: number[] = [];
		for (let i = 0; i < 11; i += 1) {
			const res = await injectAction();
			codes.push(res.statusCode);
		}

		// First 10 succeed (409 would also be acceptable if the scheduler
		// had already been started, but we re-stub isRunning=false each
		// call so every request reaches dispatch).
		expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);

		// 11th request tripped the per-route limit.
		expect(codes[10]).toBe(429);
	});
});
