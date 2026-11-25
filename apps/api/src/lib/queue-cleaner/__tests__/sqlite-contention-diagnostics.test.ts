import { describe, expect, it } from "vitest";
import {
	queueCleanerSqliteDiagnosticsFrom,
	runQueueCleanerSqliteTransaction,
} from "../sqlite-contention-diagnostics.js";

describe("Queue Cleaner bounded SQLite diagnostics", () => {
	it("distinguishes a transaction-admission refusal and preserves safe codes", async () => {
		const error = {
			code: "P2028",
			meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
		};
		await expect(
			runQueueCleanerSqliteTransaction(
				"file:/private/path-is-not-logged.db",
				"strike-state",
				async () => {
					throw error;
				},
				async () => "unreachable",
			),
		).rejects.toBe(error);
		const diagnostic = queueCleanerSqliteDiagnosticsFrom(error);
		expect(diagnostic).toEqual({
			job: "queue-cleaner",
			operation: "strike-state",
			boundary: "transaction-admission",
			transactionEntered: false,
			prismaCode: "P2028",
			nativeCode: "SQLITE_BUSY",
			elapsedMs: expect.any(Number),
			retryObserved: false,
			outcome: "failed",
		});
		expect(diagnostic!.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(diagnostic!.elapsedMs).toBeLessThanOrEqual(60_000);
		expect(JSON.stringify(diagnostic)).not.toContain("private/path");
	});

	it("marks a failure after callback entry and does not add retry behavior", async () => {
		const error = { code: "P2028" };
		await expect(
			runQueueCleanerSqliteTransaction(
				"file:synthetic.db",
				"run-result-commit",
				async (callback) => callback({} as never),
				async () => {
					throw error;
				},
			),
		).rejects.toBe(error);
		expect(queueCleanerSqliteDiagnosticsFrom(error)).toMatchObject({
			job: "queue-cleaner",
			operation: "run-result-commit",
			boundary: "transaction-callback",
			transactionEntered: true,
			prismaCode: "P2028",
			nativeCode: "unknown",
			retryObserved: false,
			outcome: "failed",
		});
	});

	it.each([
		[{ code: "SQLITE_BUSY" }, "SQLITE_BUSY"],
		[
			{
				code: "SQLITE_BUSY_SNAPSHOT",
				meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
			},
			"SQLITE_BUSY_SNAPSHOT",
		],
		[{ cause: { originalCode: "SQLITE_LOCKED" } }, "SQLITE_LOCKED"],
	])(
		"preserves an exact safe native code from the direct code or settled cause",
		async (error, nativeCode) => {
			await expect(
				runQueueCleanerSqliteTransaction(
					"file:synthetic.db",
					"strike-state",
					async () => {
						throw error;
					},
					async () => "unreachable",
				),
			).rejects.toBe(error);
			expect(queueCleanerSqliteDiagnosticsFrom(error)).toMatchObject({ nativeCode });
		},
	);
	it("does not classify unknown codes, unsafe properties, or non-SQLite storage", async () => {
		let getterReads = 0;
		const error = Object.defineProperty({}, "code", {
			get() {
				getterReads++;
				return "P2028";
			},
		});
		await expect(
			runQueueCleanerSqliteTransaction(
				"file:synthetic.db",
				"run-result-commit",
				async () => {
					throw error;
				},
				async () => "unreachable",
			),
		).rejects.toBe(error);
		expect(queueCleanerSqliteDiagnosticsFrom(error)).toBeUndefined();
		expect(getterReads).toBe(0);

		const otherError = { code: "P2028" };
		await expect(
			runQueueCleanerSqliteTransaction(
				"postgresql://fixture.invalid/database",
				"run-result-commit",
				async () => {
					throw otherError;
				},
				async () => "unreachable",
			),
		).rejects.toBe(otherError);
		expect(queueCleanerSqliteDiagnosticsFrom(otherError)).toBeUndefined();
	});
});
