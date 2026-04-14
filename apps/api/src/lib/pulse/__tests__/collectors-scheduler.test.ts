/**
 * Tests for collectSchedulerHealth pulse collector.
 *
 * V2.16.0 "Needs Attention" — PR 1: reuses the scheduler registry as a pulse
 * signal so jobs that are disabled with a reason, or failing repeatedly,
 * surface alongside existing attention items.
 *
 * Rules under test:
 *   - Healthy / idle jobs emit nothing.
 *   - Jobs with consecutiveFailures >= 2 emit a warning item.
 *   - Jobs disabled with a reason emit a warning item.
 *   - Disabled + failing emits only the disabled item (no duplicate).
 *   - Disabled without a reason emits nothing (defensive — don't invent copy).
 */

import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { JobStatus } from "../../scheduler-registry/scheduler-registry.js";
import { collectSchedulerHealth } from "../collectors.js";

const noop = vi.fn();
const mockLog = {
	warn: noop,
	error: noop,
	info: noop,
	debug: noop,
	trace: noop,
	fatal: noop,
	child: () => mockLog,
} as unknown as FastifyBaseLogger;

function makeJob(overrides: Partial<JobStatus> = {}): JobStatus {
	return {
		id: "example-job",
		label: "Example Job",
		description: "An example job",
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

function makeApp(jobs: JobStatus[]): FastifyInstance {
	return {
		schedulerRegistry: { list: () => jobs },
	} as unknown as FastifyInstance;
}

describe("collectSchedulerHealth — healthy jobs", () => {
	it("emits nothing when the registry is empty", async () => {
		const items = await collectSchedulerHealth(makeApp([]), "user-1", mockLog);
		expect(items).toEqual([]);
	});

	it("does not emit items for idle, healthy jobs", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({ id: "backup", label: "Backup" }),
				makeJob({ id: "library-sync", label: "Library Sync", totalRuns: 42 }),
			]),
			"user-1",
			mockLog,
		);
		expect(items).toEqual([]);
	});

	it("does not emit an item for a single isolated failure (< threshold)", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "hunting",
					label: "Hunting",
					consecutiveFailures: 1,
					lastError: "timeout",
					lastFailureAt: "2026-04-14T10:00:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);
		expect(items).toEqual([]);
	});

	it("does not emit an item for a running job without failure history", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "library-sync",
					label: "Library Sync",
					state: "running",
					lastStartedAt: "2026-04-14T10:00:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);
		expect(items).toEqual([]);
	});
});

describe("collectSchedulerHealth — failing jobs", () => {
	it("emits a warning when consecutiveFailures reaches 2", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "queue-cleaner",
					label: "Queue Cleaner",
					consecutiveFailures: 2,
					lastError: "ECONNREFUSED",
					lastFailureAt: "2026-04-14T09:30:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: "scheduler-failing-queue-cleaner",
			severity: "warning",
			category: "operations",
			title: "Queue Cleaner is failing",
			source: "system",
			actionUrl: "/pulse",
			timestamp: "2026-04-14T09:30:00.000Z",
		});
		expect(items[0]!.detail).toContain("2 consecutive failures");
		expect(items[0]!.detail).toContain("ECONNREFUSED");
	});

	it("includes the failure count in the detail line even without lastError", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "trash-sync",
					label: "TRaSH Sync",
					consecutiveFailures: 5,
					lastError: null,
					lastFailureAt: "2026-04-14T09:30:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items).toHaveLength(1);
		expect(items[0]!.detail).toBe("5 consecutive failures");
	});

	it("uses lastFailureAt as the timestamp when available", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "hunting",
					label: "Hunting",
					consecutiveFailures: 3,
					lastFailureAt: "2026-04-14T08:00:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items[0]!.timestamp).toBe("2026-04-14T08:00:00.000Z");
	});

	it("truncates very long lastError messages in the detail line", async () => {
		const longError = "x".repeat(500);
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "backup",
					label: "Backup",
					consecutiveFailures: 2,
					lastError: longError,
					lastFailureAt: "2026-04-14T09:30:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items[0]!.detail.length).toBeLessThanOrEqual(140);
		expect(items[0]!.detail.endsWith("…")).toBe(true);
	});
});

describe("collectSchedulerHealth — disabled jobs", () => {
	it("emits a warning when a job is disabled with a reason", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "hunting",
					label: "Hunting",
					state: "disabled",
					disabled: true,
					disabledReason: "Init failed: cannot reach hunting config table",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: "scheduler-disabled-hunting",
			severity: "warning",
			category: "operations",
			title: "Hunting is disabled",
			detail: "Init failed: cannot reach hunting config table",
			source: "system",
			actionUrl: "/pulse",
		});
	});

	it("does NOT emit a separate failing item when a job is both disabled and failing", async () => {
		// Disabled is the root cause; showing both would be duplicate noise.
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "queue-cleaner",
					label: "Queue Cleaner",
					state: "disabled",
					disabled: true,
					disabledReason: "Init failed: schema mismatch",
					consecutiveFailures: 7,
					lastError: "schema mismatch",
					lastFailureAt: "2026-04-14T09:30:00.000Z",
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items).toHaveLength(1);
		expect(items[0]!.id).toBe("scheduler-disabled-queue-cleaner");
	});

	it("does not emit anything when a job is disabled without a reason", async () => {
		// Defensive — don't invent operator-facing copy we can't substantiate.
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({
					id: "example",
					label: "Example",
					state: "disabled",
					disabled: true,
					disabledReason: null,
				}),
			]),
			"user-1",
			mockLog,
		);

		expect(items).toEqual([]);
	});
});

describe("collectSchedulerHealth — mixed registry", () => {
	it("emits items only for the jobs that need attention", async () => {
		const items = await collectSchedulerHealth(
			makeApp([
				makeJob({ id: "backup", label: "Backup" }), // healthy
				makeJob({
					id: "hunting",
					label: "Hunting",
					consecutiveFailures: 3,
					lastError: "boom",
					lastFailureAt: "2026-04-14T09:00:00.000Z",
				}),
				makeJob({
					id: "queue-cleaner",
					label: "Queue Cleaner",
					state: "disabled",
					disabled: true,
					disabledReason: "Init failed: bad config",
				}),
				makeJob({ id: "trash-sync", label: "TRaSH Sync", consecutiveFailures: 1 }), // under threshold
			]),
			"user-1",
			mockLog,
		);

		const ids = items.map((i) => i.id).sort();
		expect(ids).toEqual(["scheduler-disabled-queue-cleaner", "scheduler-failing-hunting"]);
	});
});
