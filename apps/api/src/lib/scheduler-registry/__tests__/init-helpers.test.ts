/**
 * Unit tests for `runSchedulerInit` — the helper that standardizes the
 * scheduler init failure-handling contract documented in
 * `docs/domains/schedulers.md`.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { runSchedulerInit } from "../init-helpers.js";
import { SchedulerRegistry } from "../scheduler-registry.js";

const NOOP_DEFINITION = {
	id: "test-job",
	label: "Test Job",
	description: "Used by init-helpers tests.",
	concurrency: "singleton" as const,
	intervalMs: 60_000,
};

function createFakeLogger(): FastifyBaseLogger {
	const log = {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		level: "info",
		silent: vi.fn(),
		// runSchedulerInit only calls .error() but the FastifyBaseLogger
		// type requires `child()` so we satisfy it by returning the same fake.
		child: () => log,
	};
	return log as unknown as FastifyBaseLogger;
}

describe("runSchedulerInit", () => {
	it("returns true and leaves the job idle when init succeeds", async () => {
		const registry = new SchedulerRegistry();
		registry.register(NOOP_DEFINITION);
		const log = createFakeLogger();
		const initFn = vi.fn(async () => {
			// no-op success
		});

		const ok = await runSchedulerInit({ registry, log }, "test-job", "test", initFn);

		expect(ok).toBe(true);
		expect(initFn).toHaveBeenCalledOnce();
		expect(registry.getStatus("test-job")).toMatchObject({
			state: "idle",
			disabled: false,
			disabledReason: null,
		});
		expect(log.error).not.toHaveBeenCalled();
	});

	it("returns false, logs at error level, and marks job disabled on init throw", async () => {
		const registry = new SchedulerRegistry();
		registry.register(NOOP_DEFINITION);
		const log = createFakeLogger();
		const boom = new Error("missing secrets file");

		const ok = await runSchedulerInit({ registry, log }, "test-job", "test", async () => {
			throw boom;
		});

		expect(ok).toBe(false);
		expect(registry.getStatus("test-job")).toMatchObject({
			state: "disabled",
			disabled: true,
			disabledReason: "Init failed: missing secrets file",
		});
		expect(log.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: boom, jobId: "test-job" }),
			expect.stringContaining("test scheduler"),
		);
	});

	it("does NOT re-throw — sibling scheduler init must keep running", async () => {
		// This is the key invariant: a single scheduler's init failure must
		// not propagate up the onReady hook chain and abort startup. The
		// caller awaits us; if we re-threw, the next plugin's onReady would
		// never run.
		const registry = new SchedulerRegistry();
		registry.register(NOOP_DEFINITION);
		const log = createFakeLogger();

		await expect(
			runSchedulerInit({ registry, log }, "test-job", "test", async () => {
				throw new Error("explosive init");
			}),
		).resolves.toBe(false);
	});

	it("formats non-Error thrown values into a readable disabledReason", async () => {
		// Some upstream libraries throw non-Error shapes (e.g. plain objects
		// from native bindings). The helper relies on getErrorMessage() to
		// produce a useful reason instead of "[object Object]" or empty string.
		const registry = new SchedulerRegistry();
		registry.register(NOOP_DEFINITION);
		const log = createFakeLogger();
		const weirdError = { code: "ENOENT", toString: () => "ENOENT: file missing" };

		await runSchedulerInit({ registry, log }, "test-job", "test", async () => {
			throw weirdError;
		});

		const status = registry.getStatus("test-job");
		expect(status?.disabled).toBe(true);
		// Reason starts with the standard prefix and surfaces the value via String().
		expect(status?.disabledReason).toMatch(/^Init failed:/);
		expect(status?.disabledReason).toContain("ENOENT");
	});
});
