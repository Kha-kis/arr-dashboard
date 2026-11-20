import { describe, expect, it } from "vitest";
import {
	nativeInventoryRetentionDiagnosticsFrom,
	rememberNativeInventoryRetentionBoundary,
} from "../native-inventory-retention-diagnostics.js";
import { parseNativeInventoryRetentionWorkerResult } from "../native-inventory-retention-worker-transport.js";

const input = {
	databaseUrl: "file:/synthetic/boundary.db",
	cutoff: new Date("2026-10-01T00:00:00Z"),
	rowLimit: 500,
	scanLimit: 10,
	cursor: null,
};
const boundary = {
	operation: "transaction-start",
	transactionEntered: false,
	nativeCode: "SQLITE_BUSY",
};

describe("bounded retention failure boundary", () => {
	// Break caught: returning the WeakMap's stored object lets a caller poison
	// later evidence with a private value that escaped the closed projector.
	it("retains bounded local evidence when a caller mutates an earlier projection", () => {
		const error = {
			code: "P1008",
			meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
		};
		rememberNativeInventoryRetentionBoundary(error, "transaction-start", false);
		const first = nativeInventoryRetentionDiagnosticsFrom(error);
		expect(first.retentionBoundary).toEqual(boundary);
		Reflect.set(first.retentionBoundary!, "operation", "synthetic-private-query");
		expect(nativeInventoryRetentionDiagnosticsFrom(error)).toEqual({
			failurePhase: "unknown",
			failureCode: "unknown",
			retentionBoundary: boundary,
		});
	});

	it("does not read native error getters when recording local failure evidence", () => {
		let reads = 0;
		const error = Object.defineProperty({}, "meta", {
			get() {
				reads++;
				throw new Error("synthetic-private");
			},
		});
		rememberNativeInventoryRetentionBoundary(error, "run-recheck", true);
		expect(nativeInventoryRetentionDiagnosticsFrom(error)).toEqual({
			failurePhase: "unknown",
			failureCode: "unknown",
			retentionBoundary: {
				operation: "run-recheck",
				transactionEntered: true,
				nativeCode: "unknown",
			},
		});
		expect(reads).toBe(0);
	});

	// Break caught: a worker failure loses the evidence needed to distinguish
	// unentered admission from an entered query, encouraging unsafe retries.
	it("retains bounded evidence in diagnostic projection without copying private values", () => {
		expect(
			nativeInventoryRetentionDiagnosticsFrom({
				failurePhase: "retention",
				failureCode: "P1008",
				retentionBoundary: boundary,
				message: "synthetic-private-message",
				cause: { query: "synthetic-private-query" },
			}),
		).toEqual({ failurePhase: "retention", failureCode: "P1008", retentionBoundary: boundary });
	});

	it("retains bounded evidence through the strict failed worker result parser", () => {
		expect(
			parseNativeInventoryRetentionWorkerResult(
				{
					status: "failed",
					failurePhase: "retention",
					failureCode: "P1008",
					retentionBoundary: boundary,
				},
				input,
			),
		).toEqual({
			status: "failed",
			failurePhase: "retention",
			failureCode: "P1008",
			retentionBoundary: boundary,
		});
	});

	it.each([
		{ ...boundary, operation: "synthetic-private-query" },
		{ ...boundary, transactionEntered: "false" },
		{ ...boundary, nativeCode: "synthetic-private-code" },
		{ ...boundary, identifier: "synthetic-private-identifier" },
	])("rejects malformed boundary evidence without weakening the old failure shape", (value) => {
		expect(nativeInventoryRetentionDiagnosticsFrom({ retentionBoundary: value })).toEqual({
			failurePhase: "unknown",
			failureCode: "unknown",
		});
		expect(
			parseNativeInventoryRetentionWorkerResult(
				{
					status: "failed",
					failurePhase: "retention",
					failureCode: "P1008",
					retentionBoundary: value,
				},
				input,
			),
		).toBeNull();
		expect(
			parseNativeInventoryRetentionWorkerResult(
				{ status: "failed", failurePhase: "retention", failureCode: "P1008" },
				input,
			),
		).toEqual({ status: "failed", failurePhase: "retention", failureCode: "P1008" });
	});

	it("does not read boundary getters or inherited evidence", () => {
		let reads = 0;
		const hostile = Object.defineProperty({}, "operation", {
			get() {
				reads++;
				throw new Error("private");
			},
		});
		for (const value of [hostile, Object.create(boundary)]) {
			expect(nativeInventoryRetentionDiagnosticsFrom({ retentionBoundary: value })).toEqual({
				failurePhase: "unknown",
				failureCode: "unknown",
			});
		}
		expect(reads).toBe(0);
	});
});
