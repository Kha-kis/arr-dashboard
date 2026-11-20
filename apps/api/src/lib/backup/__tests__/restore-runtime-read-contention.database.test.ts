import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { assertRestoreRuntimeOperation, openRestoreRuntime } from "../restore-runtime-admission.js";

async function fixture(mode: "DELETE" | "WAL" = "DELETE") {
	const directory = mkdtempSync(join(tmpdir(), "arr-read-proof-"));
	const path = join(directory, "main.db");
	const main = new Database(path, { timeout: 0 });
	chmodSync(path, 0o600);
	main.pragma(`journal_mode = ${mode}`);
	main.exec(`CREATE TABLE RestoreRuntimeControl (
		id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL, phase TEXT NOT NULL,
		runtimeEpoch TEXT, ownerBackendPid INTEGER, activeRestoreId TEXT,
		lastCommittedRestoreId TEXT, lastCommittedAt DATETIME, destinationInstallationId TEXT);
		CREATE TABLE SqliteRestoreStorageBinding (
		id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL,
		databaseDevice TEXT NOT NULL, databaseInode TEXT NOT NULL,
		directoryDevice TEXT NOT NULL, directoryInode TEXT NOT NULL,
		coordinationDevice TEXT NOT NULL, coordinationInode TEXT NOT NULL,
		ownerDevice TEXT NOT NULL, ownerInode TEXT NOT NULL,
		operationsDevice TEXT NOT NULL, operationsInode TEXT NOT NULL)`);
	const losses: string[] = [];
	const runtime = await openRestoreRuntime({
		databaseUrl: `file:${path}`,
		onUnavailable: (event) => losses.push(event.reason),
	});
	await runtime.bindDestination("fixture-read-proof");
	await runtime.activate();
	const writer = new Database(path, { fileMustExist: true, timeout: 0 });
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let timerError: unknown;
	return {
		main,
		writer,
		runtime,
		losses,
		path,
		after(ms: number, operation: () => void) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				try {
					operation();
				} catch (error) {
					timerError = error;
				}
			}, ms);
			timers.add(timer);
		},
		async close() {
			for (const timer of timers) clearTimeout(timer);
			if (writer.inTransaction) writer.exec("ROLLBACK");
			writer.close();
			await runtime.close();
			main.close();
			rmSync(directory, { recursive: true });
			expect(timerError).toBeUndefined();
		},
	};
}

