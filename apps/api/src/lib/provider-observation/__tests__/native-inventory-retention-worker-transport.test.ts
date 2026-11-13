import { EventEmitter } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const admission = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("../../backup/restore-runtime-admission.js", () => ({
	attachRestoreRuntimeWorker: admission.attach,
}));

import {
	NativeInventoryRetentionWorkerError,
	nativeInventoryRetentionWorkerUrl,
	runNativeInventoryRetentionWorker,
} from "../native-inventory-retention-worker-transport.js";

const payload = {
	databaseUrl: "file:/synthetic/fixture.db",
	cutoff: new Date("2026-10-01T00:00:00Z"),
	rowLimit: 500,
	scanLimit: 10,
	cursor: null,
};
const completed = {
	status: "completed",
	deletedRows: 7,
	deletedRuns: 1,
	scannedRuns: 2,
	nextCursor: { id: "synthetic-cursor" },
	hasMore: true,
};
const channels: MessageChannel[] = [];
let unavailable = () => {};
let close = vi.fn(async () => {});
class FakeWorker extends EventEmitter {
	postMessage = vi.fn();
	// Resolving/rejecting this request deliberately does not emit an exit.
	terminate = vi.fn(async () => 0);
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function start(options: { signal?: AbortSignal } = {}) {
	const worker = new FakeWorker();
	let settled = false;
	const pending = runNativeInventoryRetentionWorker(payload, {
		...options,
		createWorker: () => worker,
	})
		.then(
			(value) => ({ value }),
			(error) => ({ error }),
		)
		.finally(() => {
			settled = true;
		});
	return { worker, pending, settled: () => settled };
}
beforeEach(() => {
	unavailable = () => {};
	close = vi.fn(async () => {});
	admission.attach.mockReset().mockImplementation(async () => {
		const channel = new MessageChannel();
		channels.push(channel);
		return {
			binding: {
				databaseUrl: payload.databaseUrl,
				record: { phase: "running" },
				port: channel.port2,
				fence: new SharedArrayBuffer(8),
			},
			onUnavailable: (listener: () => void) => {
				unavailable = listener;
				return () => {};
			},
			close,
		};
	});
});
afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});

