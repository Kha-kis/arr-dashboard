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

import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import pino from "pino";
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

const refreshOwnedPlexCache = vi.fn();
const refreshOwnedTautulliCache = vi.fn();
const refreshOwnedJellyfinCache = vi.fn();
const runJellyfinCacheRefreshSingleFlight = vi.fn();
vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCacheWithAttempt: (...args: unknown[]) => refreshOwnedPlexCache(...args),
}));
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCacheWithAttempt: (...args: unknown[]) => refreshOwnedTautulliCache(...args),
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	refreshOwnedJellyfinCacheWithAttempt: (...args: unknown[]) => refreshOwnedJellyfinCache(...args),
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlightWithAttempt: (...args: unknown[]) =>
		runJellyfinCacheRefreshSingleFlight(...args),
}));

// Neutralize the collectors so GET /pulse (not under test here) never
// touches real services if the route-ready handshake probes them.
vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [],
}));

import { dispatchPulseAction } from "../../lib/pulse/actions.js";
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
let serializedRouteLogs: () => string;
const plexInstance = {
	id: "inst-plex-1",
	userId: DEFAULT_USER.id,
	service: "PLEX",
	enabled: true,
	baseUrl: "https://plex.example.invalid",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "key-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "plex-server-1",
	identityStatus: "VERIFIED",
	connectionGeneration: 1,
	identityGeneration: 1,
};
const jellyfinInstance = {
	id: "inst-jellyfin-1",
	userId: DEFAULT_USER.id,
	service: "JELLYFIN",
	enabled: true,
	baseUrl: "https://jellyfin.example.invalid",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "key-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "jellyfin-server-1",
	identityStatus: "VERIFIED",
	connectionGeneration: 7,
	identityGeneration: 4,
};
const findPlexInstance = vi.fn();
const cacheStatusUpsert = vi.fn();

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
	refreshOwnedPlexCache.mockReset();
	refreshOwnedTautulliCache.mockReset();
	refreshOwnedJellyfinCache.mockReset();
	runJellyfinCacheRefreshSingleFlight
		.mockReset()
		.mockImplementation(
			async (
				_authority: unknown,
				_cacheType: unknown,
				_attempt: unknown,
				refresh: () => Promise<unknown>,
			) => await refresh(),
		);
	findPlexInstance
		.mockReset()
		.mockImplementation(async ({ where }) =>
			where.userId === DEFAULT_USER.id && where.enabled === true
				? where.id === plexInstance.id
					? plexInstance
					: where.id === jellyfinInstance.id
						? jellyfinInstance
						: null
				: null,
		);
	cacheStatusUpsert.mockReset().mockResolvedValue({});

	const logLines: string[] = [];
	const log = pino(
		{ level: "info", base: null, timestamp: false },
		{ write: (line: string) => logLines.push(line) },
	) as unknown as FastifyBaseLogger;
	serializedRouteLogs = () => logLines.join("");
	app = Fastify({
		loggerInstance: log,
		logController: new LogController({ disableRequestLogging: true }),
	});
	setupAuthGate(app);
	// Stubs for the write-through surfaces the dispatcher touches post-PR.
	// Not the focus of this file (see pulse-action-e2e.test.ts for the
	// behavioral assertions) — we only need them to exist so the dispatcher
	// doesn't throw on .markEnabled / .cacheRefreshStatus.upsert.
	app.decorate("schedulerRegistry", { list: () => [], markEnabled: () => {} } as unknown as never);
	app.decorate("prisma", {
		serviceInstance: { findFirst: findPlexInstance },
		cacheRefreshStatus: { upsert: cacheStatusUpsert },
		$transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				$queryRawUnsafe: vi.fn().mockResolvedValue([]),
				libraryCleanupConfig: {
					upsert: vi.fn().mockResolvedValue({ id: "cleanup-user-1" }),
					findUnique: vi.fn().mockResolvedValue({ id: "cleanup-user-1", runClaimToken: null }),
				},
				serviceInstance: { findFirst: findPlexInstance },
				cacheRefreshStatus: {
					findUnique: vi.fn().mockResolvedValue(null),
					create: vi.fn().mockResolvedValue({}),
					updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				},
			}),
	} as unknown as never);
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
				target: { jobId: "hunting" },
				label: "Enable scheduler",
				destructive: false,
			},
		});

		expect(res.statusCode).toBe(401);
	});
});

