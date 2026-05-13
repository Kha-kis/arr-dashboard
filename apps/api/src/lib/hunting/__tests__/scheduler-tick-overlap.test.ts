/**
 * Tests for HuntingScheduler tick-overlap protection (issue #457).
 *
 * Confirms that runTickIfIdle() suppresses overlapping ticks while a prior
 * tick is in flight, and that the scheduler resumes normal cadence once the
 * busy tick completes. Without this guard a slow ARR service (e.g., 1.5M-
 * track Lidarr) would let setInterval stack multiple paginator-heavy rounds
 * on top of each other — the root cause of the 16 concurrent paginators
 * observed in the #427 heap snapshot.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loggers } from "../../logger.js";
import { getHuntingScheduler } from "../scheduler.js";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("HuntingScheduler - tick overlap protection (#457)", () => {
	// scheduler.ts uses the module-level `loggers.hunting` (not app.log), so
	// the assertions need to spy on that child logger directly.
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let infoSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let mockApp: Partial<FastifyInstance>;

	beforeEach(async () => {
		warnSpy = vi.spyOn(loggers.hunting, "warn").mockImplementation(() => undefined);
		infoSpy = vi.spyOn(loggers.hunting, "info").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(loggers.hunting, "error").mockImplementation(() => undefined);

		mockApp = {
			prisma: {
				huntConfig: {
					findMany: vi.fn().mockResolvedValue([]),
					update: vi.fn().mockResolvedValue({}),
				},
				huntLog: {
					findMany: vi.fn().mockResolvedValue([]),
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
					create: vi.fn(),
					update: vi.fn(),
				},
			} as any,
		};

		getHuntingScheduler().initialize(mockApp as FastifyInstance);
		// initialize() fires cleanupStuckHunts() as a detached promise. Drain
		// the microtask queue so that cleanup settles against this test's own
		// mocks (which resolve `[]` synchronously) before the test body runs.
		// Without this, the cleanup can interleave with the next test's
		// beforeEach and pollute mock call counts non-deterministically.
		await Promise.resolve();
		await Promise.resolve();
	});

	afterEach(() => {
		getHuntingScheduler().stop();
		warnSpy.mockRestore();
		infoSpy.mockRestore();
		errorSpy.mockRestore();
		vi.clearAllMocks();
		// Drop any residual in-flight promise from a prior test before the next
		// runs (the scheduler is a singleton across tests).
		(getHuntingScheduler() as any).inFlightTick = null;
		(getHuntingScheduler() as any).skippedTicksWhileBusy = 0;
	});

	it("skips a second tick while the first is still in flight", async () => {
		const scheduler = getHuntingScheduler() as any;

		// Make processScheduledHunts hang on a controllable deferred so we can
		// observe a second runTickIfIdle() call while the first is mid-flight.
		const firstTick = defer<void>();
		const tickSpy = vi
			.spyOn(scheduler, "processScheduledHunts")
			.mockImplementation(() => firstTick.promise);

		// First tick fires and is captured as inFlightTick. Bind a local
		// reference so the cleanup `await` at the end of the test doesn't
		// re-read `scheduler.inFlightTick` after the IIFE's finally has
		// already nulled it — the read happens-before the await yields, so
		// `await null` would be a no-op without it.
		scheduler.runTickIfIdle();
		const inFlight = scheduler.inFlightTick as Promise<void>;
		expect(tickSpy).toHaveBeenCalledTimes(1);
		expect(inFlight).not.toBeNull();

		// Second tick fires before the first resolves — must be skipped, not
		// chained, queued, or run in parallel.
		scheduler.runTickIfIdle();
		expect(tickSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			{ skippedSinceLastRun: 1 },
			"Skipping hunt scheduler tick — prior tick still in flight",
		);

		// And a third — the warning counter accumulates so operators can see
		// how badly the cadence is slipping.
		scheduler.runTickIfIdle();
		expect(tickSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenLastCalledWith(
			{ skippedSinceLastRun: 2 },
			"Skipping hunt scheduler tick — prior tick still in flight",
		);

		// Release the in-flight tick and wait for the captured promise.
		firstTick.resolve();
		await inFlight;
	});

	it("resumes normal cadence after the busy tick completes", async () => {
		const scheduler = getHuntingScheduler() as any;

		const firstTick = defer<void>();
		const tickSpy = vi
			.spyOn(scheduler, "processScheduledHunts")
			.mockImplementationOnce(() => firstTick.promise)
			.mockImplementationOnce(() => Promise.resolve());

		scheduler.runTickIfIdle();
		const firstInFlight = scheduler.inFlightTick as Promise<void>;
		scheduler.runTickIfIdle(); // skipped
		expect(tickSpy).toHaveBeenCalledTimes(1);

		firstTick.resolve();
		await firstInFlight;

		// After completion the recovery log fires summarizing skipped ticks.
		expect(infoSpy).toHaveBeenCalledWith(
			{ skippedSinceLastRun: 1 },
			"Hunt scheduler tick completed; resuming normal cadence",
		);
		// inFlightTick is cleared and a subsequent call runs a real tick.
		expect(scheduler.inFlightTick).toBeNull();

		scheduler.runTickIfIdle();
		const secondInFlight = scheduler.inFlightTick as Promise<void>;
		expect(tickSpy).toHaveBeenCalledTimes(2);
		await secondInFlight;
	});

	it("does not log skip warnings when ticks fit inside the cadence", async () => {
		const scheduler = getHuntingScheduler() as any;

		const tickSpy = vi.spyOn(scheduler, "processScheduledHunts").mockResolvedValue(undefined);

		scheduler.runTickIfIdle();
		const firstInFlight = scheduler.inFlightTick as Promise<void>;
		await firstInFlight;
		scheduler.runTickIfIdle();
		const secondInFlight = scheduler.inFlightTick as Promise<void>;
		await secondInFlight;

		expect(tickSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).not.toHaveBeenCalled();
		// No recovery info-log fires because no ticks were skipped.
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ skippedSinceLastRun: expect.any(Number) }),
			expect.stringContaining("resuming normal cadence"),
		);
	});

	it("clears in-flight state even if the tick throws", async () => {
		const scheduler = getHuntingScheduler() as any;

		vi.spyOn(scheduler, "processScheduledHunts").mockRejectedValueOnce(
			new Error("simulated tick failure"),
		);

		scheduler.runTickIfIdle();
		const inFlight = scheduler.inFlightTick as Promise<void>;
		await inFlight;

		// inFlightTick must clear so the next tick is not permanently blocked.
		expect(scheduler.inFlightTick).toBeNull();
		// Note: processScheduledHunts() rejection is caught inside the inner
		// tick() method (not surfaced to trackTick), so the outer error log is
		// not expected here. The contract this test pins is that the in-flight
		// flag clears regardless of tick outcome.
	});

	it("start() wires setInterval to runTickIfIdle and skips overlapping fires", async () => {
		// Integration test: exercise the full start() → setInterval →
		// runTickIfIdle → trackTick chain with fake timers, not just
		// runTickIfIdle in isolation. Pins that the production wiring matches
		// the unit-level guarantees.
		vi.useFakeTimers();
		try {
			const scheduler = getHuntingScheduler() as any;

			const firstTick = defer<void>();
			const tickSpy = vi
				.spyOn(scheduler, "processScheduledHunts")
				.mockImplementationOnce(() => firstTick.promise)
				.mockImplementation(() => Promise.resolve());

			// Track that trackTick is invoked exactly once per real tick — this
			// is what keeps SchedulerRegistry stats accurate.
			const trackTickSpy = vi.fn((fn: () => Promise<void>) => fn());
			scheduler.setTrackTick(trackTickSpy);

			scheduler.start(mockApp as FastifyInstance);

			// Before any time advances, no tick has fired.
			expect(tickSpy).toHaveBeenCalledTimes(0);

			// Advance one cadence (60s). setInterval fires runTickIfIdle, which
			// invokes trackTick(() => tick()).
			await vi.advanceTimersByTimeAsync(60 * 1000);
			expect(tickSpy).toHaveBeenCalledTimes(1);
			expect(trackTickSpy).toHaveBeenCalledTimes(1);

			// The first tick is still hanging on firstTick.promise. Advance
			// three more cadences (3 × 60s). Each setInterval fire must be
			// suppressed because inFlightTick is still set.
			await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
			expect(tickSpy).toHaveBeenCalledTimes(1);
			expect(trackTickSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(3);
			expect(warnSpy).toHaveBeenLastCalledWith(
				{ skippedSinceLastRun: 3 },
				"Skipping hunt scheduler tick — prior tick still in flight",
			);

			// Resolve the slow tick. Recovery log fires and the next cadence
			// runs a normal tick.
			firstTick.resolve();
			await vi.advanceTimersByTimeAsync(0); // drain microtasks
			expect(infoSpy).toHaveBeenCalledWith(
				{ skippedSinceLastRun: 3 },
				"Hunt scheduler tick completed; resuming normal cadence",
			);

			await vi.advanceTimersByTimeAsync(60 * 1000);
			expect(tickSpy).toHaveBeenCalledTimes(2);
			expect(trackTickSpy).toHaveBeenCalledTimes(2);
		} finally {
			getHuntingScheduler().stop();
			vi.useRealTimers();
		}
	});

	it("triggerManualHunt does not engage the in-flight tick guard", () => {
		// Regression guard: my fix should not make manual hunts wait on
		// scheduled-tick state, nor vice versa. The reviewer confirmed manual
		// hunts call runHunt() directly, bypassing runTickIfIdle — this pins
		// that contract so a future refactor can't accidentally route manual
		// hunts through the guard and break the user-action latency.
		const scheduler = getHuntingScheduler() as any;

		// Simulate a slow scheduled tick in-flight.
		scheduler.inFlightTick = new Promise<void>(() => {
			// never resolves
		});

		// Spy on runHunt to confirm it gets called despite inFlightTick being
		// set — manual hunts must not be blocked by the scheduler guard.
		const runHuntSpy = vi.spyOn(scheduler, "runHunt").mockImplementation(() => Promise.resolve());

		const result = scheduler.triggerManualHunt("inst-1", "missing");

		expect(result.queued).toBe(true);
		expect(runHuntSpy).toHaveBeenCalledTimes(1);
		expect(runHuntSpy).toHaveBeenCalledWith("inst-1", "missing", true);

		// Manual hunt must NOT touch the scheduled-tick guard.
		expect(scheduler.inFlightTick).not.toBeNull();
		expect(scheduler.skippedTicksWhileBusy).toBe(0);
	});
});
