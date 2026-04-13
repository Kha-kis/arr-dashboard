/**
 * GET /system/jobs HTTP integration tests.
 *
 * Boots Fastify with the REAL scheduler-registry plugin (no mock) so the
 * full wiring — KNOWN_JOBS catalog -> registry.list() -> route response
 * shape — is exercised end-to-end. Existing scheduler-registry.test.ts only
 * covers the registry class in isolation; this fills the HTTP surface gap.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import schedulerRegistryPlugin from "../../plugins/scheduler-registry.js";
import { registerSystemRoutes } from "../system.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	app = Fastify();

	// Decorations system.ts touches that aren't relevant to /jobs but are
	// referenced when the plugin loads (lifecycle, prisma, dbProvider, config).
	app.decorate("prisma", {
		systemSettings: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
	} as never);
	app.decorate("config", { TRUST_PROXY: false, COOKIE_SECURE: false } as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("lifecycle", {
		getRestartMessage: () => "ok",
		restart: vi.fn(),
	} as never);

	setupAuthInjection(app);
	await app.register(schedulerRegistryPlugin);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("GET /system/jobs", () => {
	it("returns the full pre-registered job catalog with shape contract", async () => {
		const res = await injectAuthenticated("GET", "/system/jobs");

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);

		expect(body.success).toBe(true);
		expect(typeof body.data.capturedAt).toBe("string");
		expect(body.data.count).toBe(body.data.jobs.length);
		expect(body.data.jobs.length).toBeGreaterThan(0);

		// Every known job ID should appear — guards against a plugin silently
		// dropping a registration during refactors.
		const ids = new Set(body.data.jobs.map((j: any) => j.id));
		expect(ids.has(JOB_ID.queueCleaner)).toBe(true);
		expect(ids.has(JOB_ID.libraryCleanup)).toBe(true);
		expect(ids.has(JOB_ID.hunting)).toBe(true);

		// Every job has the JobStatus contract — fields exist even when never run
		const sample = body.data.jobs[0];
		expect(sample).toMatchObject({
			id: expect.any(String),
			label: expect.any(String),
			description: expect.any(String),
			state: expect.stringMatching(/^(idle|running|disabled)$/),
			lastStartedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastError: null,
			consecutiveFailures: 0,
			totalRuns: 0,
			totalFailures: 0,
			disabled: false,
		});

		// Sorted by id (stable contract for UI rendering)
		const sorted = [...body.data.jobs]
			.map((j: any) => j.id)
			.slice()
			.sort();
		expect(body.data.jobs.map((j: any) => j.id)).toEqual(sorted);
	});

	it("reflects runtime updates after a successful track() — totalRuns + lastSuccessAt", async () => {
		// Simulate one tick of the queue cleaner via the live registry
		const result = await app.schedulerRegistry.track(JOB_ID.queueCleaner, async () => "ok");
		expect(result).toBe("ok");

		const res = await injectAuthenticated("GET", "/system/jobs");
		const body = JSON.parse(res.payload);
		const job = body.data.jobs.find((j: any) => j.id === JOB_ID.queueCleaner);

		expect(job).toBeDefined();
		expect(job.totalRuns).toBe(1);
		expect(job.totalFailures).toBe(0);
		expect(job.consecutiveFailures).toBe(0);
		expect(job.lastSuccessAt).not.toBeNull();
		expect(job.lastFailureAt).toBeNull();
		expect(job.lastError).toBeNull();
		expect(typeof job.lastDurationMs).toBe("number");
		expect(job.state).toBe("idle");
	});

	it("increments consecutiveFailures and surfaces lastError after a failed track()", async () => {
		await expect(
			app.schedulerRegistry.track(JOB_ID.libraryCleanup, async () => {
				throw new Error("simulated library cleanup failure");
			}),
		).rejects.toThrow("simulated library cleanup failure");

		// Second consecutive failure to confirm the counter actually accumulates
		// (not just toggles 0 -> 1).
		await expect(
			app.schedulerRegistry.track(JOB_ID.libraryCleanup, async () => {
				throw new Error("second failure");
			}),
		).rejects.toThrow("second failure");

		const res = await injectAuthenticated("GET", "/system/jobs");
		const body = JSON.parse(res.payload);
		const job = body.data.jobs.find((j: any) => j.id === JOB_ID.libraryCleanup);

		expect(job.consecutiveFailures).toBe(2);
		expect(job.totalFailures).toBe(2);
		expect(job.totalRuns).toBe(2);
		expect(job.lastError).toBe("second failure");
		expect(job.lastFailureAt).not.toBeNull();
		expect(job.lastSuccessAt).toBeNull();
	});

	it("resets consecutiveFailures on the next success but preserves total counters", async () => {
		await expect(
			app.schedulerRegistry.track(JOB_ID.hunting, async () => {
				throw new Error("transient");
			}),
		).rejects.toThrow();
		await app.schedulerRegistry.track(JOB_ID.hunting, async () => "recovered");

		const res = await injectAuthenticated("GET", "/system/jobs");
		const body = JSON.parse(res.payload);
		const job = body.data.jobs.find((j: any) => j.id === JOB_ID.hunting);

		expect(job.consecutiveFailures).toBe(0);
		expect(job.totalRuns).toBe(2);
		expect(job.totalFailures).toBe(1);
		expect(job.lastError).toBeNull();
	});

	it("endpoint never triggers job execution — totalRuns stays flat across repeated GETs", async () => {
		// Contract from the route docstring: "The endpoint never triggers job execution."
		await app.schedulerRegistry.track(JOB_ID.queueCleaner, async () => "ok");
		const baselineRuns = JSON.parse(
			(await injectAuthenticated("GET", "/system/jobs")).payload,
		).data.jobs.find((j: any) => j.id === JOB_ID.queueCleaner).totalRuns;

		// Hammer the endpoint — totalRuns must not change
		for (let i = 0; i < 5; i++) {
			await injectAuthenticated("GET", "/system/jobs");
		}

		const afterRuns = JSON.parse(
			(await injectAuthenticated("GET", "/system/jobs")).payload,
		).data.jobs.find((j: any) => j.id === JOB_ID.queueCleaner).totalRuns;

		expect(afterRuns).toBe(baselineRuns);
	});
});
