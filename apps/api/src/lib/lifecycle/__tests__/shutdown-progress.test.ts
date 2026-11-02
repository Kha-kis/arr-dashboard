import { afterEach, describe, expect, it, vi } from "vitest";
import { startShutdownProgress } from "../shutdown-progress.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("shutdown progress", () => {
	it("reports immediately and every five seconds until idempotent stop", () => {
		vi.useFakeTimers();
		let now = 20;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const reports: unknown[] = [];
		let pendingHandlers = 2;
		const progress = startShutdownProgress({
			read: () => ({ phase: "fastify", pendingHandlers, runningSchedulers: 1 }),
			report: (payload) => reports.push(payload),
		});
		expect(reports).toEqual([
			{ phase: "fastify", pendingHandlers: 2, runningSchedulers: 1, elapsedMs: 0 },
		]);
		vi.advanceTimersByTime(4999);
		expect(reports).toHaveLength(1);
		now = 5020;
		pendingHandlers = 1;
		vi.advanceTimersByTime(1);
		expect(reports[1]).toEqual({
			phase: "fastify",
			pendingHandlers: 1,
			runningSchedulers: 1,
			elapsedMs: 5000,
		});
		progress.stop();
		progress.stop();
		vi.advanceTimersByTime(10000);
		progress.report();
		expect(reports).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unrefs its timer so diagnostics alone cannot keep a process alive", () => {
		const timers: ReturnType<typeof setInterval>[] = [];
		const set = globalThis.setInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
			const timer = set(...args);
			timers.push(timer);
			return timer;
		});
		const progress = startShutdownProgress({
			read: () => ({ phase: "runtime" }),
			report: () => {},
		});
		try {
			expect(timers).toHaveLength(1);
			expect(timers[0]!.hasRef()).toBe(false);
		} finally {
			progress.stop();
		}
	});

	it.each(["read", "report"] as const)(
		"isolates %s failures and still clears its timer",
		(failure) => {
			vi.useFakeTimers();
			let attempts = 0;
			const progress = startShutdownProgress({
				read: () => {
					if (failure === "read") {
						attempts++;
						throw new Error("Synthetic private detail");
					}
					return { phase: "initialization" };
				},
				report: () => {
					attempts++;
					throw new Error("Synthetic private detail");
				},
			});
			expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
			expect(attempts).toBe(2);
			progress.stop();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