describe("native retention worker lifetime and protocol", () => {
	// Break caught: a valid bounded failure is discarded as a protocol error
	// or its original evidence is replaced before worker/bridge closure.
	it("retains bounded boundary evidence through physical exit and a later close failure", async () => {
		close.mockRejectedValueOnce({ code: "SQLITE_LOCKED", message: "synthetic-private-close" });
		const operation = start();
		await turn();
		operation.worker.emit("message", {
			status: "failed",
			failurePhase: "retention",
			failureCode: "P1008",
			retentionBoundary: {
				operation: "transaction-start",
				transactionEntered: false,
				nativeCode: "SQLITE_BUSY",
			},
		});
		await turn();
		expect(operation.settled()).toBe(false);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: {
				failurePhase: "retention",
				failureCode: "P1008",
				retentionBoundary: {
					operation: "transaction-start",
					transactionEntered: false,
					nativeCode: "SQLITE_BUSY",
				},
			},
		});
	});

	it("keeps a known transport error code without reading any error accessors", async () => {
		const getter = vi.fn(() => {
			throw new Error("private-getter");
		});
		admission.attach.mockRejectedValueOnce(
			Object.defineProperty({ code: "SQLITE_BUSY" }, "message", { get: getter }),
		);
		await expect(runNativeInventoryRetentionWorker(payload)).rejects.toMatchObject({
			transportFailure: "attach-failed",
			failureCode: "SQLITE_BUSY",
		});
		expect(getter).not.toHaveBeenCalled();
		const operation = start();
		await turn();
		operation.worker.emit("error", Object.defineProperty({}, "code", { get: getter }));
		operation.worker.emit("exit", 1);
		expect(await operation.pending).toMatchObject({
			error: { transportFailure: "worker-error", failureCode: "unknown" },
		});
		expect(getter).not.toHaveBeenCalled();
	});
	it("retains worker failure provenance through exit and a second close failure", async () => {
		close.mockRejectedValueOnce({ code: "SQLITE_BUSY", message: "synthetic-private-close" });
		const operation = start();
		await turn();
		operation.worker.emit("message", {
			status: "failed",
			failurePhase: "retention",
			failureCode: "P2028",
		});
		operation.worker.emit("error", new Error("synthetic-private-second"));
		await turn();
		expect(operation.settled()).toBe(false);
		operation.worker.emit("exit", 1);
		expect(await operation.pending).toMatchObject({
			error: {
				failurePhase: "retention",
				failureCode: "P2028",
				message: "Native inventory retention worker failed",
			},
		});
	});
	it.each([
		{ status: "failed", failurePhase: "retention" },
		{ status: "failed", failureCode: "P2028" },
		{ status: "failed", failurePhase: "private", failureCode: "P2028" },
		{ status: "failed", failurePhase: "retention", failureCode: "private" },
		{ status: "failed", failurePhase: "retention", failureCode: "P2028", message: "private" },
		{ status: "cancelled", failurePhase: "retention", failureCode: "P2028" },
	])("refuses partial, unknown or private diagnostics: %j", async (message) => {
		const operation = start();
		await turn();
		operation.worker.emit("message", message);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: {
				transportFailure: "invalid-worker-result",
				failurePhase: "unknown",
				failureCode: "unknown",
			},
		});
	});
	it("does not invoke result getters", async () => {
		const getter = vi.fn(() => "retention");
		const operation = start();
		await turn();
		operation.worker.emit(
			"message",
			Object.defineProperty({ status: "failed", failureCode: "P2028" }, "failurePhase", {
				get: getter,
				enumerable: true,
			}),
		);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: { transportFailure: "invalid-worker-result" },
		});
		expect(getter).not.toHaveBeenCalled();
	});
	it.each([
		["error", "worker-error"],
		["messageerror", "worker-messageerror"],
		["bridge", "runtime-bridge-unavailable"],
		["missing", "worker-exited-without-result"],
		["nonzero", "worker-nonzero-exit"],
		["duplicate", "invalid-worker-result"],
	] as const)(
		"preserves the first %s transport failure if closing also fails",
		async (event, expected) => {
			close.mockRejectedValueOnce(new Error("synthetic-private-close"));
			const operation = start();
			await turn();
			if (event === "nonzero" || event === "duplicate") operation.worker.emit("message", completed);
			if (event === "duplicate") operation.worker.emit("message", completed);
			if (event === "error" || event === "messageerror")
				operation.worker.emit(event, { code: "P2028" });
			if (event === "bridge") unavailable();
			operation.worker.emit("exit", event === "nonzero" ? 1 : 0);
			expect(await operation.pending).toMatchObject({
				error: {
					transportFailure: expected,
					failurePhase: "unknown",
					failureCode: event === "error" || event === "messageerror" ? "P2028" : "unknown",
				},
			});
		},
	);
	it("accepts legacy failed messages as generic failures", async () => {
		const operation = start();
		await turn();
		operation.worker.emit("message", { status: "failed" });
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: { failurePhase: "unknown", failureCode: "unknown" },
		});
	});
	it("distinguishes attach, construction and close failures without leaking their errors", async () => {
		admission.attach.mockRejectedValueOnce({ code: "P2028", message: "private" });
		await expect(runNativeInventoryRetentionWorker(payload)).rejects.toMatchObject({
			transportFailure: "attach-failed",
			failurePhase: "unknown",
			failureCode: "P2028",
		});
		close.mockRejectedValueOnce(new Error("private"));
		await expect(
			runNativeInventoryRetentionWorker(payload, {
				createWorker: () => {
					throw new Error("private");
				},
			}),
		).rejects.toMatchObject({ transportFailure: "worker-construction-failed" });
		close.mockRejectedValueOnce(new Error("private"));
		const operation = start();
		await turn();
		operation.worker.emit("message", completed);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: { transportFailure: "bridge-close-failed" },
		});
	});
	it("pre-abort and failed admission spawn no worker", async () => {
		const controller = new AbortController();
		controller.abort();
		const createWorker = vi.fn(() => new FakeWorker());
		expect(
			await runNativeInventoryRetentionWorker(payload, { signal: controller.signal, createWorker }),
		).toEqual({ status: "cancelled" });
		expect(admission.attach).not.toHaveBeenCalled();
		admission.attach.mockRejectedValueOnce(new Error("synthetic-private-error"));
		await expect(runNativeInventoryRetentionWorker(payload, { createWorker })).rejects.toThrow(
			"Native inventory retention worker failed",
		);
		expect(createWorker).not.toHaveBeenCalled();
	});
	it("joins the admitted bridge without spawning when cancellation arrives during attach", async () => {
		const controller = new AbortController();
		const actualAttach = admission.attach.getMockImplementation()!;
		admission.attach.mockImplementationOnce(async () => {
			const bridge = await actualAttach();
			controller.abort();
			return bridge;
		});
		const createWorker = vi.fn(() => new FakeWorker());
		expect(
			await runNativeInventoryRetentionWorker(payload, { signal: controller.signal, createWorker }),
		).toEqual({ status: "cancelled" });
		expect(close).toHaveBeenCalledOnce();
		expect(createWorker).not.toHaveBeenCalled();
	});
	it.each([
		{ rowLimit: 0 },
		{ rowLimit: 501 },
		{ rowLimit: NaN },
		{ scanLimit: 0 },
		{ scanLimit: 101 },
		{ cutoff: new Date() },
		{ cutoff: new Date(NaN) },
		{ cutoff: "2026-10-01" },
		{ cursor: { id: "" } },
		{ cursor: { id: "x".repeat(257) } },
		{ cursor: { id: 1 } },
		{ databaseUrl: "postgresql://fixture.invalid/synthetic" },
	])("rejects invalid request before runtime admission: %j", async (change) => {
		await expect(
			runNativeInventoryRetentionWorker({ ...payload, ...change } as never),
		).rejects.toBeInstanceOf(NativeInventoryRetentionWorkerError);
		expect(admission.attach).not.toHaveBeenCalled();
	});
	it("accepts success only after independent exit and completed bridge closure", async () => {
		let release!: () => void;
		close.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const operation = start();
		await turn();
		operation.worker.emit("message", completed);
		await turn();
		expect(operation.settled()).toBe(false);
		expect(close).not.toHaveBeenCalled();
		operation.worker.emit("exit", 0);
		await turn();
		expect(close).toHaveBeenCalledOnce();
		expect(operation.settled()).toBe(false);
		release();
		expect(await operation.pending).toEqual({ value: completed });
	});
	it.each([
		{ deletedRows: -1 },
		{ deletedRows: 501 },
		{ deletedRows: 0.5 },
		{ deletedRuns: 8 },
		{ deletedRuns: 3 },
		{ scannedRuns: 11 },
		{ scannedRuns: 0 },
		{ hasMore: 1 },
		{ nextCursor: { id: "" } },
		{ nextCursor: { id: "x", extra: true } },
		{ status: "unknown" },
		{ extra: true },
	])("rejects malformed results without releasing a live worker: %j", async (change) => {
		const operation = start();
		await turn();
		operation.worker.emit("message", { ...completed, ...change });
		await turn();
		expect(operation.settled()).toBe(false);
		expect(close).not.toHaveBeenCalled();
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: expect.any(NativeInventoryRetentionWorkerError),
		});
		expect(close).toHaveBeenCalledOnce();
	});
	it.each([
		"missing",
		"duplicate",
		"crash",
		"messageerror",
		"proof-loss",
		"failed-result",
		"nonzero-exit",
	])("rejects uncertain %s outcomes after physical exit", async (kind) => {
		const operation = start();
		await turn();
		operation.worker.terminate.mockRejectedValueOnce(new Error("synthetic-stop-refused"));
		if (kind === "duplicate" || kind === "nonzero-exit")
			operation.worker.emit("message", completed);
		if (kind === "duplicate") operation.worker.emit("message", completed);
		if (kind === "crash") operation.worker.emit("error", new Error("synthetic-private-error"));
		if (kind === "messageerror")
			operation.worker.emit("messageerror", new Error("synthetic-private-error"));
		if (kind === "proof-loss") unavailable();
		if (kind === "failed-result") operation.worker.emit("message", { status: "failed" });
		await turn();
		expect(operation.settled()).toBe(false);
		expect(close).not.toHaveBeenCalled();
		operation.worker.emit("exit", kind === "nonzero-exit" ? 1 : 0);
		const outcome = await operation.pending;
		expect(outcome).toMatchObject({ error: expect.any(NativeInventoryRetentionWorkerError) });
		expect(String("error" in outcome && outcome.error)).not.toContain("synthetic-private-error");
		expect(close).toHaveBeenCalledOnce();
	});
	it.each(["resolve", "throw", "reject"])(
		"a %s termination request never proves exit",
		async (mode) => {
			const operation = start();
			await turn();
			operation.worker.terminate.mockImplementationOnce(() => {
				if (mode === "throw") throw new Error("synthetic-stop-refused");
				return mode === "reject"
					? Promise.reject(new Error("synthetic-stop-refused"))
					: Promise.resolve(0);
			});
			operation.worker.emit("error", new Error("synthetic-private-error"));
			await turn();
			expect(operation.settled()).toBe(false);
			expect(close).not.toHaveBeenCalled();
			operation.worker.emit("exit", 1);
			await operation.pending;
			expect(close).toHaveBeenCalledOnce();
		},
	);
	it("cooperatively cancels entered work and retains a committed result until real exit", async () => {
		const controller = new AbortController();
		const operation = start({ signal: controller.signal });
		await turn();
		controller.abort();
		await turn();
		expect(operation.worker.postMessage).toHaveBeenCalledWith({ kind: "cancel" });
		expect(operation.worker.terminate).not.toHaveBeenCalled();
		expect(operation.settled()).toBe(false);
		operation.worker.emit("message", completed);
		await turn();
		expect(operation.settled()).toBe(false);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toEqual({ value: completed });
	});
	it("does not report success when bridge closure fails", async () => {
		close.mockRejectedValueOnce(new Error("synthetic-private-close"));
		const operation = start();
		await turn();
		operation.worker.emit("message", completed);
		operation.worker.emit("exit", 0);
		expect(await operation.pending).toMatchObject({
			error: expect.any(NativeInventoryRetentionWorkerError),
		});
	});
	it("resolves the actual source and bundled standalone worker locations", () => {
		expect(
			nativeInventoryRetentionWorkerUrl(
				"file:///fixture/src/lib/provider-observation/native-inventory-retention-worker-transport.ts",
			).href,
		).toBe("file:///fixture/src/lib/provider-observation/native-inventory-retention-worker.ts");
		expect(nativeInventoryRetentionWorkerUrl("file:///fixture/dist/chunk-ABC.js").href).toBe(
			"file:///fixture/dist/lib/provider-observation/native-inventory-retention-worker.js",
		);
	});
});
