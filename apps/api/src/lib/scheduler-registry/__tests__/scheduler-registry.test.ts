/**
 * SchedulerRegistry unit tests.
 *
 * Uses vitest fake timers + an injected Clock so success/failure/duration
 * tracking is deterministic without relying on real-time wall clocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Clock,
	SchedulerRegistry,
	SerialJobBusyError,
	UnknownJobError,
} from "../scheduler-registry.js";

/**
 * Clock that advances through a preset sequence of Dates on each `now()` call.
 * Each call to `now()` consumes the next value (or repeats the last one).
 */
function scriptedClock(times: Date[]): Clock {
	let i = 0;
	return {
		now: () => {
			const next = times[Math.min(i, times.length - 1)];
			i += 1;
			if (!next) throw new Error("scriptedClock exhausted");
			return next;
		},
	};
}

const BASE_DEFINITION = {
	id: "example-job",
	label: "Example Job",
	description: "A job used in tests.",
	concurrency: "singleton" as const,
	intervalMs: 60_000,
};

describe("SchedulerRegistry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers a job and returns default status before any run", () => {
		const registry = new SchedulerRegistry();
		registry.register(BASE_DEFINITION);

		const status = registry.getStatus("example-job");
		expect(status).toMatchObject({
			id: "example-job",
			label: "Example Job",
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
		});
	});

	it("tracks a successful run and records duration using the injected clock", async () => {
		const start = new Date("2026-01-01T00:00:00.000Z");
		const end = new Date("2026-01-01T00:00:01.250Z");
		const registry = new SchedulerRegistry(scriptedClock([start, end]));
		registry.register(BASE_DEFINITION);

		const result = await registry.track("example-job", async () => "ok");

		expect(result).toBe("ok");
		const status = registry.getStatus("example-job");
		expect(status).toMatchObject({
			state: "idle",
			lastStartedAt: start.toISOString(),
			lastFinishedAt: end.toISOString(),
			lastSuccessAt: end.toISOString(),
			lastFailureAt: null,
			lastDurationMs: 1250,
			lastError: null,
			consecutiveFailures: 0,
			totalRuns: 1,
			totalFailures: 0,
		});
	});

	it("tracks a failed run, re-throws, and increments consecutiveFailures", async () => {
		const start = new Date("2026-01-01T00:00:00.000Z");
		const end = new Date("2026-01-01T00:00:00.500Z");
		const registry = new SchedulerRegistry(scriptedClock([start, end]));
		registry.register(BASE_DEFINITION);

		await expect(
			registry.track("example-job", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const status = registry.getStatus("example-job");
		expect(status).toMatchObject({
			state: "idle",
			lastStartedAt: start.toISOString(),
			lastFinishedAt: end.toISOString(),
			lastSuccessAt: null,
			lastFailureAt: end.toISOString(),
			lastDurationMs: 500,
			lastError: "boom",
			consecutiveFailures: 1,
			totalRuns: 1,
			totalFailures: 1,
		});
	});

	it("resets consecutiveFailures on the next success but preserves totals", async () => {
		const registry = new SchedulerRegistry(
			scriptedClock([
				new Date("2026-01-01T00:00:00.000Z"),
				new Date("2026-01-01T00:00:01.000Z"),
				new Date("2026-01-01T00:00:10.000Z"),
				new Date("2026-01-01T00:00:11.000Z"),
				new Date("2026-01-01T00:00:20.000Z"),
				new Date("2026-01-01T00:00:21.000Z"),
			]),
		);
		registry.register(BASE_DEFINITION);

		await expect(
			registry.track("example-job", async () => {
				throw new Error("first");
			}),
		).rejects.toThrow("first");
		await expect(
			registry.track("example-job", async () => {
				throw new Error("second");
			}),
		).rejects.toThrow("second");
		await registry.track("example-job", async () => "ok");

		const status = registry.getStatus("example-job");
		expect(status).toMatchObject({
			consecutiveFailures: 0,
			totalRuns: 3,
			totalFailures: 2,
			lastError: null,
		});
	});

	it("rejects overlapping runs for serial jobs and preserves prior state", async () => {
		const registry = new SchedulerRegistry(
			scriptedClock([new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:05.000Z")]),
		);
		registry.register({ ...BASE_DEFINITION, concurrency: "serial" });

		let resolveFirst: (value: string) => void = () => {};
		const firstPromise = registry.track(
			"example-job",
			() =>
				new Promise<string>((resolve) => {
					resolveFirst = resolve;
				}),
		);

		// While the first run is still in-flight, a second call should fail fast.
		await expect(registry.track("example-job", async () => "second")).rejects.toBeInstanceOf(
			SerialJobBusyError,
		);

		// State remains "running" until first completes.
		expect(registry.getStatus("example-job")?.state).toBe("running");

		resolveFirst("done");
		await firstPromise;

		const status = registry.getStatus("example-job");
		expect(status).toMatchObject({
			state: "idle",
			totalRuns: 1,
			totalFailures: 0,
		});
	});

	it("allows parallel jobs to overlap without throwing", async () => {
		const registry = new SchedulerRegistry(
			scriptedClock([
				new Date("2026-01-01T00:00:00.000Z"),
				new Date("2026-01-01T00:00:00.500Z"),
				new Date("2026-01-01T00:00:00.750Z"),
				new Date("2026-01-01T00:00:01.000Z"),
			]),
		);
		registry.register({ ...BASE_DEFINITION, concurrency: "parallel" });

		const a = registry.track("example-job", async () => "a");
		const b = registry.track("example-job", async () => "b");

		await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
		expect(registry.getStatus("example-job")?.totalRuns).toBe(2);
	});

	it("reflects markDisabled / markEnabled in state and status", () => {
		const registry = new SchedulerRegistry();
		registry.register(BASE_DEFINITION);

		registry.markDisabled("example-job", "feature flag off");
		expect(registry.getStatus("example-job")).toMatchObject({
			state: "disabled",
			disabled: true,
			disabledReason: "feature flag off",
		});

		registry.markEnabled("example-job");
		expect(registry.getStatus("example-job")).toMatchObject({
			state: "idle",
			disabled: false,
			disabledReason: null,
		});
	});

	it("returns null for unknown jobs and throws from track()", async () => {
		const registry = new SchedulerRegistry();
		expect(registry.getStatus("missing")).toBeNull();
		await expect(registry.track("missing", async () => "x")).rejects.toBeInstanceOf(
			UnknownJobError,
		);
	});

	it("list() returns all jobs sorted by id", () => {
		const registry = new SchedulerRegistry();
		registry.register({ ...BASE_DEFINITION, id: "zeta-job", label: "Zeta" });
		registry.register({ ...BASE_DEFINITION, id: "alpha-job", label: "Alpha" });

		expect(registry.list().map((j) => j.id)).toEqual(["alpha-job", "zeta-job"]);
	});

	it("trackTick wrapper plumbed into a class surfaces success state on the registry", async () => {
		// Exercises the pattern plugins use to instrument delegate scheduler classes:
		// the class accepts an optional trackTick wrapper; the plugin supplies one
		// that forwards to registry.track(). This verifies a successful tick bumps
		// lastSuccessAt + lastDurationMs on the registry side.
		const start = new Date("2026-01-01T00:00:00.000Z");
		const end = new Date("2026-01-01T00:00:00.750Z");
		const registry = new SchedulerRegistry(scriptedClock([start, end]));
		registry.register(BASE_DEFINITION);

		// Simulate a delegate class that accepts a TickWrapper.
		class MiniScheduler {
			constructor(private trackTick: <T>(fn: () => Promise<T>) => Promise<T>) {}
			async runOnce(): Promise<void> {
				await this.trackTick(async () => {
					// Imagine the real tick body here.
				});
			}
		}

		const scheduler = new MiniScheduler((fn) => registry.track("example-job", fn));
		await scheduler.runOnce();

		expect(registry.getStatus("example-job")).toMatchObject({
			state: "idle",
			lastSuccessAt: end.toISOString(),
			lastFailureAt: null,
			lastDurationMs: 750,
			totalRuns: 1,
			totalFailures: 0,
			consecutiveFailures: 0,
		});
	});

	it("trackTick wrapper plumbed into a class surfaces failure state on the registry", async () => {
		const start = new Date("2026-01-01T00:00:00.000Z");
		const end = new Date("2026-01-01T00:00:00.200Z");
		const registry = new SchedulerRegistry(scriptedClock([start, end]));
		registry.register(BASE_DEFINITION);

		class MiniScheduler {
			constructor(private trackTick: <T>(fn: () => Promise<T>) => Promise<T>) {}
			async runOnce(): Promise<void> {
				await this.trackTick(async () => {
					throw new Error("tick blew up");
				});
			}
		}

		const scheduler = new MiniScheduler((fn) => registry.track("example-job", fn));

		// The wrapper re-throws so the class's existing error path still fires.
		await expect(scheduler.runOnce()).rejects.toThrow("tick blew up");

		expect(registry.getStatus("example-job")).toMatchObject({
			state: "idle",
			lastSuccessAt: null,
			lastFailureAt: end.toISOString(),
			lastError: "tick blew up",
			consecutiveFailures: 1,
			totalRuns: 1,
			totalFailures: 1,
		});
	});

	it("re-registering a job preserves accumulated stats", async () => {
		const registry = new SchedulerRegistry(
			scriptedClock([new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z")]),
		);
		registry.register(BASE_DEFINITION);
		await registry.track("example-job", async () => "ok");

		registry.register({ ...BASE_DEFINITION, label: "Renamed" });

		expect(registry.getStatus("example-job")).toMatchObject({
			label: "Renamed",
			totalRuns: 1,
		});
	});
});
