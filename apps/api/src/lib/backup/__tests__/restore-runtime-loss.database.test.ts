import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachRestoreRuntimeWorker,
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../restore-runtime-admission.js";
import { recordRestoreRuntimeWorkerLoss } from "../restore-runtime-loss.js";

// These tests catch discarded/overwritten first-loss diagnostics and accidental
// changes to actual native admission, using no live database or provider data.
describe("native runtime first-loss diagnostics", () => {
	let directory: string;
	let databaseUrl: string;
	const runtimes: RestoreRuntime[] = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-runtime-loss-"));
		const path = join(directory, "main.sqlite");
		databaseUrl = `file:${path}`;
		const db = new Database(path);
		db.pragma("journal_mode=WAL");
		db.exec(`CREATE TABLE RestoreRuntimeControl (
			id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,phase TEXT NOT NULL,
			runtimeEpoch TEXT,ownerBackendPid INTEGER,activeRestoreId TEXT,lastCommittedRestoreId TEXT,
			lastCommittedAt DATETIME,destinationInstallationId TEXT);
			CREATE TABLE SqliteRestoreStorageBinding (
			id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,databaseDevice TEXT NOT NULL,
			databaseInode TEXT NOT NULL,directoryDevice TEXT NOT NULL,directoryInode TEXT NOT NULL,
			coordinationDevice TEXT NOT NULL,coordinationInode TEXT NOT NULL,ownerDevice TEXT NOT NULL,
			ownerInode TEXT NOT NULL,operationsDevice TEXT NOT NULL,operationsInode TEXT NOT NULL);
			CREATE TABLE TimeoutProbe(value INTEGER NOT NULL);`);
		db.close();
		chmodSync(path, 0o600);
	});
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		rmSync(directory, { recursive: true, force: true });
	});
	async function open(onUnavailable: (...args: unknown[]) => void) {
		const runtime = await openRestoreRuntime({ databaseUrl, onUnavailable });
		runtimes.push(runtime);
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
		return runtime;
	}

	it("retains the first generic reason once while every later operation stays denied", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		const context = getRestoreRuntimeClientContext(runtime);
		context.unavailable("client-invalid-journal");
		context.unavailable("worker-channel-unavailable");
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(events).toEqual([
			{ reason: "client-invalid-journal", runtimeAgeMs: expect.any(Number) },
		]);
		const age = (events[0] as { runtimeAgeMs: number }).runtimeAgeMs;
		expect(Number.isSafeInteger(age) && age >= 0).toBe(true);
	});

	it("reports a real journal mismatch without exporting the invalid journal", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		const db = new Database(databaseUrl.slice(5));
		db.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch=?").run("PRIVATE_SENTINEL");
		db.close();
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(events).toEqual([
			{ reason: "runtime-record-check-failed", runtimeAgeMs: expect.any(Number) },
		]);
		expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
	});

	it("identifies an invalid binding and still fences all operations", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		const context = getRestoreRuntimeClientContext(runtime);
		expect(() => context.validateSqliteBinding({ privateValue: "PRIVATE_SENTINEL" })).toThrow();
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(events).toEqual([
			{ reason: "storage-binding-invalid", runtimeAgeMs: expect.any(Number) },
		]);
		expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
	});

	it("does not emit any loss event for successful admitted work", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		await expect(runtime.runOperation(() => 7)).resolves.toBe(7);
		expect(events).toEqual([]);
	});

	it.each([
		"control",
		"parent-stall",
		"owner-proof-control",
		"owner-proof-stall",
		"owner-proof-terminated",
		"initial-proof-stall",
		"true-loss",
		"journal-changed",
	] as const)(
		"a real follower isolates proof timeout while preserving independent owner checks after %s",
		async (mode) => {
			const events: unknown[] = [];
			const runtime = await open((event) => events.push(event));
			const require = createRequire(import.meta.url);
			const tsx = pathToFileURL(require.resolve("tsx/esm/api")).href;
			const actor = new URL("./fixtures/restore-runtime-proof-timeout-worker.ts", import.meta.url);
			const bootstrap = `const {workerData}=require("node:worker_threads");
				(async()=>{const {register}=await import(workerData.tsx);register();
				await import(workerData.actor);})().catch(()=>{process.exitCode=1;});`;
			async function runFollower(selected: typeof mode) {
				const messages: Array<{ category: string; accepted?: boolean }> = [];
				let exited = false;
				let failed = false;
				let watchdogFired = false;
				await runtime.runOperation(async () => {
					const bridge = await attachRestoreRuntimeWorker(databaseUrl);
					const worker = new Worker(bootstrap, {
						eval: true,
						workerData: {
							tsx,
							actor: actor.href,
							binding: bridge.binding,
							databaseUrl,
							ownerOnly: selected.startsWith("owner-proof-"),
							initialProof: selected === "initial-proof-stall",
						},
						transferList: [bridge.binding.port],
						execArgv: [],
						env: {
							PATH: process.env.PATH,
							LANG: "C.UTF-8",
							TZ: "UTC",
							NODE_ENV: "test",
							DOTENV_CONFIG_PATH: "/dev/null",
						},
					});
					let localLossCount = 0;
					const unsubscribe = bridge.onUnavailable(() => {
						localLossCount++;
						if (selected === "owner-proof-terminated") void worker.terminate();
					});
					const exit = new Promise<number>((resolve) => {
						worker.once("exit", (code) => {
							exited = true;
							resolve(code);
						});
					});
					worker.on("error", () => {
						failed = true;
					});
					worker.on("message", (message: { category: string; accepted?: boolean }) => {
						messages.push(message);
						if (message.category === "ready") worker.postMessage("prove");
						if (message.category === "proof-imminent") {
							if (selected === "true-loss")
								getRestoreRuntimeClientContext(runtime).unavailable("storage-binding-invalid");
							if (selected === "journal-changed") {
								const db = new Database(databaseUrl.slice(5));
								db.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch=?").run(
									"synthetic-changed-epoch",
								);
								db.close();
							}
							worker.postMessage("continue-proof");
							// Stall only this disposable test's parent. The real child's
							// unchanged five-second proof timer must expire independently.
							if (selected !== "control" && selected !== "owner-proof-control")
								Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
						}
						if (message.category === "operation") {
							worker.postMessage("close");
						}
					});
					const watchdog = setTimeout(() => {
						watchdogFired = true;
						void worker.terminate();
					}, 12000);
					try {
						expect(await exit).toBe(selected === "owner-proof-terminated" ? 1 : 0);
					} finally {
						clearTimeout(watchdog);
						if (!exited) await worker.terminate();
						await exit;
						unsubscribe();
						await bridge.close();
					}
					if (selected === "owner-proof-terminated") expect(localLossCount).toBe(1);
				});
				expect(exited).toBe(true);
				expect(failed).toBe(false);
				expect(watchdogFired).toBe(false);
				const accepted = selected === "control" || selected === "owner-proof-control";
				if (selected === "owner-proof-terminated") {
					expect(messages.some((message) => message.accepted === true)).toBe(false);
				} else {
					expect(messages).toContainEqual({ category: "closed" });
					expect(messages).toContainEqual({ category: "operation", accepted });
					expect(messages).toContainEqual({ category: "reuse", accepted });
				}
			}
			await runFollower(mode);
			// The expired follower's work is still denied. It did not disprove
			// this independent owner's native lock, binding, or current journal.
			if (mode === "true-loss" || mode === "journal-changed") {
				await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
					statusCode: 503,
				});
				expect(events).toEqual([
					{
						reason:
							mode === "true-loss" ? "storage-binding-invalid" : "runtime-record-check-failed",
						runtimeAgeMs: expect.any(Number),
					},
				]);
			} else {
				expect(events).toEqual([]);
				await expect(runtime.runOperation(() => 7)).resolves.toBe(7);
				if (mode !== "control" && mode !== "owner-proof-control") await runFollower("control");
				expect(events).toEqual([]);
			}
			const db = new Database(databaseUrl.slice(5), { readonly: true });
			try {
				expect(db.prepare("SELECT COUNT(*) AS count FROM TimeoutProbe").get()).toEqual({
					count: mode === "owner-proof-control" ? 1 : 0,
				});
			} finally {
				db.close();
			}
			await expect(runtime.close()).resolves.toBeUndefined();
		},
		20000,
	);

	it("does not quarantine a timeout fence with an invalid proof sequence", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		await runtime.runOperation(async () => {
			const bridge = await attachRestoreRuntimeWorker(databaseUrl);
			try {
				const unavailable = new Promise<void>((resolve) => bridge.onUnavailable(resolve));
				const words = new Int32Array(bridge.binding.fence);
				Atomics.store(words, 1, 2);
				recordRestoreRuntimeWorkerLoss(words, "worker-proof-timeout");
				bridge.binding.port.postMessage({ kind: "proof", id: 1 });
				await unavailable;
			} finally {
				await bridge.close();
			}
		});
		expect(events).toEqual([{ reason: "worker-proof-timeout", runtimeAgeMs: expect.any(Number) }]);
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
	});

	it("native error-event callbacks remain compatible without retaining their Error argument", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		const context = getRestoreRuntimeClientContext(runtime);
		const emitter = new EventEmitter();
		emitter.on("error", context.unavailable);
		emitter.emit("error", new Error("PRIVATE_SENTINEL"));
		expect(events).toEqual([{ reason: "runtime-unavailable", runtimeAgeMs: expect.any(Number) }]);
		expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
	});

	it("a loss listener cannot overwrite the original reason with a cascading channel failure", async () => {
		const events: unknown[] = [];
		const runtime = await open((event) => events.push(event));
		const context = getRestoreRuntimeClientContext(runtime);
		await runtime.runOperation(async () => {
			const bridge = await attachRestoreRuntimeWorker(databaseUrl);
			try {
				bridge.onUnavailable(() => context.unavailable("worker-channel-unavailable"));
				context.unavailable("transaction-cleanup-failed");
			} finally {
				await bridge.close();
			}
		});
		expect(events).toEqual([
			{ reason: "transaction-cleanup-failed", runtimeAgeMs: expect.any(Number) },
		]);
	});

	it("a throwing diagnostic observer cannot change fencing or closure", async () => {
		const runtime = await open(() => {
			throw new Error("synthetic observer error");
		});
		const context = getRestoreRuntimeClientContext(runtime);
		expect(() => context.unavailable("client-close-failed")).not.toThrow();
		await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
			statusCode: 503,
		});
		await expect(runtime.close()).resolves.toBeUndefined();
	});

	it.each([
		["worker-proof-timeout", "worker-proof-timeout"],
		["PRIVATE_SENTINEL", "runtime-unavailable"],
	])(
		"sanitizes worker-reported loss %s at the actual MessagePort boundary",
		async (sent, expected) => {
			const events: unknown[] = [];
			const runtime = await open((event) => events.push(event));
			await runtime.runOperation(async () => {
				const bridge = await attachRestoreRuntimeWorker(databaseUrl);
				try {
					const unavailable = new Promise<void>((resolve) => bridge.onUnavailable(resolve));
					bridge.binding.port.postMessage({
						kind: "unavailable",
						reason: sent,
						secret: "PRIVATE_SENTINEL",
					});
					await unavailable;
				} finally {
					await bridge.close();
				}
			});
			expect(events).toEqual([{ reason: expected, runtimeAgeMs: expect.any(Number) }]);
			expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
			await expect(runtime.runOperation(() => "must-not-run")).rejects.toMatchObject({
				statusCode: 503,
			});
		},
	);
});
