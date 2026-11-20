import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFinalizerLoopObservationBuffer,
	finalizerLoopDiagnosticsFrom,
	readFinalizerLoopDiagnostics,
	readFinalizerLoopObservation,
	sanitizeFinalizerLoopDiagnostics,
	startFinalizerLoopObservation,
} from "./finalizer-loop-observation.js";

describe("bounded finalizer loop observations", () => {
	let clock: bigint;
	beforeEach(() => {
		clock = 1000n;
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		vi.spyOn(process.hrtime, "bigint").mockImplementation(() => clock * 1_000_000n);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	const tick = (gap = 250) => {
		clock += BigInt(gap);
		vi.advanceTimersByTime(250);
	};

	it("distinguishes never started, warming, completed samples and an unfinished long gap", () => {
		const buffer = createFinalizerLoopObservationBuffer();
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		const stop = startFinalizerLoopObservation(buffer);
		expect(readFinalizerLoopObservation(buffer)).toEqual({
			state: "warming",
			sampleCount: 0,
			sampleSpanMs: 0,
			maxCompletedGapMs: 0,
			currentGapMs: 0,
		});
		tick();
		tick();
		clock += 4000n;
		expect(readFinalizerLoopObservation(buffer)).toEqual({
			state: "sampled",
			sampleCount: 2,
			sampleSpanMs: 500,
			maxCompletedGapMs: 250,
			currentGapMs: 4000,
		});
		stop();
	});

	it("retains only the last 64 actual gaps and freezes the unfinished gap before cleanup", () => {
		const buffer = createFinalizerLoopObservationBuffer();
		const stop = startFinalizerLoopObservation(buffer);
		tick(5000);
		for (let index = 0; index < 64; index++) tick();
		clock += 123n;
		stop();
		clock += 9000n;
		expect(readFinalizerLoopObservation(buffer)).toEqual({
			state: "sampled",
			sampleCount: 64,
			sampleSpanMs: 16000,
			maxCompletedGapMs: 250,
			currentGapMs: 123,
		});
		stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a completed long gap before it ages out of the bounded ring", () => {
		const buffer = createFinalizerLoopObservationBuffer();
		const stop = startFinalizerLoopObservation(buffer);
		tick(1250);
		tick(250);
		expect(readFinalizerLoopObservation(buffer)).toEqual({
			state: "sampled",
			sampleCount: 2,
			sampleSpanMs: 1500,
			maxCompletedGapMs: 1250,
			currentGapMs: 0,
		});
		stop();
	});
	it("refuses future start, last-tick and stop stamps even after observation stopped", () => {
		const buffer = createFinalizerLoopObservationBuffer()!;
		const stop = startFinalizerLoopObservation(buffer);
		tick();
		clock += 100n;
		stop();
		clock = 1300n;
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		clock = 999n;
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
	});

	it("refuses the existing eight-byte authority fence without changing any fence byte", () => {
		const fence = new SharedArrayBuffer(8);
		new Int32Array(fence).set([17, 29]);
		const before = [...new Uint8Array(fence)];
		const stop = startFinalizerLoopObservation(fence);
		tick(2000);
		stop();
		expect(readFinalizerLoopObservation(fence)).toEqual({ state: "unavailable" });
		expect([...new Uint8Array(fence)]).toEqual(before);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not trust a buffer byteLength accessor when excluding the authority fence", () => {
		const fence = new SharedArrayBuffer(8);
		const getter = vi.fn(() => 552);
		Object.defineProperty(fence, "byteLength", { get: getter });
		const before = [...new Uint8Array(fence)];
		startFinalizerLoopObservation(fence)();
		expect(readFinalizerLoopObservation(fence)).toEqual({ state: "unavailable" });
		expect([...new Uint8Array(fence)]).toEqual(before);
		expect(getter).not.toHaveBeenCalled();
	});
	it("unrefs its one observation timer so diagnostics do not keep a thread alive", () => {
		const interval = vi.spyOn(globalThis, "setInterval");
		const stop = startFinalizerLoopObservation(createFinalizerLoopObservationBuffer());
		expect(interval).toHaveBeenCalledOnce();
		expect(interval.mock.results[0]?.value.hasRef()).toBe(false);
		stop();
	});

	it.each([undefined, null, {}, new ArrayBuffer(552), new SharedArrayBuffer(16)])(
		"treats absent or malformed storage as unavailable without a timer: %j",
		(buffer) => {
			expect(() => startFinalizerLoopObservation(buffer)()).not.toThrow();
			expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("does not spin on an odd writer sequence and refuses inconsistent header or gap data", () => {
		const buffer = createFinalizerLoopObservationBuffer()!;
		const stop = startFinalizerLoopObservation(buffer);
		const view = new BigInt64Array(buffer);
		Atomics.store(view, 0, 3n);
		const load = vi.spyOn(Atomics, "load");
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		expect(load).toHaveBeenCalledTimes(3);
		load.mockRestore();
		Atomics.store(view, 0, 4n);
		Atomics.store(view, 2, 999n);
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		Atomics.store(view, 2, 1000n);
		Atomics.store(view, 5, -1n);
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		stop();
	});

	it("refuses reads whose sequence changes during every attempt", () => {
		const buffer = createFinalizerLoopObservationBuffer()!;
		const stop = startFinalizerLoopObservation(buffer);
		const realLoad = Atomics.load;
		let sequence = 2n;
		const load = vi.spyOn(Atomics, "load").mockImplementation(((
			view: BigInt64Array,
			index: number,
		) => {
			if (index === 0) {
				sequence += 2n;
				return sequence;
			}
			return realLoad(view, index);
		}) as typeof Atomics.load);
		expect(readFinalizerLoopObservation(buffer)).toEqual({ state: "unavailable" });
		expect(load.mock.calls.filter(([, index]) => index === 0)).toHaveLength(6);
		load.mockRestore();
		stop();
	});

	it("never propagates clock/storage faults and clears its interval after an observation fault", () => {
		const buffer = createFinalizerLoopObservationBuffer();
		const stop = startFinalizerLoopObservation(buffer);
		vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
			throw new Error("private");
		});
		expect(() => vi.advanceTimersByTime(250)).not.toThrow();
		expect(readFinalizerLoopDiagnostics(buffer, buffer)).toEqual({
			parent: { state: "unavailable" },
			worker: { state: "unavailable" },
		});
		expect(() => stop()).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("allocation failure is diagnostic unavailability and never escapes", () => {
		vi.stubGlobal(
			"SharedArrayBuffer",
			class {
				constructor() {
					throw new Error("private");
				}
			},
		);
		expect(createFinalizerLoopObservationBuffer()).toBeUndefined();
	});

	it("uses one monotonic instant for independent parent and worker snapshots", () => {
		const parent = createFinalizerLoopObservationBuffer();
		const stop = startFinalizerLoopObservation(parent);
		tick();
		const observation = readFinalizerLoopDiagnostics(parent, undefined);
		expect(observation).toEqual({
			parent: {
				state: "sampled",
				sampleCount: 1,
				sampleSpanMs: 250,
				maxCompletedGapMs: 250,
				currentGapMs: 0,
			},
			worker: { state: "unavailable" },
		});
		stop();
	});

	it.each([
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		"private",
		{},
	])("refuses malformed numeric values without exporting their contents: %j", (value) => {
		const valid = {
			state: "sampled",
			sampleCount: 2,
			sampleSpanMs: 600,
			maxCompletedGapMs: 350,
			currentGapMs: 12,
		};
		for (const key of ["sampleCount", "sampleSpanMs", "maxCompletedGapMs", "currentGapMs"]) {
			expect(
				sanitizeFinalizerLoopDiagnostics({
					parent: { ...valid, [key]: value },
					worker: { state: "unavailable" },
				}),
			).toEqual({ parent: { state: "unavailable" }, worker: { state: "unavailable" } });
		}
	});

	it("projects only own closed data, refuses getters and drops all private/unknown fields", () => {
		const getter = vi.fn(() => "private");
		const carrier = Object.defineProperty({}, "loopObservation", { get: getter });
		expect(finalizerLoopDiagnosticsFrom(carrier)).toEqual({
			parent: { state: "unavailable" },
			worker: { state: "unavailable" },
		});
		const snapshot = {
			state: "warming",
			sampleCount: 0,
			sampleSpanMs: 0,
			maxCompletedGapMs: 0,
			currentGapMs: 3,
		};
		const pair = { parent: snapshot, worker: { state: "unavailable" } };
		expect(sanitizeFinalizerLoopDiagnostics(pair)).toEqual(pair);
		expect(sanitizeFinalizerLoopDiagnostics({ ...pair, private: "private" })).toEqual({
			parent: { state: "unavailable" },
			worker: { state: "unavailable" },
		});
		expect(
			sanitizeFinalizerLoopDiagnostics({
				parent: Object.defineProperty({ ...snapshot }, "currentGapMs", { get: getter }),
				worker: { state: "unavailable" },
			}),
		).toEqual({ parent: { state: "unavailable" }, worker: { state: "unavailable" } });
		expect(
			sanitizeFinalizerLoopDiagnostics({
				parent: { ...snapshot, private: "private" },
				worker: { state: "unavailable" },
			}),
		).toEqual({ parent: { state: "unavailable" }, worker: { state: "unavailable" } });
		expect(sanitizeFinalizerLoopDiagnostics(Object.create(pair))).toEqual({
			parent: { state: "unavailable" },
			worker: { state: "unavailable" },
		});
		expect(getter).not.toHaveBeenCalled();
	});
});

describe("real independent-thread diagnostic controls, not QA cause reproductions", () => {
	it.each(["exchange", "parent-pause", "worker-pause"] as const)(
		"observes %s and joins the real actor",
		async (mode) => {
			const parentBuffer = createFinalizerLoopObservationBuffer()!;
			const workerBuffer = createFinalizerLoopObservationBuffer()!;
			const stopParent = startFinalizerLoopObservation(parentBuffer);
			const require = createRequire(import.meta.url);
			const worker = new Worker(
				`const {workerData}=require('node:worker_threads');(async()=>{const {register}=await import(workerData.tsx);register();await import(workerData.actor)})().catch(error=>{console.error(error);process.exitCode=1})`,
				{
					eval: true,
					execArgv: [],
					workerData: {
						buffer: workerBuffer,
						tsx: pathToFileURL(require.resolve("tsx/esm/api")).href,
						actor: new URL(
							"./__tests__/fixtures/finalizer-loop-observation-worker.ts",
							import.meta.url,
						).href,
					},
				},
			);
			const messages: Array<{ category: string }> = [];
			let actorError: unknown;
			worker.on("message", (message) => messages.push(message));
			worker.on("error", (error) => {
				actorError = error;
			});
			let exited = false;
			const joined = new Promise<number>((resolve) =>
				worker.once("exit", (code) => {
					exited = true;
					resolve(code);
				}),
			);
			const waitFor = async (condition: () => boolean) => {
				const until = performance.now() + 4000;
				while (!condition() && !actorError && !exited && performance.now() < until) await delay(10);
				expect(actorError).toBeUndefined();
				expect(condition()).toBe(true);
			};
			try {
				await waitFor(() => readFinalizerLoopObservation(workerBuffer).state === "sampled");
				const before = readFinalizerLoopDiagnostics(parentBuffer, workerBuffer);
				if (before.parent.state === "unavailable" || before.worker.state === "unavailable")
					throw new Error("missing real sample");
				if (mode === "parent-pause") {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
					const after = readFinalizerLoopDiagnostics(parentBuffer, workerBuffer);
					if (after.parent.state === "unavailable" || after.worker.state === "unavailable")
						throw new Error("missing paused sample");
					expect(after.parent.currentGapMs).toBeGreaterThanOrEqual(850);
					expect(after.worker.sampleCount).toBeGreaterThan(before.worker.sampleCount);
				} else if (mode === "worker-pause") {
					worker.postMessage("pause");
					await waitFor(() => messages.some((message) => message.category === "paused"));
					const after = readFinalizerLoopDiagnostics(parentBuffer, workerBuffer);
					if (after.parent.state === "unavailable" || after.worker.state === "unavailable")
						throw new Error("missing paused sample");
					expect(
						Math.max(after.worker.currentGapMs, after.worker.maxCompletedGapMs),
					).toBeGreaterThanOrEqual(850);
					expect(after.parent.sampleCount).toBeGreaterThan(before.parent.sampleCount);
				} else {
					worker.postMessage("exchange");
					await waitFor(() => messages.some((message) => message.category === "exchange"));
					expect(readFinalizerLoopObservation(parentBuffer).state).toBe("sampled");
				}
			} finally {
				worker.postMessage("stop");
				const watchdog = setTimeout(() => void worker.terminate(), 5000);
				try {
					expect(await joined).toBe(0);
				} finally {
					clearTimeout(watchdog);
					stopParent();
				}
			}
			expect(exited).toBe(true);
			expect(messages.some((message) => message.category === "closed")).toBe(true);
		},
		10000,
	);
});
