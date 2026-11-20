import pino from "pino";
import { describe, expect, it } from "vitest";
import * as loss from "../restore-runtime-loss.js";

// Catch private-field leakage or observer exceptions in the diagnostic sink.
describe("closed runtime loss log", () => {
	it.each([
		"runtime-unavailable",
		"runtime-record-check-failed",
		"native-owner-unavailable",
		"native-participation-unavailable",
		"storage-binding-invalid",
		"client-invalid-journal",
		"client-close-failed",
		"transaction-cleanup-failed",
		"worker-proof-timeout",
		"worker-channel-unavailable",
		"worker-proof-invalid",
		"worker-proof-failed",
	] as const)(
		"retains closed worker cause %s while the actual shared fence denies work",
		(reason) => {
			const words = new Int32Array(new SharedArrayBuffer(8));
			Atomics.store(words, 1, 741);
			loss.recordRestoreRuntimeWorkerLoss(words, reason);
			expect(Atomics.load(words, 0)).not.toBe(0);
			expect(Atomics.load(words, 1)).toBe(741);
			expect(loss.readRestoreRuntimeWorkerLoss(words)).toBe(reason);
			loss.recordRestoreRuntimeWorkerLoss(words, "worker-proof-invalid");
			expect(loss.readRestoreRuntimeWorkerLoss(words)).toBe(reason);
			expect(Atomics.load(words, 1)).toBe(741);
		},
	);

	it.each([1, -1, 2147483647])(
		"never clears or reinterprets an existing unknown/revoked nonzero fence %s",
		(value) => {
			const words = new Int32Array(new SharedArrayBuffer(8));
			Atomics.store(words, 0, value);
			expect(loss.readRestoreRuntimeWorkerLoss(words)).toBeUndefined();
			loss.recordRestoreRuntimeWorkerLoss(words, "worker-proof-timeout");
			expect(Atomics.load(words, 0)).toBe(value);
			expect(loss.readRestoreRuntimeWorkerLoss(words)).toBeUndefined();
		},
	);

	it("does not turn an open fence or private reason into a reported verified cause", () => {
		const words = new Int32Array(new SharedArrayBuffer(8));
		expect(loss.readRestoreRuntimeWorkerLoss(words)).toBeUndefined();
		expect(Atomics.load(words, 0)).toBe(0);
		loss.recordRestoreRuntimeWorkerLoss(words, "PRIVATE_SENTINEL" as never);
		expect(Atomics.load(words, 0)).not.toBe(0);
		expect(loss.readRestoreRuntimeWorkerLoss(words)).toBe("runtime-unavailable");
	});

	it("logs only a generic category, allowlisted reason, and safe age through real Pino", () => {
		let output = "";
		const logger = pino(
			{ base: null, timestamp: false },
			{
				write: (line: string) => {
					output += line;
				},
			},
		);
		expect(typeof loss.logRestoreRuntimeLoss).toBe("function");
		loss.logRestoreRuntimeLoss(logger, {
			reason: "worker-proof-timeout",
			runtimeAgeMs: 0,
			secret: "PRIVATE_SENTINEL",
			error: new Error("PRIVATE_SENTINEL"),
		} as never);
		expect(JSON.parse(output)).toEqual({
			level: 50,
			category: "restore-runtime-authority-lost",
			reason: "worker-proof-timeout",
			runtimeAgeMs: 0,
			msg: "Runtime admission stopped",
		});
		expect(output).not.toContain("PRIVATE_SENTINEL");
	});

	it.each([
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		"PRIVATE_SENTINEL",
	])("does not publish an invalid age as a measured zero: %s", (age) => {
		let output = "";
		const logger = pino(
			{ base: null, timestamp: false },
			{
				write: (line: string) => {
					output += line;
				},
			},
		);
		expect(typeof loss.logRestoreRuntimeLoss).toBe("function");
		loss.logRestoreRuntimeLoss(logger, { reason: "PRIVATE_SENTINEL", runtimeAgeMs: age } as never);
		expect(JSON.parse(output)).toEqual({
			level: 50,
			category: "restore-runtime-authority-lost",
			reason: "runtime-unavailable",
			msg: "Runtime admission stopped",
		});
		expect(output).not.toContain("PRIVATE_SENTINEL");
	});

	it("cannot prevent shutdown when a diagnostic logger throws", () => {
		expect(typeof loss.logRestoreRuntimeLoss).toBe("function");
		expect(() =>
			loss.logRestoreRuntimeLoss(
				{
					error() {
						throw new Error("synthetic sink failure");
					},
				},
				{
					reason: "client-close-failed",
					runtimeAgeMs: 7,
				},
			),
		).not.toThrow();
	});
});
