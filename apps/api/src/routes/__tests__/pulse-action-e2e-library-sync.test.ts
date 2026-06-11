/**
 * End-to-end integration test for the library.sync action path.
 *
 * Companion to pulse-action-e2e.test.ts (scheduler.enable),
 * pulse-action-e2e-cache.test.ts (cache.refresh), and
 * pulse-action-e2e-queue.test.ts (queue.retry). Proves the same contract
 * across the library.sync dispatcher branch:
 *
 *   1. A failing library sync surfaces with a library.sync envelope.
 *   2. POSTing the envelope invokes scheduler.triggerSync(instanceId)
 *      and 200s immediately (fire-and-forget — accepted, not completed).
 *   3. After the (stubbed) sync clears lastError, the next GET /pulse
 *      drops the row — proving server-side cache invalidation fired.
 *   4. Error contract: 404 unowned/missing instance, 400 non-library
 *      service, 409 sync already in progress.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const librarySyncScheduler = {
	isInstanceSyncing: vi.fn<(instanceId: string) => boolean>(),
	triggerSync: vi.fn<(instanceId: string) => Promise<unknown>>(),
};

vi.mock("../../lib/library-sync/index.js", () => ({
	getLibrarySyncScheduler: () => librarySyncScheduler,
}));

vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectLibrarySyncHealth] };
});

import { registerPulseRoutes } from "../pulse.js";
import { makePulseDismissalStub, registerTestErrorHandler } from "./test-helpers.js";

const AUTH_HEADER = "x-test-auth";
const HOURS = 60 * 60 * 1000;

let app: ReturnType<typeof Fastify>;
let userCounter = 0;
let syncStatuses: Array<Record<string, unknown>>;
let instances: Array<{ id: string; service: string; label: string; enabled: boolean }>;

function setupAuthGate(app: ReturnType<typeof Fastify>, userId: string) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = { id: userId, username: "admin" };
			req.sessionToken = "mock-session-token";
		}
	});
}

async function injectGet(url: string) {
	return app.inject({ method: "GET", url, headers: { [AUTH_HEADER]: "1" } });
}

async function injectPost(url: string, body: unknown) {
	return app.inject({
		method: "POST",
		url,
		headers: { [AUTH_HEADER]: "1", "content-type": "application/json" },
		payload: JSON.stringify(body),
	});
}

function makeErrorRow(instanceId: string) {
	return {
		id: `row-${instanceId}`,
		instanceId,
		lastFullSync: new Date(Date.now() - 2 * HOURS),
		syncInProgress: false,
		lastError: "fetch failed: ECONNREFUSED",
		pollingEnabled: true,
		pollingIntervalMins: 15,
		createdAt: new Date(Date.now() - 30 * 24 * HOURS),
		updatedAt: new Date(Date.now() - 1 * HOURS),
		instance: { label: "Home Sonarr", service: "SONARR" },
	};
}

const ACTION_BODY = {
	kind: "library.sync",
	target: { instanceId: "inst-sonarr-1" },
	label: "Sync now",
	destructive: false,
};

beforeEach(async () => {
	userCounter += 1;
	librarySyncScheduler.isInstanceSyncing.mockReset().mockReturnValue(false);
	librarySyncScheduler.triggerSync.mockReset().mockResolvedValue(null);

	syncStatuses = [makeErrorRow("inst-sonarr-1")];
	instances = [{ id: "inst-sonarr-1", service: "SONARR", label: "Home Sonarr", enabled: true }];

	app = Fastify({ logger: false });
	setupAuthGate(app, `e2e-libsync-user-${userCounter}`);
	registerTestErrorHandler(app);

	app.decorate("prisma", {
		librarySyncStatus: {
			findMany: async () => syncStatuses,
		},
		serviceInstance: {
			findFirst: async ({ where }: { where: { id: string; enabled?: boolean } }) =>
				instances.find((i) => i.id === where.id && i.enabled) ?? null,
		},
		pulseDismissal: makePulseDismissalStub(),
	} as unknown as never);

	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("library.sync action — end to end", () => {
	it("signal → action → row drops after the sync recovers", async () => {
		// 1. The failing sync surfaces with the action envelope.
		const before = JSON.parse((await injectGet("/pulse")).payload);
		const row = before.items.find(
			(i: { id: string }) => i.id === "library-sync-error-inst-sonarr-1",
		);
		expect(row).toBeDefined();
		expect(row.action).toEqual(ACTION_BODY);

		// 2. POST the envelope — triggerSync fires, 200 returned immediately.
		const res = await injectPost("/pulse/library-sync-error-inst-sonarr-1/action", row.action);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
		expect(librarySyncScheduler.triggerSync).toHaveBeenCalledWith("inst-sonarr-1");

		// 3. Simulate the background sync succeeding (executor clears
		// lastError + bumps lastFullSync), then prove the row drops on the
		// next poll. If the per-user Pulse cache had survived the action,
		// we'd still see the stale row here.
		syncStatuses = [
			{
				...makeErrorRow("inst-sonarr-1"),
				lastError: null,
				lastFullSync: new Date(),
			},
		];
		const after = JSON.parse((await injectGet("/pulse")).payload);
		expect(after.items.filter((i: { id: string }) => i.id.startsWith("library-sync-"))).toEqual([]);
	});

	it("404s for a missing or unowned instance", async () => {
		const res = await injectPost("/pulse/sig/action", {
			...ACTION_BODY,
			target: { instanceId: "inst-not-mine" },
		});
		expect(res.statusCode).toBe(404);
		expect(librarySyncScheduler.triggerSync).not.toHaveBeenCalled();
	});

	it("400s when the instance is not a library service", async () => {
		instances = [{ id: "inst-plex-1", service: "PLEX", label: "Home Plex", enabled: true }];

		const res = await injectPost("/pulse/sig/action", {
			...ACTION_BODY,
			target: { instanceId: "inst-plex-1" },
		});
		expect(res.statusCode).toBe(400);
		expect(librarySyncScheduler.triggerSync).not.toHaveBeenCalled();
	});

	it("409s when a sync is already in progress", async () => {
		librarySyncScheduler.isInstanceSyncing.mockReturnValue(true);

		const res = await injectPost("/pulse/sig/action", ACTION_BODY);
		expect(res.statusCode).toBe(409);
		expect(librarySyncScheduler.triggerSync).not.toHaveBeenCalled();
	});

	it("still 200s when the background trigger ultimately rejects (fire-and-forget)", async () => {
		// The route returns as soon as the sync is accepted; a later trigger
		// failure is logged and recorded by the executor as lastError. The
		// catch in the dispatcher must swallow the rejection so it can't
		// become an unhandled rejection.
		librarySyncScheduler.triggerSync.mockRejectedValue(new Error("boom"));

		const res = await injectPost("/pulse/sig/action", ACTION_BODY);
		expect(res.statusCode).toBe(200);
	});
});
