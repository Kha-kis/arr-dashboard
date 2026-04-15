/**
 * End-to-end integration test for the Pulse actionability contract.
 *
 * Wires together everything PR 1 + PR 2 touched:
 *   - real `/pulse` route
 *   - real `/pulse/:id/action` route
 *   - real `collectSchedulerHealth` collector
 *   - real `dispatchPulseAction` dispatcher
 *
 * The only surfaces stubbed are the external ones (scheduler registry,
 * scheduler getters). This substitutes for the "manual: click the button
 * in a browser" checklist item — it proves the same contract the manual
 * test was asking for, is repeatable, and fails loudly if any link in
 * the chain (envelope → collector → route → dispatcher → cache
 * invalidation) breaks.
 *
 * Scenarios:
 *   1. Disabled hunting scheduler surfaces with an action.
 *   2. POST to the action route with that envelope returns 200 AND starts
 *      the scheduler.
 *   3. After success the per-user Pulse cache is invalidated — the row
 *      drops on the next GET /pulse poll (mirroring what the frontend
 *      sees after `pulseKeys` invalidation).
 *   4. A second POST against the same signal (now running) returns 409
 *      — the "already satisfied" safety net that protects the
 *      double-click case.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus } from "../../lib/scheduler-registry/scheduler-registry.js";

// Stub scheduler getters so we can drive isRunning() deterministically and
// observe start() calls. The collector uses `app.schedulerRegistry.list()`
// (stubbed via app.decorate below), but the dispatcher reaches for the
// module-level getters — so both seams need coverage.
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

// Expose only the collector under test — other collectors touch Prisma /
// ARR clients that we don't want to stand up for this e2e.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectSchedulerHealth] };
});

import { registerPulseRoutes } from "../pulse.js";
import { registerTestErrorHandler } from "./test-helpers.js";

// Unique user per test — the /pulse route caches per-user for 60s. Without
// this, scenario (3) can't reliably observe a refetch.
let userCounter = 0;
let jobs: JobStatus[];
let app: FastifyInstance;

const AUTH_HEADER = "x-test-auth";

function setupAuthGate(app: FastifyInstance, userId: string) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = { id: userId, username: "admin" };
			req.sessionToken = "mock-session-token";
		}
	});
}

function makeJob(overrides: Partial<JobStatus> = {}): JobStatus {
	return {
		id: "example-job",
		label: "Example Job",
		description: "",
		concurrency: "singleton",
		state: "idle",
		lastStartedAt: null,
		lastFinishedAt: null,
		lastSuccessAt: null,
		lastFailureAt: null,
		lastDurationMs: null,
		lastError: null,
		consecutiveFailures: 0,
		totalRuns: 0,
		totalFailures: 0,
		disabled: false,
		disabledReason: null,
		...overrides,
	};
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

beforeEach(async () => {
	userCounter += 1;
	huntingScheduler.isRunning.mockReset();
	huntingScheduler.start.mockReset();
	queueCleanerScheduler.isRunning.mockReset();
	queueCleanerScheduler.start.mockReset();

	app = Fastify({ logger: false });
	setupAuthGate(app, `e2e-user-${userCounter}`);
	app.decorate("schedulerRegistry", { list: () => jobs } as unknown as never);
	registerTestErrorHandler(app);
	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("Pulse actionability — end-to-end (PR 1 + PR 2)", () => {
	it("disabled hunting scheduler → button-bearing item → successful enable → cache invalidation → double-click yields 409", async () => {
		// -------------------------------------------------------------------
		// 1. Collector emits a disabled item with an action envelope.
		// -------------------------------------------------------------------
		jobs = [
			makeJob({
				id: "hunting",
				label: "Hunting",
				state: "disabled",
				disabled: true,
				disabledReason: "Init failed: cannot reach hunting config table",
			}),
		];
		huntingScheduler.isRunning.mockReturnValue(false); // the scheduler is down, matching the disabled state

		const firstPulse = await injectGet("/pulse");
		expect(firstPulse.statusCode).toBe(200);

		const firstBody = JSON.parse(firstPulse.payload);
		const disabledItem = firstBody.items.find(
			(i: { id: string }) => i.id === "scheduler-disabled-hunting",
		);
		expect(disabledItem).toBeDefined();
		expect(disabledItem.action).toEqual({
			kind: "scheduler.enable",
			target: { jobId: "hunting" },
			label: "Enable",
			confirmLabel: "Click again to enable",
			destructive: false,
		});

		// -------------------------------------------------------------------
		// 2. POST the action envelope verbatim to the action route.
		//    This is exactly what <PulseActionButton /> does client-side.
		// -------------------------------------------------------------------
		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(disabledItem.id)}/action`,
			disabledItem.action,
		);
		expect(actionRes.statusCode).toBe(200);
		expect(JSON.parse(actionRes.payload)).toEqual({ status: "ok" });
		expect(huntingScheduler.start).toHaveBeenCalledTimes(1);

		// -------------------------------------------------------------------
		// 3. Next GET /pulse after invalidation should see the new state.
		//    Simulate the scheduler actually starting by flipping isRunning
		//    (matches what the live dispatcher would cause) and flipping
		//    the registry to an enabled job. If the cache had survived, we
		//    would still see the stale disabled item — that's the
		//    regression this step guards against.
		// -------------------------------------------------------------------
		huntingScheduler.isRunning.mockReturnValue(true);
		jobs = [
			makeJob({
				id: "hunting",
				label: "Hunting",
				state: "idle",
				disabled: false,
				disabledReason: null,
			}),
		];

		const secondPulse = await injectGet("/pulse");
		const secondBody = JSON.parse(secondPulse.payload);
		const stillDisabled = secondBody.items.find(
			(i: { id: string }) => i.id === "scheduler-disabled-hunting",
		);
		expect(stillDisabled).toBeUndefined(); // row dropped on next poll

		// -------------------------------------------------------------------
		// 4. Double-click safety: a second POST against the same action
		//    must 409. This is what protects the operator from
		//    accidentally "re-enabling" something already running.
		// -------------------------------------------------------------------
		const duplicateRes = await injectPost(
			`/pulse/${encodeURIComponent(disabledItem.id)}/action`,
			disabledItem.action,
		);
		expect(duplicateRes.statusCode).toBe(409);
		expect(JSON.parse(duplicateRes.payload).error).toBe("ConflictError");
		// start() should NOT have been called a second time — the dispatcher
		// short-circuits on isRunning() before reaching scheduler.start(app).
		expect(huntingScheduler.start).toHaveBeenCalledTimes(1);
	});
});
