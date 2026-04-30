/**
 * Tests for the per-rule concurrency lock.
 *
 * The lock's whole job is preventing two concurrent runs of the same rule —
 * which is exactly what these tests pin: a second invocation arriving while
 * the first is still in flight must be rejected with `skipped`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearInFlightForTesting, runRuleWithLock } from "../run-with-lock.js";

describe("runRuleWithLock", () => {
	afterEach(() => {
		_clearInFlightForTesting();
	});

	it("ran path: returns the function's result wrapped with status='ran'", async () => {
		const fn = vi.fn().mockResolvedValue({ message: "ok", count: 3 });
		const result = await runRuleWithLock("rule-1", fn);
		expect(result).toEqual({ status: "ran", result: { message: "ok", count: 3 } });
		expect(fn).toHaveBeenCalledOnce();
	});

	it("skips a second concurrent call for the same rule id", async () => {
		// First call hangs forever (controlled via promise resolver) — the
		// second call must arrive while the first is still in flight.
		let resolveFirst: (value: string) => void = () => {};
		const firstPromise = new Promise<string>((r) => {
			resolveFirst = r;
		});

		const fnFirst = vi.fn().mockImplementation(() => firstPromise);
		const fnSecond = vi.fn().mockResolvedValue("second");

		const inflight = runRuleWithLock("rule-1", fnFirst);
		// Yield a tick so the lock acquisition happens
		await Promise.resolve();

		const skipped = await runRuleWithLock("rule-1", fnSecond);
		expect(skipped).toEqual({ status: "skipped", reason: "already-running" });
		expect(fnSecond).not.toHaveBeenCalled();

		// Clean up the in-flight call so the test doesn't leak state
		resolveFirst("first");
		await inflight;
	});

	it("releases the lock after the first call completes — second call afterwards runs", async () => {
		const fn1 = vi.fn().mockResolvedValue("first");
		await runRuleWithLock("rule-1", fn1);

		const fn2 = vi.fn().mockResolvedValue("second");
		const result = await runRuleWithLock("rule-1", fn2);
		expect(result).toEqual({ status: "ran", result: "second" });
		expect(fn2).toHaveBeenCalledOnce();
	});

	it("releases the lock even when fn throws", async () => {
		const fn1 = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(runRuleWithLock("rule-1", fn1)).rejects.toThrow("boom");

		// Lock must be released so subsequent calls can run.
		const fn2 = vi.fn().mockResolvedValue("recovered");
		const result = await runRuleWithLock("rule-1", fn2);
		expect(result).toEqual({ status: "ran", result: "recovered" });
	});

	it("different rule ids run concurrently without blocking each other", async () => {
		// Both first calls hang. We're proving rule-1's lock doesn't block rule-2.
		let resolveA: (v: string) => void = () => {};
		let resolveB: (v: string) => void = () => {};
		const aPromise = new Promise<string>((r) => {
			resolveA = r;
		});
		const bPromise = new Promise<string>((r) => {
			resolveB = r;
		});

		const aRun = runRuleWithLock("rule-a", () => aPromise);
		const bRun = runRuleWithLock("rule-b", () => bPromise);

		// Both should be in-flight, neither skipped.
		await Promise.resolve();

		resolveA("a-done");
		resolveB("b-done");

		const [aResult, bResult] = await Promise.all([aRun, bRun]);
		expect(aResult).toEqual({ status: "ran", result: "a-done" });
		expect(bResult).toEqual({ status: "ran", result: "b-done" });
	});
});
