import { describe, expect, it, vi } from "vitest";
import { type PrewarmInstance, prewarmAllSequential, prewarmInstance } from "../cache-prewarm.js";

/** Silent logger — tests assert on call counts, not message content. */
function makeLogger() {
	return { info: vi.fn(), warn: vi.fn() };
}

const inst = (id: string, label = id): PrewarmInstance => ({ id, label });

describe("prewarmInstance", () => {
	it("invokes getCachedAllTorrents for the instance and logs success", async () => {
		const getCachedAllTorrents = vi.fn().mockResolvedValue([{ hash: "a" }, { hash: "b" }]);
		const createClient = vi.fn().mockReturnValue({});
		const logger = makeLogger();
		await prewarmInstance(inst("qui-1"), {
			createClient,
			getCachedAllTorrents,
			timeoutMs: 1000,
			logger,
		});
		expect(getCachedAllTorrents).toHaveBeenCalledWith("qui-1", expect.anything());
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
		// Torrent count is read off the resolved value.
		const [logArgs] = logger.info.mock.calls[0] as [{ torrentCount: number }];
		expect(logArgs.torrentCount).toBe(2);
	});

	it("logs a warning instead of throwing when the fetch rejects", async () => {
		const getCachedAllTorrents = vi.fn().mockRejectedValue(new Error("qui unreachable"));
		const logger = makeLogger();
		// Must not throw — failure is logged so the surrounding loop
		// can move on to the next instance.
		await expect(
			prewarmInstance(inst("qui-1"), {
				createClient: () => ({}) as never,
				getCachedAllTorrents,
				timeoutMs: 1000,
				logger,
			}),
		).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [logArgs] = logger.warn.mock.calls[0] as [{ err: Error }];
		expect(logArgs.err.message).toBe("qui unreachable");
	});

	it("times out when the fetch outlives the budget — counts as a per-instance failure", async () => {
		// A fetch that never resolves stands in for a hung qui.
		const getCachedAllTorrents = vi.fn().mockImplementation(() => new Promise(() => {}));
		const logger = makeLogger();
		// Inject a synchronous timer so the timeout fires immediately;
		// avoids real-world wall-clock delays in the test.
		let timerCb: (() => void) | null = null;
		const setTimer = vi.fn((cb: () => void) => {
			timerCb = cb;
			return { unref: vi.fn() };
		});
		const clearTimer = vi.fn();
		const fetchPromise = prewarmInstance(inst("qui-1"), {
			createClient: () => ({}) as never,
			getCachedAllTorrents,
			timeoutMs: 50,
			logger,
			setTimer,
			clearTimer,
		});
		// Fire the injected timer to simulate the timeout window
		// elapsing without the fetch resolving.
		expect(timerCb).not.toBeNull();
		timerCb!();
		await fetchPromise;
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [logArgs] = logger.warn.mock.calls[0] as [{ err: Error }];
		expect(logArgs.err.message).toMatch(/timed out/);
	});

	it("clears the timeout timer on success — no dangling handles", async () => {
		const getCachedAllTorrents = vi.fn().mockResolvedValue([]);
		const setTimer = vi.fn().mockReturnValue({ unref: vi.fn() });
		const clearTimer = vi.fn();
		await prewarmInstance(inst("qui-1"), {
			createClient: () => ({}) as never,
			getCachedAllTorrents,
			timeoutMs: 1000,
			logger: makeLogger(),
			setTimer,
			clearTimer,
		});
		expect(clearTimer).toHaveBeenCalledTimes(1);
	});
});

describe("prewarmAllSequential", () => {
	it("walks instances strictly sequentially — no overlap in pre-warm calls", async () => {
		// Track concurrency by checking whether prewarmOne ever has
		// more than one outstanding invocation at a time.
		let inFlight = 0;
		let maxInFlight = 0;
		const completionOrder: string[] = [];
		const prewarmOne = vi.fn(async (instance: PrewarmInstance) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Yield so the event loop has a chance to interleave —
			// proves that even with awaits, sequential ordering holds.
			await new Promise((r) => setTimeout(r, 5));
			completionOrder.push(instance.id);
			inFlight--;
		});
		const logger = makeLogger();
		await prewarmAllSequential([inst("a"), inst("b"), inst("c")], {
			prewarmOne,
			isCancelled: () => false,
			logger,
		});
		expect(prewarmOne).toHaveBeenCalledTimes(3);
		// THE LOAD-BEARING ASSERTION: peak concurrency is exactly one.
		// If this ever fails it means someone switched to Promise.all and
		// broke the OOM-safety property — see the doc comment in
		// `prewarmAllSequential`.
		expect(maxInFlight).toBe(1);
		expect(completionOrder).toEqual(["a", "b", "c"]);
	});

	it("stops calling prewarmOne the moment isCancelled flips to true", async () => {
		let cancelled = false;
		const prewarmOne = vi.fn(async (instance: PrewarmInstance) => {
			// Cancel after the first instance completes so the second never starts.
			if (instance.id === "a") cancelled = true;
		});
		await prewarmAllSequential([inst("a"), inst("b"), inst("c")], {
			prewarmOne,
			isCancelled: () => cancelled,
			logger: makeLogger(),
		});
		// Only "a" should have been pre-warmed. Cancellation prevents
		// "b" and "c" from being started.
		expect(prewarmOne).toHaveBeenCalledTimes(1);
		expect((prewarmOne.mock.calls[0]?.[0] as PrewarmInstance).id).toBe("a");
	});

	it("logs a 'skipping' message and does nothing when no instances are configured", async () => {
		const prewarmOne = vi.fn();
		const logger = makeLogger();
		await prewarmAllSequential([], {
			prewarmOne,
			isCancelled: () => false,
			logger,
		});
		expect(prewarmOne).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledTimes(1);
		const [msg] = logger.info.mock.calls[0] as [string];
		expect(msg).toMatch(/no enabled qui instances/);
	});

	it("does not let one failed instance abort the rest of the chain", async () => {
		// Even though prewarmOne can throw, the loop should not — the
		// caller wraps it inside prewarmInstance which already
		// swallows. Simulate that by having prewarmOne resolve normally
		// even for the "broken" instance.
		const seen: string[] = [];
		const prewarmOne = vi.fn(async (instance: PrewarmInstance) => {
			seen.push(instance.id);
			// No throw — matches prewarmInstance's never-throws contract.
		});
		await prewarmAllSequential([inst("a"), inst("broken"), inst("c")], {
			prewarmOne,
			isCancelled: () => false,
			logger: makeLogger(),
		});
		expect(seen).toEqual(["a", "broken", "c"]);
	});
});
