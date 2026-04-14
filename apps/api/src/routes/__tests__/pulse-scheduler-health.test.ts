/**
 * Integration test for scheduler-health pulse signals on GET /pulse.
 *
 * Converts the PR #333 manual test-plan items into automated coverage:
 *   1. A job disabled with a reason emits `scheduler-disabled-<jobId>`
 *      in the /pulse response.
 *   2. A job with consecutiveFailures >= 2 emits
 *      `scheduler-failing-<jobId>` in the /pulse response.
 *
 * We boot Fastify with the real `/pulse` route and the real
 * `collectSchedulerHealth` collector, stubbing only
 * `app.schedulerRegistry.list()` so we can drive the two failure
 * scenarios deterministically without spinning up real schedulers.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus } from "../../lib/scheduler-registry/scheduler-registry.js";

// Swap the collectors module to expose ONLY the real collectSchedulerHealth
// collector. This keeps the route contract honest (we're running the actual
// function under test) while isolating us from the other collectors' DB
// dependencies.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
			"../../lib/pulse/collectors.js",
		);
	return { pulseCollectors: [actual.collectSchedulerHealth] };
});

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let jobs: JobStatus[];

// The pulse route caches responses in a module-level Map keyed by userId for
// 60 seconds. Each test uses a unique user so results are not served from
// another test's cache entry.
let userCounter = 0;

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

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-sched-${userCounter}`, username: "admin" });
	// Stub only the registry surface the collector reads. No other plugin
	// decorations are required — the collector does not touch Prisma or
	// the ARR client factory.
	app.decorate("schedulerRegistry", {
		list: () => jobs,
	} as unknown as never);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — scheduler health signals", () => {
	it("surfaces a disabled scheduler as scheduler-disabled-<jobId>", async () => {
		jobs = [
			makeJob({
				id: "hunting",
				label: "Hunting",
				state: "disabled",
				disabled: true,
				disabledReason: "Init failed: cannot reach hunting config table",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(i: { id: string }) => i.id === "scheduler-disabled-hunting",
		);

		expect(item).toBeDefined();
		expect(item.severity).toBe("warning");
		expect(item.category).toBe("operations");
		expect(item.title).toBe("Hunting is disabled");
		expect(item.detail).toContain("Init failed");
		expect(item.source).toBe("system");
		// Deep-link includes the item id as a hash so /pulse can scroll + highlight
		// the matching row for operators arriving from the Needs Attention panel.
		expect(item.actionUrl).toBe("/pulse#scheduler-disabled-hunting");

		expect(body.summary.warning).toBeGreaterThanOrEqual(1);
	});

	it("surfaces two consecutive tick failures as scheduler-failing-<jobId>", async () => {
		jobs = [
			makeJob({
				id: "queue-cleaner",
				label: "Queue Cleaner",
				consecutiveFailures: 2,
				lastError: "ECONNREFUSED",
				lastFailureAt: "2026-04-14T09:30:00.000Z",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(i: { id: string }) => i.id === "scheduler-failing-queue-cleaner",
		);

		expect(item).toBeDefined();
		expect(item.severity).toBe("warning");
		expect(item.category).toBe("operations");
		expect(item.title).toBe("Queue Cleaner is failing");
		expect(item.detail).toContain("2 consecutive failures");
		expect(item.detail).toContain("ECONNREFUSED");
		expect(item.timestamp).toBe("2026-04-14T09:30:00.000Z");

		expect(body.summary.warning).toBeGreaterThanOrEqual(1);
	});

	it("does not surface a scheduler item when all jobs are healthy", async () => {
		jobs = [
			makeJob({ id: "backup", label: "Backup", totalRuns: 42 }),
			makeJob({ id: "library-sync", label: "Library Sync" }),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(res.statusCode).toBe(200);

		const body = JSON.parse(res.payload);
		const schedulerItems = body.items.filter((i: { id: string }) =>
			i.id.startsWith("scheduler-"),
		);

		expect(schedulerItems).toEqual([]);
		expect(body.summary.critical + body.summary.warning).toBe(0);
	});
});
