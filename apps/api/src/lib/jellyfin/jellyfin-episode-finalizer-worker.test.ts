import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { recordRestoreRuntimeWorkerLoss } from "../backup/restore-runtime-loss.js";

const admission = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("../backup/restore-runtime-admission.js", () => ({
	attachRestoreRuntimeWorker: admission.attach,
}));
admission.attach.mockImplementation(async () => {
	const { port1, port2 } = new MessageChannel();
	return {
		binding: {
			databaseUrl: "file:/private/config/prod.db",
			record: { phase: "running" },
			port: port2,
			fence: new SharedArrayBuffer(8),
		},
		onUnavailable: () => () => {},
		close: async () => {
			port1.close();
			port2.close();
		},
	};
});

import {
	createFinalizerLoopObservationBuffer,
	startFinalizerLoopObservation,
} from "./finalizer-loop-observation.js";
import {
	type JellyfinEpisodeFinalizationWorkerResult,
	jellyfinEpisodeFinalizerWorkerUrl,
	runJellyfinEpisodeFinalizerWorker,
} from "./jellyfin-episode-finalizer-worker-transport.js";

class FakeWorker extends EventEmitter {
	postMessage = vi.fn();
	terminate = vi.fn(async () => {
		queueMicrotask(() => this.emit("exit", 0));
		return 0;
	});
}

const timing = {
	authorityMs: 40,
	stageLoadMs: 24_400,
	computeMs: 64_000,
	episodeWriteMs: 22,
	nativeProjectionMs: 3_550,
	nativeWatchWriteMs: 79_100,
	totalMs: 171_200,
	stageRows: 20_000,
	nativeCandidates: 3_000,
};
const unstartedWorkerObservation = {
	parent: expect.objectContaining({
		state: expect.stringMatching(/^(warming|sampled)$/),
		currentGapMs: expect.any(Number),
	}),
	worker: { state: "unavailable" },
};
const payload = {
	databaseUrl: "file:/private/config/prod.db",
	userId: "private-user-id",
	instance: {
		id: "private-instance-id",
		userId: "private-user-id",
		service: "JELLYFIN" as const,
		baseUrl: "https://private.example.invalid",
		apiKey: "private-api-key",
		enabled: true,
		encryptedApiKey: "encrypted-private-api-key",
		encryptionIv: "private-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "private-provider-identity",
		identityStatus: "VERIFIED" as const,
		connectionGeneration: 3,
		identityGeneration: 4,
	},
	runId: "private-run-id",
	scopes: [{ userId: "private-user-id", userName: "private-user", libraryId: "private-library" }],
	attempt: { attemptedAt: new Date("2026-09-24T00:00:00.000Z"), resultMarker: "private-marker" },
	now: new Date("2026-09-24T00:00:00.000Z"),
};