describe("POST /pulse/:id/action — scheduler.enable", () => {
	const body = {
		kind: "scheduler.enable",
		target: { jobId: "hunting" },
		label: "Enable scheduler",
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

describe("POST /pulse/:id/action — route log containment", () => {
	it("logs only the bounded action category and settlement", async () => {
		const privateSignalId = "private-signal-id";
		const privateInstanceId = plexInstance.id;
		refreshOwnedPlexCache.mockResolvedValue({ upserted: 1, errors: 0, errorMessages: [] });

		const res = await inject("POST", `/pulse/${privateSignalId}/action`, {
			body: {
				kind: "cache.refresh",
				target: { instanceId: privateInstanceId, cacheType: "plex" },
				label: "Retry refresh",
				destructive: false,
			},
		});

		expect(res.statusCode).toBe(200);
		const serialized = serializedRouteLogs();
		expect(serialized).toContain('"action":"cache.refresh"');
		expect(serialized).toContain('"cacheType":"plex"');
		expect(serialized).toContain('"settlement":"accepted"');
		for (const privateValue of [privateSignalId, privateInstanceId, DEFAULT_USER.id]) {
			expect(serialized).not.toContain(privateValue);
		}
	});
});

describe("POST /pulse/:id/action — cache.refresh", () => {
	const body = {
		kind: "cache.refresh",
		target: { instanceId: "inst-plex-1", cacheType: "plex" },
		label: "Refresh now",
		destructive: false,
	};

	it("200 immediately on dispatch; refresh runs in background (fire-and-forget)", async () => {
		refreshOwnedPlexCache.mockResolvedValue({ upserted: 12, errors: 0, errorMessages: [] });

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(200);
		// Wire shape: only `status`. `backgroundTask` is stripped by the
		// route handler (it's a Promise — not JSON-serializable), and
		// `detail` is no longer populated since we don't yet know the
		// upsert count at return time.
		expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
		// Flush the microtask queue so the background task's await of the
		// refresh mock resolves within this test's lifetime.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(refreshOwnedPlexCache).toHaveBeenCalledWith(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance: plexInstance,
				log: expect.anything(),
			},
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
	});

	it("404 when the target instance is missing or not owned (InstanceNotFoundError)", async () => {
		findPlexInstance.mockResolvedValueOnce(null);

		const res = await inject("POST", "/pulse/signal-1/action", { body });

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("InstanceNotFoundError");
		expect(refreshOwnedPlexCache).not.toHaveBeenCalled();
	});

	it("dispatches a Jellyfin retry through authority-only singleflight", async () => {
		findPlexInstance.mockResolvedValueOnce(jellyfinInstance);
		refreshOwnedJellyfinCache.mockResolvedValue({
			upserted: 7,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
		});

		const res = await inject("POST", "/pulse/signal-1/action", {
			body: {
				...body,
				target: { instanceId: "inst-jellyfin-1", cacheType: "jellyfin" },
				label: "Retry refresh",
			},
		});

		expect(res.statusCode).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(findPlexInstance).toHaveBeenCalledWith({
			where: { id: "inst-jellyfin-1", userId: "user-1", enabled: true },
		});
		expect(runJellyfinCacheRefreshSingleFlight).toHaveBeenCalledWith(
			expect.objectContaining({
				id: jellyfinInstance.id,
				userId: jellyfinInstance.userId,
				service: jellyfinInstance.service,
				encryptedApiKey: jellyfinInstance.encryptedApiKey,
			}),
			"jellyfin",
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
			expect.any(Function),
		);
		expect(runJellyfinCacheRefreshSingleFlight.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
		expect(runJellyfinCacheRefreshSingleFlight.mock.calls[0]?.[0]).not.toHaveProperty(
			"httpAuthHeaders",
		);
		expect(refreshOwnedJellyfinCache).toHaveBeenCalledWith(
			expect.objectContaining({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance: jellyfinInstance,
			}),
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
		expect(cacheStatusUpsert).not.toHaveBeenCalled();
	});

	it("does not refresh Jellyfin when the target is missing or not owned", async () => {
		findPlexInstance.mockResolvedValueOnce(null);

		const res = await inject("POST", "/pulse/signal-1/action", {
			body: {
				...body,
				target: { instanceId: "inst-jellyfin-1", cacheType: "jellyfin" },
				label: "Retry refresh",
			},
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("InstanceNotFoundError");
		expect(refreshOwnedJellyfinCache).not.toHaveBeenCalled();
	});

	it("rejects an owned Jellyfin action aimed at a different service", async () => {
		findPlexInstance.mockResolvedValueOnce({ ...jellyfinInstance, service: "PLEX" });

		const res = await inject("POST", "/pulse/signal-1/action", {
			body: {
				...body,
				target: { instanceId: "inst-jellyfin-1", cacheType: "jellyfin" },
				label: "Retry refresh",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("AppValidationError");
		expect(refreshOwnedJellyfinCache).not.toHaveBeenCalled();
	});

	it("logs only bounded fields when the owned Jellyfin refresh rejects", async () => {
		findPlexInstance.mockResolvedValueOnce(jellyfinInstance);
		refreshOwnedJellyfinCache.mockRejectedValueOnce(new Error("sentinel-secret"));
		const warn = vi.fn();
		const log = {
			info: vi.fn(),
			warn,
		} as unknown as FastifyBaseLogger;

		const result = await dispatchPulseAction(
			app,
			"user-1",
			{
				kind: "cache.refresh",
				target: { instanceId: "inst-jellyfin-1", cacheType: "jellyfin" },
				label: "Retry refresh",
				destructive: false,
			},
			log,
		);
		await result.backgroundTask;

		expect(warn).toHaveBeenCalledWith(
			{ cacheType: "jellyfin", settlement: "failed" },
			"Provider cache refresh settled",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("sentinel-secret");
	});
});
