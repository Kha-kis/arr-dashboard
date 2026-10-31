/**
 * SchedulerRegistry unit tests.
 *
 * Uses vitest fake timers + an injected Clock so success/failure/duration
 * tracking is deterministic without relying on real-time wall clocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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

	describe("observeAlreadyAdmitted", () => {
		it("executes its callback once without applying the admission wrapper", async () => {
			const registry = new SchedulerRegistry(undefined, async () => {
				throw new Error("Admission wrapper was applied twice");
			});
			registry.register(BASE_DEFINITION);
			let calls = 0;
			await expect(
				registry.observeAlreadyAdmitted("example-job", async () => ++calls),
			).resolves.toBe(1);
			expect(calls).toBe(1);
			expect(registry.getStatus("example-job")).toMatchObject({
				state: "idle",
				totalRuns: 1,
				totalFailures: 0,
			});
			await expect(registry.track("example-job", async () => ++calls)).rejects.toThrow(
				"Admission wrapper was applied twice",
			);
			expect(calls).toBe(1);
		});

		it("rejects unknown and busy serial jobs before starting the callback", async () => {
			const registry = new SchedulerRegistry();
			registry.register({ ...BASE_DEFINITION, concurrency: "serial" });
			let rejectedCalls = 0;
			const callback = async () => ++rejectedCalls;
			await expect(registry.observeAlreadyAdmitted("missing", callback)).rejects.toBeInstanceOf(
				UnknownJobError,
			);
			const gate = deferred<void>();
			const held = registry.observeAlreadyAdmitted("example-job", () => gate.promise);
			try {
				await expect(
					registry.observeAlreadyAdmitted("example-job", callback),
				).rejects.toBeInstanceOf(SerialJobBusyError);
				await expect(registry.track("example-job", callback)).rejects.toBeInstanceOf(
					SerialJobBusyError,
				);
				expect(rejectedCalls).toBe(0);
				expect(registry.getStatus("example-job")?.state).toBe("running");
			} finally {
				gate.resolve();
				await held;
			}
		});

		for (const concurrency of ["parallel", "per-instance"] as const) {
			it.each([false, true])(
				`keeps overlapping ${concurrency} work running through disable until settlement (failure=%s)`,
				async (fails) => {
					const registry = new SchedulerRegistry();
					registry.register({ ...BASE_DEFINITION, concurrency });
					const gate = deferred<void>();
					const error = new Error("Accepted operation failed");
					const held = registry.observeAlreadyAdmitted("example-job", async () => {
						await gate.promise;
						if (fails) throw error;
						return "done";
					});
					registry.markDisabled("example-job", "disabled during accepted work");
					try {
						await registry.track("example-job", async () => "quick");
						expect(registry.getStatus("example-job")).toMatchObject({
							state: "running",
							disabled: true,
							totalRuns: 1,
						});
					} finally {
						gate.resolve();
						if (fails) await expect(held).rejects.toBe(error);
						else await expect(held).resolves.toBe("done");
					}
					expect(registry.getStatus("example-job")).toMatchObject({
						state: "disabled",
						totalRuns: 2,
						totalFailures: fails ? 1 : 0,
						consecutiveFailures: fails ? 1 : 0,
						lastError: fails ? "Accepted operation failed" : null,
					});
				},
			);
		}

		it("rethrows a maintenance conflict without recording a skipped callback as success", async () => {
			const registry = new SchedulerRegistry(
				scriptedClock([
					new Date("2026-01-01T00:00:00.000Z"),
					new Date("2026-01-01T00:00:01.000Z"),
					new Date("2026-01-01T00:00:02.000Z"),
					new Date("2026-01-01T00:00:03.000Z"),
					new Date("2026-01-01T00:00:04.000Z"),
				]),
				withCleanupOperationGuard,
				(error) => error instanceof CleanupMaintenanceConflictError,
			);
			registry.register(BASE_DEFINITION);
			await expect(
				registry.track("example-job", async () => {
					throw new Error("Prior failure");
				}),
			).rejects.toThrow("Prior failure");
			const prior = registry.getStatus("example-job");
			const conflict = new CleanupMaintenanceConflictError();
			let calls = 0;
			await expect(
				registry.observeAlreadyAdmitted("example-job", async () => {
					calls++;
					throw conflict;
				}),
			).rejects.toBe(conflict);
			expect(calls).toBe(1);
			// The callback entered, so its start is visible. A skipped conflict
			// preserves completed health history without rolling back concurrent starts.
			expect(registry.getStatus("example-job")).toEqual({
				...prior,
				lastStartedAt: "2026-01-01T00:00:02.000Z",
			});
			await registry.observeAlreadyAdmitted("example-job", async () => "recovered");
			expect(registry.getStatus("example-job")).toMatchObject({
				state: "idle",
				totalRuns: 2,
				totalFailures: 1,
				consecutiveFailures: 0,
				lastError: null,
			});
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

	it("keeps the configured operation wrapper active for the complete tick", async () => {
		const registry = new SchedulerRegistry(undefined, withCleanupOperationGuard);
		registry.register(BASE_DEFINITION);

		let releaseTick!: () => void;
		const tickStarted = new Promise<void>((resolve) => {
			void registry.track(
				"example-job",
				() =>
					new Promise<void>((release) => {
						resolve();
						releaseTick = release;
					}),
			);
		});
		await tickStarted;

		const maintenanceWork = vi.fn();
		await expect(withCleanupMaintenanceGuard(async () => maintenanceWork())).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(maintenanceWork).not.toHaveBeenCalled();

		releaseTick();
		await vi.waitFor(() => expect(registry.getStatus("example-job")?.state).toBe("idle"));
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});

	it("treats a maintenance-blocked tick as skipped without changing health history", async () => {
		const registry = new SchedulerRegistry(
			undefined,
			withCleanupOperationGuard,
			(error) => error instanceof CleanupMaintenanceConflictError,
		);
		registry.register(BASE_DEFINITION);
		let releaseMaintenance!: () => void;
		const maintenanceStarted = new Promise<void>((resolve) => {
			void withCleanupMaintenanceGuard(
				() =>
					new Promise<void>((release) => {
						resolve();
						releaseMaintenance = release;
					}),
			);
		});
		await maintenanceStarted;
		const tick = vi.fn(async () => "unexpected");

		await expect(registry.track("example-job", tick)).resolves.toBeUndefined();
		expect(tick).not.toHaveBeenCalled();
		expect(registry.getStatus("example-job")).toMatchObject({
			state: "idle",
			lastStartedAt: null,
			lastFinishedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastError: null,
			consecutiveFailures: 0,
			totalRuns: 0,
			totalFailures: 0,
		});

		releaseMaintenance();
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

	describe.each(["parallel", "per-instance"] as const)("overlapping %s runs", (concurrency) => {
		it.each([
			[false, false],
			[false, true],
			[true, false],
			[true, true],
		])(
			"keeps running after the quick run settles (held failure=%s, quick failure=%s)",
			async (heldFails, quickFails) => {
				const registry = new SchedulerRegistry();
				registry.register({ ...BASE_DEFINITION, concurrency });
				const gate = deferred<void>();
				const held = registry.track("example-job", async () => {
					await gate.promise;
					if (heldFails) throw new Error("held failure");
					return "held result";
				});
				// Observe rejection before releasing the gate, including assertion-failure cleanup.
				const heldOutcome = held.then(
					(value) => value,
					(error: Error) => error.message,
				);
				try {
					vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
					const quick = registry.track("example-job", async () => {
						if (quickFails) throw new Error("quick failure");
						return "quick result";
					});
					if (quickFails) await expect(quick).rejects.toThrow("quick failure");
					else await expect(quick).resolves.toBe("quick result");
					expect(registry.getStatus("example-job")).toMatchObject({
						state: "running",
						totalRuns: 1,
						totalFailures: quickFails ? 1 : 0,
						lastStartedAt: "2026-01-01T00:00:01.000Z",
					});
					vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
					gate.resolve();
					await expect(heldOutcome).resolves.toBe(heldFails ? "held failure" : "held result");
					expect(registry.getStatus("example-job")).toMatchObject({
						state: "idle",
						totalRuns: 2,
						totalFailures: Number(heldFails) + Number(quickFails),
						consecutiveFailures: heldFails ? (quickFails ? 2 : 1) : 0,
						lastDurationMs: 3000,
						lastStartedAt: "2026-01-01T00:00:01.000Z",
						lastFinishedAt: "2026-01-01T00:00:03.000Z",
						lastError: heldFails ? "held failure" : null,
					});
				} finally {
					gate.resolve();
					await heldOutcome;
				}
			},
		);
	});

	it.each([false, true])(
		"retains serial exclusion across disable/re-enable (reenable=%s)",
		async (reenable) => {
			const registry = new SchedulerRegistry();
			registry.register({ ...BASE_DEFINITION, concurrency: "serial" });
			const gate = deferred<void>();
			const held = registry.track("example-job", () => gate.promise);
			try {
				registry.markDisabled("example-job", "disabled for future ticks");
				if (reenable) registry.markEnabled("example-job");
				expect(registry.getStatus("example-job")).toMatchObject({
					state: "running",
					disabled: !reenable,
				});
				let admitted = false;
				await expect(
					registry.track("example-job", async () => {
						admitted = true;
					}),
				).rejects.toBeInstanceOf(SerialJobBusyError);
				expect(admitted).toBe(false);
				gate.resolve();
				await held;
				expect(registry.getStatus("example-job")).toMatchObject({
					state: reenable ? "idle" : "disabled",
					totalRuns: 1,
				});
				registry.markEnabled("example-job");
				await expect(registry.track("example-job", async () => "next")).resolves.toBe("next");
			} finally {
				gate.resolve();
				await held;
			}
		},
	);

	it("uses active invocation accounting after a definition is re-registered as serial", async () => {
		const registry = new SchedulerRegistry();
		registry.register({ ...BASE_DEFINITION, concurrency: "parallel" });
		const gate = deferred<void>();
		const held = registry.track("example-job", () => gate.promise);
		try {
			await registry.track("example-job", async () => "quick");
			registry.register({ ...BASE_DEFINITION, concurrency: "serial", label: "Updated" });
			await expect(registry.track("example-job", async () => "forbidden")).rejects.toBeInstanceOf(
				SerialJobBusyError,
			);
			expect(registry.getStatus("example-job")).toMatchObject({
				state: "running",
				label: "Updated",
				totalRuns: 1,
			});
		} finally {
			gate.resolve();
			await held;
		}
		await expect(registry.track("example-job", async () => "next")).resolves.toBe("next");
	});

	it("keeps another job's serial admission independent of a held job", async () => {
		const registry = new SchedulerRegistry();
		registry.register({ ...BASE_DEFINITION, concurrency: "serial" });
		registry.register({ ...BASE_DEFINITION, id: "other-job", concurrency: "serial" });
		const gate = deferred<void>();
		const held = registry.track("example-job", () => gate.promise);
		try {
			await expect(registry.track("other-job", async () => "other")).resolves.toBe("other");
			expect(registry.getStatus("example-job")?.state).toBe("running");
			expect(registry.getStatus("other-job")).toMatchObject({ state: "idle", totalRuns: 1 });
		} finally {
			gate.resolve();
			await held;
		}
	});

	it.each([false, true])(
		"does not restore stale history or state when a delayed maintenance skip settles (held active=%s)",
		async (heldActive) => {
			const skip = deferred<void>();
			const work = deferred<void>();
			let attempts = 0;
			const registry = new SchedulerRegistry(
				undefined,
				async (fn) => {
					attempts += 1;
					if (attempts === 2) {
						await skip.promise;
						throw new CleanupMaintenanceConflictError();
					}
					return await fn();
				},
				(error) => error instanceof CleanupMaintenanceConflictError,
			);
			registry.register({ ...BASE_DEFINITION, concurrency: "parallel" });
			const held = registry.track("example-job", () => work.promise);
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
			let skippedBodyRan = false;
			const skipped = registry.track("example-job", async () => {
				skippedBodyRan = true;
			});
			try {
				vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
				await registry.track("example-job", async () => "newer accepted run");
				if (!heldActive) {
					work.resolve();
					await held;
				}
				skip.resolve();
				await expect(skipped).resolves.toBeUndefined();
				expect(skippedBodyRan).toBe(false);
				expect(registry.getStatus("example-job")).toMatchObject({
					state: heldActive ? "running" : "idle",
					lastStartedAt: "2026-01-01T00:00:02.000Z",
					totalRuns: heldActive ? 1 : 2,
					totalFailures: 0,
					lastFinishedAt: "2026-01-01T00:00:02.000Z",
					lastSuccessAt: "2026-01-01T00:00:02.000Z",
					lastError: null,
				});
			} finally {
				skip.resolve();
				work.resolve();
				await Promise.all([held, skipped]);
			}
			expect(registry.getStatus("example-job")?.state).toBe("idle");
		},
	);

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