describe("native SQLite read-proof contention recovery", () => {
	it.each([10, 35])(
		"admits once after a short %ims writer without blocking its release timer",
		async (ms) => {
			const f = await fixture();
			let released = false;
			let calls = 0;
			try {
				f.writer.exec("BEGIN EXCLUSIVE");
				f.after(ms, () => {
					f.writer.exec("ROLLBACK");
					released = true;
				});
				const result = await f.runtime.runOperation(async () => {
					calls++;
					expect(released).toBe(true);
					await assertRestoreRuntimeOperation(f.runtime);
					return 7;
				});
				expect(result).toBe(7);
				expect(calls).toBe(1);
				expect(f.losses).toEqual([]);
			} finally {
				await f.close();
			}
		},
	);

	it.each(["IMMEDIATE", "EXCLUSIVE"])(
		"keeps WAL reads available during a %s writer",
		async (lock) => {
			const f = await fixture("WAL");
			let calls = 0;
			try {
				f.writer.exec(`BEGIN ${lock}`);
				expect(await f.runtime.runOperation(() => ++calls)).toBe(1);
				expect(f.writer.inTransaction).toBe(true);
				expect(f.losses).toEqual([]);
			} finally {
				await f.close();
			}
		},
	);

	it("bounds persistent contention, never calls the operation, and preserves later same-actor recovery", async () => {
		const f = await fixture();
		let calls = 0;
		try {
			f.writer.exec("BEGIN EXCLUSIVE");
			const started = performance.now();
			await expect(f.runtime.runOperation(() => ++calls)).rejects.toMatchObject({
				statusCode: 503,
			});
			const elapsed = performance.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(90);
			expect(elapsed).toBeLessThan(1000);
			expect(calls).toBe(0);
			expect(f.losses).toEqual([]);
			f.writer.exec("ROLLBACK");
			expect(await f.runtime.runOperation(() => ++calls)).toBe(1);
		} finally {
			await f.close();
		}
	});

	it.each([10, 150])(
		"revalidates a changed runtime record after a %ims wait and remains permanently fenced",
		async (ms) => {
			const f = await fixture();
			let calls = 0;
			let changed!: () => void;
			const changedPromise = new Promise<void>((resolve) => {
				changed = resolve;
			});
			try {
				f.writer.exec("BEGIN EXCLUSIVE");
				f.after(ms, () => {
					f.writer.exec("ROLLBACK");
					f.main.exec(
						"UPDATE RestoreRuntimeControl SET runtimeEpoch='55555555-5555-4555-8555-555555555555'",
					);
					changed();
				});
				await expect(f.runtime.runOperation(() => ++calls)).rejects.toMatchObject({
					statusCode: 503,
				});
				// Exhaustion can refuse before the other actor changes its record.
				await changedPromise;
				await expect(f.runtime.runOperation(() => ++calls)).rejects.toMatchObject({
					statusCode: 503,
				});
				expect(f.losses).toEqual(["runtime-record-check-failed"]);
				expect(calls).toBe(0);
			} finally {
				await f.close();
			}
		},
	);

	it("revalidates native owner identity after a wait rather than using a cached proof", async () => {
		const f = await fixture();
		let calls = 0;
		try {
			f.writer.exec("BEGIN EXCLUSIVE");
			f.after(10, () => {
				f.writer.exec("ROLLBACK");
				renameSync(
					join(`${f.path}.arr-restore-runtime`, "operations.sqlite3"),
					join(`${f.path}.arr-restore-runtime`, "retained-operations.sqlite3"),
				);
			});
			await expect(f.runtime.runOperation(() => ++calls)).rejects.toMatchObject({
				statusCode: 503,
			});
			expect(f.losses).toEqual(["native-owner-unavailable"]);
			await expect(f.runtime.runOperation(() => ++calls)).rejects.toMatchObject({
				statusCode: 503,
			});
			expect(calls).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("drains an in-flight proof and refuses its callback if admission closes while waiting", async () => {
		const f = await fixture();
		let calls = 0;
		try {
			f.writer.exec("BEGIN EXCLUSIVE");
			const result = f.runtime
				.runOperation(() => ++calls)
				.then(
					() => "unexpected",
					() => "refused",
				);
			f.runtime.closeAdmission();
			let drained = false;
			const draining = f.runtime.drain().then(() => {
				drained = true;
			});
			await delay(10);
			expect(drained).toBe(false);
			f.writer.exec("ROLLBACK");
			expect(await result).toBe("refused");
			await draining;
			expect(calls).toBe(0);
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("preserves accepted nested work after admission closes without replaying the parent", async () => {
		const f = await fixture();
		let outer = 0;
		let nested = 0;
		try {
			const result = await f.runtime.runOperation(async () => {
				outer++;
				f.runtime.closeAdmission();
				f.writer.exec("BEGIN EXCLUSIVE");
				f.after(10, () => f.writer.exec("ROLLBACK"));
				return f.runtime.runOperation(() => ++nested);
			});
			expect(result).toBe(1);
			expect(outer).toBe(1);
			expect(nested).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("never retries a callback error after proof recovery", async () => {
		const f = await fixture();
		let calls = 0;
		const sentinel = new Error("synthetic callback failure");
		try {
			f.writer.exec("BEGIN EXCLUSIVE");
			f.after(10, () => f.writer.exec("ROLLBACK"));
			await expect(
				f.runtime.runOperation(() => {
					calls++;
					throw sentinel;
				}),
			).rejects.toBe(sentinel);
			expect(calls).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});
});
