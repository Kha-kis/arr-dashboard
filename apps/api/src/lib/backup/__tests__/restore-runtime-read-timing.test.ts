import { afterEach, describe, expect, it, vi } from "vitest";
import {
	measureRuntimeReadTiming,
	type RuntimeReadTiming,
	startRuntimeReadTiming,
	withRuntimeReadTiming,
} from "../restore-runtime-read-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("scoped runtime read timing", () => {
	it("does not read the clock or retain work outside an opted-in scope", () => {
		const clock = vi.spyOn(performance, "now").mockImplementation(() => {
			throw new Error("unrequested instrumentation");
		});
		expect(() => startRuntimeReadTiming("guard")()).not.toThrow();
		const original = Promise.resolve("original-value");
		expect(measureRuntimeReadTiming("guard", () => original)).toBe(original);
		expect(clock).not.toHaveBeenCalled();
	});

	it("aggregates repeated and overlapping spans without storing samples or double finishes", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		let result!: RuntimeReadTiming;
		const value = await withRuntimeReadTiming(
			async () => {
				const guard = startRuntimeReadTiming("guard");
				clock = 2;
				const owner = startRuntimeReadTiming("owner-proof");
				clock = 7;
				owner();
				guard();
				guard();
				await measureRuntimeReadTiming("guard", async () => {
					clock = 10;
				});
				return "original-value";
			},
			(stages) => {
				result = stages;
			},
		);
		expect(value).toBe("original-value");
		expect(result.guard).toEqual({ count: 2, totalMs: 10, maxMs: 7 });
		expect(result["owner-proof"]).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
		expect(result.yield).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.values(result).every(Object.isFrozen)).toBe(true);
	});

	it.each([false, true])(
		"preserves the original outcome when the sink throws (failure=%s)",
		async (fails) => {
			const sentinel = new Error("synthetic-private-error");
			let result!: RuntimeReadTiming;
			const operation = withRuntimeReadTiming(
				() =>
					measureRuntimeReadTiming("statement-call", async () => {
						if (fails) throw sentinel;
						return "original-value";
					}),
				(stages) => {
					result = stages;
					throw new Error("diagnostic-sink-error");
				},
			);
			if (fails) await expect(operation).rejects.toBe(sentinel);
			else await expect(operation).resolves.toBe("original-value");
			expect(result["statement-call"].count).toBe(1);
			expect(JSON.stringify(result)).not.toContain("synthetic");
		},
	);

	it("isolates concurrent scopes and ignores their late finishes", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first!: RuntimeReadTiming;
		let second!: RuntimeReadTiming;
		let late!: () => void;
		const pending = withRuntimeReadTiming(
			async () => {
				const finish = startRuntimeReadTiming("guard");
				late = startRuntimeReadTiming("connect");
				await held;
				finish();
			},
			(stages) => {
				first = stages;
			},
		);
		clock = 2;
		await withRuntimeReadTiming(
			async () => {
				const finish = startRuntimeReadTiming("yield");
				clock = 7;
				finish();
			},
			(stages) => {
				second = stages;
			},
		);
		clock = 10;
		release();
		await pending;
		clock = 15;
		late();
		expect(first.guard).toEqual({ count: 1, totalMs: 10, maxMs: 10 });
		expect(first.connect.count).toBe(0);
		expect(first.yield.count).toBe(0);
		expect(second.yield).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
		expect(second.guard.count).toBe(0);
	});

	it("restores the parent scope after a nested diagnostic and closes inherited child scopes", async () => {
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
		let outer!: RuntimeReadTiming;
		let inner!: RuntimeReadTiming;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let inherited!: Promise<void>;
		await withRuntimeReadTiming(
			async () => {
				await withRuntimeReadTiming(
					async () => {
						inherited = held.then(() => startRuntimeReadTiming("connect")());
						await measureRuntimeReadTiming("guard", async () => {
							clock = 3;
						});
					},
					(stages) => {
						inner = stages;
					},
				);
				await measureRuntimeReadTiming("guard", async () => {
					clock = 7;
				});
			},
			(stages) => {
				outer = stages;
			},
		);
		now.mockClear();
		release();
		await inherited;
		expect(now).not.toHaveBeenCalled();
		expect(inner.guard).toEqual({ count: 1, totalMs: 3, maxMs: 3 });
		expect(outer.guard).toEqual({ count: 1, totalMs: 4, maxMs: 4 });
		expect(inner.connect.count).toBe(0);
		expect(outer.connect.count).toBe(0);
	});
});
