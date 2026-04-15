/**
 * POST /pulse/:id/action — route integration tests.
 *
 * Exercises the 401 / 400 / 404 / 409 / 200 paths end-to-end through the
 * registered Fastify plugin. The dispatcher's external collaborators
 * (scheduler getters, require*Client helpers, refresh functions) are
 * mocked so we can drive each branch deterministically.
 *
 * Codebase convention note:
 *   Ownership failures return **404** (InstanceNotFoundError), not 403.
 *   This is intentional — the server does not reveal whether an instance
 *   exists but belongs to another user. A dedicated 403 test would require
 *   a different failure class (e.g., service-type mismatch returning 400
 *   via AppValidationError), so the "ownership fail" case is folded into
 *   the 404 branch below.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// Mocks — hoisted before the route import.
// -----------------------------------------------------------------------------

const huntingScheduler = {
	isRunning: vi.fn<() => boolean>(),
	start: vi.fn(),
	stop: vi.fn(),
};
const queueCleanerScheduler = {
	isRunning: vi.fn<() => boolean>(),
	start: vi.fn(),
	stop: vi.fn(),
};

vi.mock("../../lib/hunting/scheduler.js", () => ({
	getHuntingScheduler: () => huntingScheduler,
}));
vi.mock("../../lib/queue-cleaner/scheduler.js", () => ({
	getQueueCleanerScheduler: () => queueCleanerScheduler,
}));

const refreshPlexCache = vi.fn();
const refreshTautulliCache = vi.fn();
const requirePlexClient = vi.fn();
const requireTautulliClient = vi.fn();
vi.mock("../../lib/plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: (...args: unknown[]) => refreshPlexCache(...args),
}));
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: (...args: unknown[]) => refreshTautulliCache(...args),
}));
vi.mock("../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: (...args: unknown[]) => requirePlexClient(...args),
}));
vi.mock("../../lib/tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: (...args: unknown[]) => requireTautulliClient(...args),
}));

// Neutralize the collectors so GET /pulse (not under test here) never
// touches real services if the route-ready handshake probes them.
vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [],
}));

import { InstanceNotFoundError } from "../../lib/errors.js";
import { registerPulseRoutes } from "../pulse.js";
import { registerTestErrorHandler } from "./test-helpers.js";

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const AUTH_HEADER = "x-test-auth";
const DEFAULT_USER = { id: "user-1", username: "admin" };

/**
 * Custom auth setup that mirrors the production contract: if the test auth
 * header is absent, return 401 before hitting the route handler. The shared
 * `setupAuthInjection` helper sets `currentUser` when the header is present
 * but does not 401 without it — which would cause the handler to crash on
 * `request.currentUser!.id`. We need the explicit 401 path.
 */
function setupAuthGate(app: FastifyInstance) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any, reply) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = DEFAULT_USER;
			req.sessionToken = "mock-session-token";
			return;
		}
		return reply.status(401).send({ error: "Unauthorized" });
	});
}

let app: FastifyInstance;

async function inject(
	method: string,
	url: string,
	opts: { body?: unknown; authed?: boolean } = {},
) {
	const authed = opts.authed !== false;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (authed) headers[AUTH_HEADER] = "1";
	return app.inject({
		method: method as "GET" | "POST",
		url,
		headers,
		payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
}

beforeEach(async () => {
	huntingScheduler.isRunning.mockReset();
	huntingScheduler.start.mockReset();
	queueCleanerScheduler.isRunning.mockReset();
	queueCleanerScheduler.start.mockReset();
	refreshPlexCache.mockReset();
	refreshTautulliCache.mockReset();
	requirePlexClient.mockReset();
	requireTautulliClient.mockReset();

	app = Fastify({ logger: false });
	setupAuthGate(app);
	registerTestErrorHandler(app);
	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("POST /pulse/:id/action — auth", () => {
	it("returns 401 when the request is not authenticated", async () => {
		const res = await inject("POST", "/pulse/signal-1/action", {
			authed: false,
			body: {
				kind: "scheduler.enable",
				target: { jobId: "hunt" },
				label: "Enable scheduler",
				confirmLabel: "Click again",
				destructive: false,
			},
		});

		expect(res.statusCode).toBe(401);
	});
});

describe("POST /pulse/:id/action — scheduler.enable", () => {
	const body = {
		kind: "scheduler.enable",
		target: { jobId: "hunt" },
		label: "Enable scheduler",
		confirmLabel: "Click again to enable",
		destructive: false,
	};

	it("200 + starts the scheduler when it is not running", async () => {
		huntingScheduler.isRunning.mockReturnValue(false);

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
		expect(huntingScheduler.start).toHaveBeenCalledTimes(1);
	});

	it("409 when the scheduler is already running", async () => {
		huntingScheduler.isRunning.mockReturnValue(true);

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).error).toBe("ConflictError");
		expect(huntingScheduler.start).not.toHaveBeenCalled();
	});

	it("400 when the payload fails Zod validation (unknown jobId)", async () => {
		const res = await inject("POST", "/pulse/signal-1/action", {
			body: { ...body, target: { jobId: "not-a-real-job" } },
		});

		expect(res.statusCode).toBe(400);
		expect(huntingScheduler.start).not.toHaveBeenCalled();
	});
});

describe("POST /pulse/:id/action — cache.refresh", () => {
	const body = {
		kind: "cache.refresh",
		target: { instanceId: "inst-plex-1", cacheType: "plex" },
		label: "Refresh now",
		confirmLabel: "Click again",
		destructive: false,
	};

	it("200 + triggers refresh on success", async () => {
		requirePlexClient.mockResolvedValue({ client: {}, instance: {} });
		refreshPlexCache.mockResolvedValue({ upserted: 12, errors: 0, errorMessages: [] });

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ status: "ok", detail: "12 item(s) refreshed" });
		expect(refreshPlexCache).toHaveBeenCalledTimes(1);
	});

	it("404 when the target instance is missing or not owned (InstanceNotFoundError)", async () => {
		requirePlexClient.mockRejectedValue(new InstanceNotFoundError("inst-plex-1"));

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("InstanceNotFoundError");
		expect(refreshPlexCache).not.toHaveBeenCalled();
	});
});