describe("Jellyfin episode finalizer worker transport", () => {
	it.each([
		["attach", "attach-failed"],
		["constructor", "worker-construction-failed"],
		["error", "worker-error"],
		["invalid-message", "invalid-worker-result"],
		["exit", "worker-exited-without-result"],
		["unavailable", "runtime-bridge-unavailable"],
		["close", "bridge-close-failed"],
	] as const)(
		"retains a closed diagnostic for %s without exposing error details",
		async (mode, want) => {
			const worker = new FakeWorker();
			const { port1, port2 } = new MessageChannel();
			const fence = new SharedArrayBuffer(8);
			let unavailable = () => {};
			if (mode === "attach")
				admission.attach.mockRejectedValueOnce(new Error("private attach detail"));
			else
				admission.attach.mockResolvedValueOnce({
					binding: {
						databaseUrl: payload.databaseUrl,
						record: { phase: "running" },
						port: port2,
						fence,
					},
					onUnavailable: (listener: () => void) => {
						unavailable = listener;
						return () => {};
					},
					close: async () => {
						port1.close();
						port2.close();
						if (mode === "close") throw new Error("private cleanup detail");
					},
				});
			const pending = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => {
					if (mode === "constructor") throw new Error("private constructor detail");
					return worker as never;
				},
			}).catch((error: unknown) => error);
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (mode === "error") worker.emit("error", new Error("private worker detail"));
				if (mode === "invalid-message") worker.emit("message", { status: "private result" });
				if (mode === "exit") worker.emit("exit", 1);
				if (mode === "unavailable") {
					recordRestoreRuntimeWorkerLoss(new Int32Array(fence), "worker-proof-timeout");
					unavailable();
				}
				if (mode === "close") worker.emit("message", { status: "superseded" });
				const error = await pending;
				expect(error).toMatchObject({ category: "worker-failed", transportFailure: want });
				if (mode === "unavailable")
					expect(error).toHaveProperty("runtimeLossReason", "worker-proof-timeout");
				else expect(error).not.toHaveProperty("runtimeLossReason");
				expect(JSON.stringify(error)).not.toContain("private");
			} finally {
				port1.close();
				port2.close();
			}
		},
	);

	it("keeps the first failure diagnostic through later errors and cleanup failure", async () => {
		const worker = new FakeWorker();
		worker.terminate.mockResolvedValue(0);
		const { port1, port2 } = new MessageChannel();
		let unavailable = () => {};
		const fence = new SharedArrayBuffer(8);
		admission.attach.mockResolvedValueOnce({
			binding: {
				databaseUrl: payload.databaseUrl,
				record: { phase: "running" },
				port: port2,
				fence,
			},
			onUnavailable: (listener: () => void) => {
				unavailable = listener;
				return () => {};
			},
			close: async () => {
				port1.close();
				port2.close();
				throw new Error("private cleanup detail");
			},
		});
		let settled = false;
		const pending = runJellyfinEpisodeFinalizerWorker(payload, {
			createWorker: () => worker as never,
		})
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		worker.emit("message", { status: "private invalid result" });
		worker.emit("error", new Error("private secondary failure"));
		recordRestoreRuntimeWorkerLoss(new Int32Array(fence), "worker-proof-timeout");
		unavailable();
		await Promise.resolve();
		expect(settled).toBe(false);
		worker.emit("exit", 1);
		const error = await pending;
		expect(error).toMatchObject({
			transportFailure: "invalid-worker-result",
			category: "worker-failed",
		});
		expect(error).not.toHaveProperty("runtimeLossReason");
		expect(JSON.stringify(error)).not.toContain("private");
	});
	it("rejects pre-aborted finalization without attaching or spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const worker = new FakeWorker(),
			createWorker = vi.fn(() => worker);
		const pending = runJellyfinEpisodeFinalizerWorker(payload, {
			signal: controller.signal,
			createWorker,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		worker.emit("message", { status: "cancelled" });
		expect(await pending.catch((error) => error)).toEqual({ status: "cancelled" });
		expect(createWorker).not.toHaveBeenCalled();
	});
	it("cooperatively cancels but retains the finalizer until independent exit", async () => {
		const controller = new AbortController(),
			worker = new FakeWorker();
		let settled = false;
		const pending = runJellyfinEpisodeFinalizerWorker(payload, {
			signal: controller.signal,
			createWorker: () => worker,
		})
			.catch((error) => error)
			.finally(() => {
				settled = true;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(new Error("private"));
		await Promise.resolve();
		const before = {
			settled,
			stopped: worker.terminate.mock.calls.length,
			messages: worker.postMessage.mock.calls,
		};
		worker.emit("message", { status: "cancelled" });
		worker.emit("exit", 0);
		expect(await pending).toEqual({ status: "cancelled" });
		expect(before).toEqual({ settled: false, stopped: 0, messages: [[{ kind: "cancel" }]] });
	});
	it.each(["returned-failure", "error", "invalid-message", "unavailable"] as const)(
		"freezes independent observations before termination and bridge cleanup after %s",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			let clock = 1000n;
			const timer = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => clock * 1_000_000n);
			const worker = new FakeWorker();
			worker.terminate.mockImplementation(async () => {
				clock = 9000n;
				return 0;
			});
			let unavailable = () => {};
			const { port1, port2 } = new MessageChannel();
			const bridgeClose = vi.fn(async () => {
				clock = 12000n;
				port1.close();
				port2.close();
			});
			admission.attach.mockResolvedValueOnce({
				binding: {
					databaseUrl: payload.databaseUrl,
					record: { phase: "running" },
					port: port2,
					fence: new SharedArrayBuffer(8),
				},
				onUnavailable: (listener: () => void) => {
					unavailable = listener;
					return () => {};
				},
				close: bridgeClose,
			});
			let stopWorker = () => {};
			const getter = vi.fn(() => "private");
			const supplied = createFinalizerLoopObservationBuffer();
			const run = runJellyfinEpisodeFinalizerWorker(
				{ ...payload, loopObservationBuffer: supplied },
				{
					createWorker: (_url, data) => {
						expect(data.loopObservationBuffer).not.toBe(supplied);
						expect(data.loopObservationBuffer?.byteLength).toBe(552);
						expect(data.runtimeBinding?.fence.byteLength).toBe(8);
						stopWorker = startFinalizerLoopObservation(data.loopObservationBuffer);
						return worker as never;
					},
				},
			);
			let completed = false;
			const outcome = run.then(
				(value) => {
					completed = true;
					return { value, error: undefined };
				},
				(error) => {
					completed = true;
					return { value: undefined, error };
				},
			);
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				clock = 1250n;
				vi.advanceTimersByTime(250);
				clock = 2750n;
				if (mode === "returned-failure")
					worker.emit(
						"message",
						Object.defineProperty({ status: "failed" }, "loopObservation", { get: getter }),
					);
				else if (mode === "invalid-message")
					worker.emit("message", {
						status: "published",
						itemCount: -1,
						loopObservation: { private: "private" },
					});
				else if (mode === "error") worker.emit("error", new Error("private"));
				else unavailable();
				expect(completed).toBe(false);
				expect(bridgeClose).not.toHaveBeenCalled();
				worker.emit("exit", 1);
				const result = await outcome;
				const carrier = mode === "returned-failure" ? result.value : result.error;
				expect(carrier.loopObservation).toEqual({
					parent: {
						state: "sampled",
						sampleCount: 1,
						sampleSpanMs: 250,
						maxCompletedGapMs: 250,
						currentGapMs: 1500,
					},
					worker: {
						state: "sampled",
						sampleCount: 1,
						sampleSpanMs: 250,
						maxCompletedGapMs: 250,
						currentGapMs: 1500,
					},
				});
				expect(getter).not.toHaveBeenCalled();
				expect(JSON.stringify(carrier)).not.toContain("private");
				expect(bridgeClose).toHaveBeenCalledOnce();
			} finally {
				worker.emit("exit", 1);
				await outcome;
				stopWorker();
				timer.mockRestore();
				expect(vi.getTimerCount()).toBe(0);
				vi.useRealTimers();
			}
		},
	);

	it.each(["attach", "constructor", "bridge-close"] as const)(
		"clears the parent observer after %s setup failure",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			if (mode === "attach") admission.attach.mockRejectedValueOnce(new Error("private"));
			else if (mode === "bridge-close")
				admission.attach.mockResolvedValueOnce({
					binding: { databaseUrl: payload.databaseUrl, port: undefined },
					close: async () => {
						throw new Error("private");
					},
				});
			try {
				await expect(
					runJellyfinEpisodeFinalizerWorker(payload, {
						createWorker: () => {
							throw new Error("private");
						},
					}),
				).rejects.toBeInstanceOf(Error);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("retains independent parent and unstarted-worker observations on actual worker failure", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() => worker.emit("error", new Error("private worker detail")));
		await expect(run).rejects.toMatchObject({
			category: "worker-failed",
			loopObservation: {
				parent: {
					state: "warming",
					sampleCount: 0,
					sampleSpanMs: 0,
					maxCompletedGapMs: 0,
					currentGapMs: expect.any(Number),
				},
				worker: { state: "unavailable" },
			},
		});
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
	it("refuses to launch when the active private parent admission is unavailable", async () => {
		admission.attach.mockRejectedValueOnce(new Error("Synthetic no ticket"));
		let launched = false;
		const run = runJellyfinEpisodeFinalizerWorker(payload, {
			createWorker: () => {
				launched = true;
				const worker = new FakeWorker();
				setImmediate(() => worker.emit("message", { status: "superseded" }));
				return worker as never;
			},
		});
		await expect(run).rejects.toMatchObject({ category: "worker-failed" });
		expect(launched).toBe(false);
	});
	it("resolves to the emitted production worker beside the dist/lib tree", () => {
		expect(jellyfinEpisodeFinalizerWorkerUrl("file:///app/dist/index.js").href).toBe(
			"file:///app/dist/lib/jellyfin/jellyfin-episode-finalizer-worker.js",
		);
	});

	it("resolves to the source worker under the supported tsx development runtime", () => {
		expect(
			jellyfinEpisodeFinalizerWorkerUrl(
				"file:///app/src/lib/jellyfin/jellyfin-episode-finalizer-worker-transport.ts",
			).href,
		).toBe("file:///app/src/lib/jellyfin/jellyfin-episode-finalizer-worker.ts");
	});

	it("starts the real source worker with tsx registration and refuses an unavailable native binding", async () => {
		const result = await runJellyfinEpisodeFinalizerWorker({
			...payload,
			databaseUrl: payload.databaseUrl,
		});
		expect(result).toMatchObject({ status: "failed", failurePhase: "connection" });
	});

	it("returns only the committed numeric finalization summary", async () => {
		const worker = new FakeWorker();
		const expected: JellyfinEpisodeFinalizationWorkerResult = {
			status: "published",
			itemCount: 3_000,
			timing,
			finalizationCallMs: 175_000,
			outerOverheadMs: 3_800,
			cleanupMs: 80_700,
			cleanupFailed: false,
		};
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() => worker.emit("message", { ...expected, secret: "must-not-cross" }));

		const result = await run;

		expect(result).toEqual(expected);
		expect(JSON.stringify(result)).not.toContain("must-not-cross");
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it("allowlists aggregate native watch disagreement counts across the worker boundary", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", {
				status: "published",
				itemCount: 3,
				finalizationCallMs: 10,
				outerOverheadMs: 1,
				cleanupMs: 1,
				cleanupFailed: false,
				timing: {
					...timing,
					nativeWatchDiagnostics: {
						invalidCollectRows: 0,
						invalidVerifyRows: 0,
						conflictedCoordinates: 0,
						duplicateCollectCoordinates: 0,
						missingVerifyCoordinates: 1,
						duplicateVerifyCoordinates: 0,
						changedObservationCoordinates: 1,
						verifyOnlyCoordinates: 0,
						secret: "private provider detail",
					},
				},
			}),
		);

		const result = await run;
		expect(result.status).toBe("published");
		if (result.status !== "published") throw new Error("unexpected worker result");
		expect(result.timing?.nativeWatchDiagnostics).toEqual({
			invalidCollectRows: 0,
			invalidVerifyRows: 0,
			conflictedCoordinates: 0,
			duplicateCollectCoordinates: 0,
			missingVerifyCoordinates: 1,
			duplicateVerifyCoordinates: 0,
			changedObservationCoordinates: 1,
			verifyOnlyCoordinates: 0,
		});
		expect(JSON.stringify(result)).not.toContain("private provider detail");
	});

	it("fails closed with a generic category when the worker crashes", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() => worker.emit("error", new Error("private URL and credential")));

		await expect(run).rejects.toMatchObject({
			name: "JellyfinEpisodeFinalizerWorkerError",
			category: "worker-failed",
			message: "Jellyfin episode finalization worker failed",
		});
		await expect(run.catch((error: Error) => error.message)).resolves.not.toContain("credential");
	});

	it("rejects an exit without a committed publication message", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() => worker.emit("exit", 0));

		await expect(run).rejects.toMatchObject({ category: "worker-failed" });
	});

	it.each(["rejects", "returns-early", "throws"] as const)(
		"retains the result until actual exit when termination %s",
		async (mode) => {
			const worker = new FakeWorker();
			worker.terminate.mockImplementation(() => {
				if (mode === "throws") throw new Error("Synthetic termination failure");
				if (mode === "rejects") return Promise.reject(new Error("Synthetic termination failure"));
				return Promise.resolve(0);
			});
			const run = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => worker as never,
			});
			let completed = false;
			const observed = run.then(
				() => {
					completed = true;
				},
				() => {
					completed = true;
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			worker.emit("message", { status: "not-published", reason: "run-not-ready" });
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(completed).toBe(false);
				worker.emit("exit", 0);
				await expect(run).resolves.toEqual({ status: "not-published", reason: "run-not-ready" });
			} finally {
				worker.emit("exit", 0);
				await observed;
			}
		},
	);
	it.each(["invalid-result", "error-after-result"] as const)(
		"keeps failed %s work pending until actual exit and rejects generically",
		async (mode) => {
			const worker = new FakeWorker();
			worker.terminate.mockResolvedValue(0);
			const run = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => worker as never,
			});
			let completed = false;
			const observed = run.then(
				() => {
					completed = true;
				},
				() => {
					completed = true;
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			worker.emit(
				"message",
				mode === "invalid-result"
					? { status: "published", itemCount: -1, secret: "private detail" }
					: { status: "not-published", reason: "run-not-ready" },
			);
			if (mode === "error-after-result") worker.emit("error", new Error("private worker detail"));
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(completed).toBe(false);
				worker.emit("exit", 1);
				await expect(run).rejects.toMatchObject({
					category: "worker-failed",
					message: "Jellyfin episode finalization worker failed",
				});
			} finally {
				worker.emit("exit", 1);
				await observed;
			}
		},
	);

	it.each([
		{ failureCode: "P2028", failureCategory: "transaction-expired" },
		{ failureCode: "SQLITE_BUSY_SNAPSHOT", failureCategory: "database-contention" },
	] as const)(
		"passes only allowlisted worker failure diagnostics: $failureCode",
		async ({ failureCode, failureCategory }) => {
			const worker = new FakeWorker();
			const run = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => worker as never,
			});
			setImmediate(() =>
				worker.emit("message", {
					status: "failed",
					failurePhase: "publication",
					failureCategory,
					failureStage: "commit",
					failureCode,
					failureElapsedMs: 60_001,
					secret: "private database path and provider credential",
				}),
			);

			const result = await run;
			expect(result).toEqual({
				status: "failed",
				loopObservation: unstartedWorkerObservation,
				failurePhase: "publication",
				failureCategory,
				failureStage: "commit",
				failureCode,
				failureElapsedMs: 60_001,
			});
			expect(JSON.stringify(result)).not.toContain("private");
		},
	);

	it("drops unrecognized failure stages and codes before logging", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", {
				status: "failed",
				failurePhase: "publication",
				failureCategory: "unknown",
				failureStage: "private-stage-name",
				failureCode: "private-database-detail",
				failureElapsedMs: 15,
			}),
		);

		await expect(run).resolves.toEqual({
			status: "failed",
			loopObservation: unstartedWorkerObservation,
			failurePhase: "publication",
			failureCategory: "unknown",
			failureElapsedMs: 15,
		});
	});

	it.each([
		{
			stage: "row-chunk-write",
			duration: 0,
			count: 500,
			want: {
				nativeWatchStage: "row-chunk-write",
				nativeWatchStageElapsedMs: 0,
				nativeWatchStageCount: 500,
			},
		},
		{
			stage: "lease-checkpoint",
			duration: 10,
			count: 0,
			want: {
				nativeWatchStage: "lease-checkpoint",
				nativeWatchStageElapsedMs: 10,
				nativeWatchStageCount: 0,
			},
		},
		{
			stage: "authority-check",
			duration: 10,
			count: undefined,
			want: { nativeWatchStage: "authority-check", nativeWatchStageElapsedMs: 10 },
		},
		{
			stage: "own-row-reset",
			duration: 10,
			count: undefined,
			want: { nativeWatchStage: "own-row-reset", nativeWatchStageElapsedMs: 10 },
		},
		{
			stage: "own-receipt-reset",
			duration: 10,
			count: undefined,
			want: { nativeWatchStage: "own-receipt-reset", nativeWatchStageElapsedMs: 10 },
		},
		{
			stage: "receipt-chunk-write",
			duration: 10,
			count: 1,
			want: {
				nativeWatchStage: "receipt-chunk-write",
				nativeWatchStageElapsedMs: 10,
				nativeWatchStageCount: 1,
			},
		},
		{
			stage: "row-verification",
			duration: 10,
			count: undefined,
			want: { nativeWatchStage: "row-verification", nativeWatchStageElapsedMs: 10 },
		},
		{
			stage: "receipt-verification",
			duration: 10,
			count: undefined,
			want: { nativeWatchStage: "receipt-verification", nativeWatchStageElapsedMs: 10 },
		},
		{ stage: "private-library-id", duration: 10, count: 1, want: {} },
		{ stage: { secret: "private" }, duration: 10, count: 1, want: {} },
		...[
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			"private",
			{ secret: "private" },
		].flatMap((invalid) => [
			{
				stage: "row-chunk-write",
				duration: invalid,
				count: 1,
				want: { nativeWatchStage: "row-chunk-write", nativeWatchStageCount: 1 },
			},
			{
				stage: "row-chunk-write",
				duration: 10,
				count: invalid,
				want: { nativeWatchStage: "row-chunk-write", nativeWatchStageElapsedMs: 10 },
			},
		]),
	])(
		"sanitizes inner-stage diagnostics from worker messages: %j",
		async ({ stage, duration, count, want }) => {
			const worker = new FakeWorker();
			const run = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => worker as never,
			});
			setImmediate(() =>
				worker.emit("message", {
					status: "failed",
					failurePhase: "publication",
					failureStage: "native-watch-stage",
					failureCategory: "transaction-expired",
					failureElapsedMs: 20,
					nativeWatchStage: stage,
					nativeWatchStageElapsedMs: duration,
					nativeWatchStageCount: count,
					secret: "private provider input",
					nativeWatchStageSql: "private SQL",
				}),
			);
			const result = await run;
			expect(result).toEqual({
				status: "failed",
				loopObservation: unstartedWorkerObservation,
				failurePhase: "publication",
				failureStage: "native-watch-stage",
				failureCategory: "transaction-expired",
				failureElapsedMs: 20,
				...want,
			});
			expect(JSON.stringify(result)).not.toContain("private");
		},
	);

	it.each([
		{
			fields: {
				nativeWatchPreviousStage: "row-chunk-write",
				nativeWatchPreviousStageElapsedMs: 5_000,
				nativeWatchPreviousStageCount: 500,
				nativeWatchTransactionKind: "row-chunk",
				nativeWatchTransactionElapsedMs: 5_002,
				nativeWatchTransactionCallbackEntered: true,
				nativeWatchTransactionWaitMs: 20,
				nativeWatchTransactionCallbackElapsedMs: 4_982,
			},
			want: {
				nativeWatchPreviousStage: "row-chunk-write",
				nativeWatchPreviousStageElapsedMs: 5_000,
				nativeWatchPreviousStageCount: 500,
				nativeWatchTransactionKind: "row-chunk",
				nativeWatchTransactionElapsedMs: 5_002,
				nativeWatchTransactionCallbackEntered: true,
				nativeWatchTransactionWaitMs: 20,
				nativeWatchTransactionCallbackElapsedMs: 4_982,
			},
		},
		{
			fields: {
				nativeWatchPreviousStage: "lease-checkpoint",
				nativeWatchPreviousStageElapsedMs: 0,
				nativeWatchPreviousStageCount: 0,
				nativeWatchTransactionKind: "lease-checkpoint",
				nativeWatchTransactionElapsedMs: 0,
				nativeWatchTransactionCallbackEntered: false,
				nativeWatchTransactionWaitMs: 10,
				nativeWatchTransactionCallbackElapsedMs: 10,
			},
			want: {
				nativeWatchPreviousStage: "lease-checkpoint",
				nativeWatchPreviousStageElapsedMs: 0,
				nativeWatchPreviousStageCount: 0,
				nativeWatchTransactionKind: "lease-checkpoint",
				nativeWatchTransactionElapsedMs: 0,
				nativeWatchTransactionCallbackEntered: false,
			},
		},
		{
			fields: {
				nativeWatchTransactionKind: "receipt-chunk",
				nativeWatchTransactionElapsedMs: 0,
				nativeWatchTransactionCallbackEntered: true,
				nativeWatchTransactionWaitMs: 0,
				nativeWatchTransactionCallbackElapsedMs: 0,
			},
			want: {
				nativeWatchTransactionKind: "receipt-chunk",
				nativeWatchTransactionElapsedMs: 0,
				nativeWatchTransactionCallbackEntered: true,
				nativeWatchTransactionWaitMs: 0,
				nativeWatchTransactionCallbackElapsedMs: 0,
			},
		},
		...[
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			"private",
			{ secret: "private" },
		].flatMap((invalid) => [
			{
				fields: {
					nativeWatchPreviousStage: "row-chunk-write",
					nativeWatchPreviousStageElapsedMs: invalid,
					nativeWatchPreviousStageCount: invalid,
				},
				want: { nativeWatchPreviousStage: "row-chunk-write" },
			},
			{
				fields: {
					nativeWatchTransactionKind: "row-chunk",
					nativeWatchTransactionElapsedMs: invalid,
					nativeWatchTransactionCallbackEntered: true,
					nativeWatchTransactionWaitMs: invalid,
					nativeWatchTransactionCallbackElapsedMs: invalid,
				},
				want: {
					nativeWatchTransactionKind: "row-chunk",
					nativeWatchTransactionCallbackEntered: true,
				},
			},
		]),
		{
			fields: {
				nativeWatchPreviousStage: "private",
				nativeWatchPreviousStageElapsedMs: 1,
				nativeWatchPreviousStageCount: 1,
				nativeWatchTransactionKind: "private",
				nativeWatchTransactionElapsedMs: 1,
				nativeWatchTransactionCallbackEntered: true,
			},
			want: {},
		},
		{
			fields: { nativeWatchPreviousStage: "row-chunk-write", nativeWatchPreviousStageCount: 501 },
			want: { nativeWatchPreviousStage: "row-chunk-write" },
		},
		{
			fields: {
				nativeWatchTransactionKind: "row-chunk",
				nativeWatchTransactionElapsedMs: 1,
				nativeWatchTransactionCallbackEntered: "private",
				nativeWatchTransactionWaitMs: 1,
				nativeWatchTransactionCallbackElapsedMs: 1,
			},
			want: { nativeWatchTransactionKind: "row-chunk", nativeWatchTransactionElapsedMs: 1 },
		},
	])("sanitizes preceding-stage and transaction diagnostics: %j", async ({ fields, want }) => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", {
				status: "failed",
				failurePhase: "publication",
				failureCategory: "transaction-expired",
				failureStage: "native-watch-stage",
				failureElapsedMs: 10,
				nativeWatchStage: "authority-check",
				nativeWatchStageElapsedMs: 2,
				...fields,
				error: { message: "private" },
				nativeWatchTransactionSql: "private",
				nativeWatchPreviousStageTitle: "private",
			}),
		);
		const result = await run;
		expect(result).toEqual({
			status: "failed",
			loopObservation: unstartedWorkerObservation,
			failurePhase: "publication",
			failureCategory: "transaction-expired",
			failureStage: "native-watch-stage",
			failureElapsedMs: 10,
			nativeWatchStage: "authority-check",
			nativeWatchStageElapsedMs: 2,
			...want,
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it.each(["commit", "native-watch-stage"])(
		"drops new diagnostics without native-stage context: %s",
		async (failureStage) => {
			const worker = new FakeWorker();
			const run = runJellyfinEpisodeFinalizerWorker(payload, {
				createWorker: () => worker as never,
			});
			setImmediate(() =>
				worker.emit("message", {
					status: "failed",
					failurePhase: "publication",
					failureCategory: "unknown",
					failureStage,
					failureElapsedMs: 10,
					nativeWatchStage: failureStage === "commit" ? "authority-check" : "private",
					nativeWatchPreviousStage: "row-chunk-write",
					nativeWatchPreviousStageElapsedMs: 10,
					nativeWatchTransactionKind: "row-chunk",
					nativeWatchTransactionElapsedMs: 10,
					nativeWatchTransactionCallbackEntered: false,
				}),
			);
			await expect(run).resolves.toEqual({
				status: "failed",
				loopObservation: unstartedWorkerObservation,
				failurePhase: "publication",
				failureCategory: "unknown",
				failureStage,
				failureElapsedMs: 10,
			});
		},
	);

	it("drops native-watch diagnostics attached to another failure stage", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", {
				status: "failed",
				failurePhase: "publication",
				failureStage: "commit",
				failureCategory: "unknown",
				failureElapsedMs: 20,
				nativeWatchStage: "row-chunk-write",
				nativeWatchStageElapsedMs: 10,
				nativeWatchStageCount: 1,
			}),
		);
		await expect(run).resolves.toEqual({
			status: "failed",
			loopObservation: unstartedWorkerObservation,
			failurePhase: "publication",
			failureStage: "commit",
			failureCategory: "unknown",
			failureElapsedMs: 20,
		});
	});

	it("passes only an allowlisted non-publication reason", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", {
				status: "not-published",
				reason: "lease-busy",
				secret: "private worker detail",
			}),
		);

		const result = await run;
		expect(result).toEqual({ status: "not-published", reason: "lease-busy" });
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it("drops unrecognized non-publication details", async () => {
		const worker = new FakeWorker();
		const run = runJellyfinEpisodeFinalizerWorker(payload, { createWorker: () => worker as never });
		setImmediate(() =>
			worker.emit("message", { status: "not-published", reason: "private worker detail" }),
		);

		expect(await run).toEqual({ status: "not-published" });
	});
});
