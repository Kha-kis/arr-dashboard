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

	beforeEach(() => {
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
				// biome-ignore lint/suspicious/noExplicitAny: test fixture
			} as any,
		};

		getHuntingScheduler().initialize(mockApp as FastifyInstance);
	});

	afterEach(() => {
		getHuntingScheduler().stop();
		warnSpy.mockRestore();
		infoSpy.mockRestore();
		errorSpy.mockRestore();
		vi.clearAllMocks();
		// Drop any residual in-flight promise from a prior test before the next
		// runs (the scheduler is a singleton across tests).
		// biome-ignore lint/suspicious/noExplicitAny: reach into private state for test isolation
		(getHuntingScheduler() as any).inFlightTick = null;
		// biome-ignore lint/suspicious/noExplicitAny: reach into private state for test isolation
		(getHuntingScheduler() as any).skippedTicksWhileBusy = 0;
	});

	it("skips a second tick while the first is still in flight", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: access private members under test
		const scheduler = getHuntingScheduler() as any;

		// Make processScheduledHunts hang on a controllable deferred so we can
		// observe a second runTickIfIdle() call while the first is mid-flight.
		const firstTick = defer<void>();
		const tickSpy = vi
			.spyOn(scheduler, "processScheduledHunts")
			.mockImplementation(() => firstTick.promise);

		// First tick fires and is captured as inFlightTick.
		scheduler.runTickIfIdle();
		expect(tickSpy).toHaveBeenCalledTimes(1);
		expect(scheduler.inFlightTick).not.toBeNull();

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

		// Release the in-flight tick and let microtasks settle.
		firstTick.resolve();
		await scheduler.inFlightTick;
	});

	it("resumes normal cadence after the busy tick completes", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: access private members under test
		const scheduler = getHuntingScheduler() as any;

		const firstTick = defer<void>();
		const tickSpy = vi
			.spyOn(scheduler, "processScheduledHunts")
			.mockImplementationOnce(() => firstTick.promise)
			.mockImplementationOnce(() => Promise.resolve());

		scheduler.runTickIfIdle();
		scheduler.runTickIfIdle(); // skipped
		expect(tickSpy).toHaveBeenCalledTimes(1);

		firstTick.resolve();
		await scheduler.inFlightTick;

		// After completion the recovery log fires summarizing skipped ticks.
		expect(infoSpy).toHaveBeenCalledWith(
			{ skippedSinceLastRun: 1 },
			"Hunt scheduler tick completed; resuming normal cadence",
		);
		// inFlightTick is cleared and a subsequent call runs a real tick.
		expect(scheduler.inFlightTick).toBeNull();

		scheduler.runTickIfIdle();
		expect(tickSpy).toHaveBeenCalledTimes(2);
		await scheduler.inFlightTick;
	});

	it("does not log skip warnings when ticks fit inside the cadence", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: access private members under test
		const scheduler = getHuntingScheduler() as any;

		const tickSpy = vi.spyOn(scheduler, "processScheduledHunts").mockResolvedValue(undefined);

		scheduler.runTickIfIdle();
		await scheduler.inFlightTick;
		scheduler.runTickIfIdle();
		await scheduler.inFlightTick;

		expect(tickSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).not.toHaveBeenCalled();
		// No recovery info-log fires because no ticks were skipped.
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ skippedSinceLastRun: expect.any(Number) }),
			expect.stringContaining("resuming normal cadence"),
		);
	});

	it("clears in-flight state even if the tick throws", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: access private members under test
		const scheduler = getHuntingScheduler() as any;

		vi.spyOn(scheduler, "processScheduledHunts").mockRejectedValueOnce(
			new Error("simulated tick failure"),
		);

		scheduler.runTickIfIdle();
		await scheduler.inFlightTick;

		// inFlightTick must clear so the next tick is not permanently blocked.
		expect(scheduler.inFlightTick).toBeNull();
		// Note: processScheduledHunts() rejection is caught inside the inner
		// tick() method (not surfaced to trackTick), so the outer error log is
		// not expected here. The contract this test pins is that the in-flight
		// flag clears regardless of tick outcome.
	});
});
