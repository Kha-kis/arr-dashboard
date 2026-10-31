import { chmodSync, existsSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MessageChannel, Worker, type WorkerOptions } from "node:worker_threads";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	attachRestoreRuntimeWorker,
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	createRuntimeSessionMetadataPrismaClient,
} from "../restore-runtime-client.js";

const WRITE = "UPDATE BusyProbe SET value=value+1 WHERE id=1";
type Message = { category: string; [key: string]: unknown };

function removeOwnedFixture(directory: string, owned: { dev: bigint; ino: bigint }) {
	const current = lstatSync(directory, { bigint: true });
	if (current.dev !== owned.dev || current.ino !== owned.ino)
		throw new Error("Synthetic fixture ownership changed");
	rmSync(directory, { recursive: true, force: true });
}

// Workers are ready before the native boundary is reached. Only real SQLite
// contention blocks the parent; there are no fake timers or artificial stalls.
function actor(options: WorkerOptions) {
	const require = createRequire(import.meta.url);
	const worker = new Worker(
		`const {workerData}=require("node:worker_threads");
		(async()=>{const {register}=await import(workerData.tsx);register();
		await import(workerData.actor);})().catch(()=>{process.exitCode=1;});`,
		{
			eval: true,
			execArgv: [],
			env: {
				PATH: process.env.PATH,
				LANG: "C.UTF-8",
				TZ: "UTC",
				NODE_ENV: "test",
				DOTENV_CONFIG_PATH: "/dev/null",
			},
			...options,
			workerData: {
				...options.workerData,
				tsx: pathToFileURL(require.resolve("tsx/esm/api")).href,
				actor: new URL("./fixtures/restore-runtime-busy-yield-worker.ts", import.meta.url).href,
			},
		},
	);
	const messages: Message[] = [];
	let exited = false,
		workerError = false,
		watchdogFired = false;
	worker.on("error", () => {
		workerError = true;
	});
	worker.on("message", (message: Message) => messages.push(message));
	const exit = new Promise<number>((resolve) =>
		worker.once("exit", (code) => {
			exited = true;
			resolve(code);
		}),
	);
	const watchdog = setTimeout(() => {
		watchdogFired = true;
		void worker.terminate();
	}, 20000);
	const wait = async (category: string): Promise<Message> => {
		const existing = messages.find((message) => message.category === category);
		if (existing) return existing;
		if (exited) throw new Error(`Synthetic actor exited before ${category}`);
		return new Promise((resolve, reject) => {
			const onMessage = (message: Message) => {
				if (message.category === category) {
					cleanup();
					resolve(message);
				}
			};
			const onExit = () => {
				cleanup();
				reject(new Error(`Synthetic actor exited before ${category}`));
			};
			const cleanup = () => {
				worker.off("message", onMessage);
				worker.off("exit", onExit);
			};
			worker.on("message", onMessage);
			worker.once("exit", onExit);
		});
	};
	return {
		worker,
		wait,
		async close() {
			worker.postMessage("close");
			const code = await exit;
			clearTimeout(watchdog);
			return { exited, code, workerError, watchdogFired, messages };
		},
	};
}

describe("default guarded SQLite writes preserve real worker proof", () => {
	it.each([
		{ label: "unlocked control", contended: false, persistent: false, session: false },
		{ label: "proof releases writer", contended: true, persistent: false, session: false },
		{
			label: "persistent contention remains responsive",
			contended: true,
			persistent: true,
			session: false,
		},
		{
			label: "session metadata remains no-wait",
			contended: true,
			persistent: false,
			session: true,
		},
	])(
		"$label",
		async ({ label, contended, persistent, session }) => {
			const directory = mkdtempSync(
				join(process.env.ARR_BUSY_YIELD_FIXTURE_ROOT ?? tmpdir(), "arr-runtime-busy-yield-"),
			);
			chmodSync(directory, 0o700);
			const owned = lstatSync(directory, { bigint: true });
			const path = join(directory, "main.sqlite"),
				databaseUrl = `file:${path}`;
			const inspector = new Database(path, { timeout: 0 });
			chmodSync(path, 0o600);
			inspector.pragma("journal_mode=WAL");
			inspector.exec(`CREATE TABLE RestoreRuntimeControl (
			id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,phase TEXT NOT NULL,
			runtimeEpoch TEXT,ownerBackendPid INTEGER,activeRestoreId TEXT,lastCommittedRestoreId TEXT,
			lastCommittedAt DATETIME,destinationInstallationId TEXT);
			CREATE TABLE SqliteRestoreStorageBinding (
			id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,databaseDevice TEXT NOT NULL,
			databaseInode TEXT NOT NULL,directoryDevice TEXT NOT NULL,directoryInode TEXT NOT NULL,
			coordinationDevice TEXT NOT NULL,coordinationInode TEXT NOT NULL,ownerDevice TEXT NOT NULL,
			ownerInode TEXT NOT NULL,operationsDevice TEXT NOT NULL,operationsInode TEXT NOT NULL);
			CREATE TABLE BusyProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
			INSERT INTO BusyProbe VALUES(1,0);
			CREATE TABLE CommitProbe(value INTEGER NOT NULL);
			CREATE TRIGGER CountProbe AFTER UPDATE ON BusyProbe BEGIN INSERT INTO CommitProbe VALUES(new.value); END;`);
			const losses: unknown[] = [];
			const handles = new Set<Database.Database>([inspector]);
			const prepare = Database.prototype.prepare;
			let runtime: RestoreRuntime | undefined;
			let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
			let bridge: Awaited<ReturnType<typeof attachRestoreRuntimeWorker>> | undefined;
			let proof: ReturnType<typeof actor> | undefined, writer: ReturnType<typeof actor> | undefined;
			let proofResult: Message | undefined, proofClosure: unknown, writerClosure: unknown;
			let parentAccepted = false,
				callbackCalls = 0,
				nativeAttempts = 0,
				nativeMs = 0,
				writeMs = 0;
			let ticks = 0;
			let tick: ReturnType<typeof setInterval> | undefined;
			let nativeBoundaryReached = false,
				bridgeClosed = false,
				clientClosed = false,
				runtimeClosed = false;
			let before: unknown, after: unknown, committed: unknown, values: unknown;
			const release = new MessageChannel();
			Database.prototype.prepare = new Proxy(prepare, {
				apply(target, database: Database.Database, args: [string]) {
					handles.add(database);
					const statement: Database.Statement = Reflect.apply(target, database, args);
					if (database.name === path && args[0] === WRITE) {
						const run = statement.run;
						statement.run = function (...args: unknown[]) {
							nativeAttempts++;
							if (!nativeBoundaryReached) {
								nativeBoundaryReached = true;
								proof!.worker.postMessage("prove");
							}
							const started = performance.now();
							try {
								return Reflect.apply(run, this, args);
							} finally {
								nativeMs += performance.now() - started;
							}
						};
					}
					return statement;
				},
			});
			const snapshot = () => ({
				control: inspector.prepare("SELECT * FROM RestoreRuntimeControl").all(),
				binding: inspector.prepare("SELECT * FROM SqliteRestoreStorageBinding").all(),
				journal: inspector.pragma("journal_mode", { simple: true }),
			});
			try {
				runtime = await openRestoreRuntime({
					databaseUrl,
					onUnavailable: (event) => losses.push(event),
				});
				await runtime.bindDestination("synthetic-destination");
				await runtime.activate();
				client = session
					? createRuntimeSessionMetadataPrismaClient(runtime)
					: createRuntimePrismaClient(runtime);
				before = snapshot();
				await runtime.runOperation(async () => {
					callbackCalls++;
					bridge = await attachRestoreRuntimeWorker(databaseUrl);
					proof = actor({
						workerData: {
							role: "proof",
							databaseUrl,
							binding: bridge.binding,
							releasePort: release.port1,
						},
						transferList: [bridge.binding.port, release.port1],
					});
					writer = actor({
						workerData: {
							role: "writer",
							path,
							contended,
							holdUntilClose: persistent,
							releasePort: release.port2,
						},
						transferList: [release.port2],
					});
					await proof.wait("ready");
					expect((await writer.wait("ready")).locked).toBe(contended);
					const started = performance.now();
					tick = setInterval(() => {
						ticks++;
					}, 10);
					try {
						await client!.prisma.$executeRawUnsafe(WRITE);
						parentAccepted = true;
					} catch {
						/* Keep the real failure as regression evidence, then close everything. */
					} finally {
						writeMs = performance.now() - started;
						clearInterval(tick);
					}
					proofResult = await proof.wait("operation");
					// Closing the proof first joins its loss/released messages before bridge close.
					proofClosure = await proof.close();
					writerClosure = await writer.close();
				});
			} finally {
				clearInterval(tick);
				if (proof && !proofClosure) proofClosure = await proof.close();
				if (writer && !writerClosure) writerClosure = await writer.close();
				release.port1.close();
				release.port2.close();
				if (bridge) {
					await bridge.close();
					bridgeClosed = true;
				}
				if (client) {
					await client.close();
					clientClosed = true;
				}
				if (runtime) {
					await runtime.close();
					runtimeClosed = true;
				}
				after = snapshot();
				committed = inspector.prepare("SELECT * FROM CommitProbe").all();
				values = inspector.prepare("SELECT * FROM BusyProbe").all();
				if (inspector.inTransaction) inspector.exec("ROLLBACK");
				inspector.close();
				Database.prototype.prepare = prepare;
				removeOwnedFixture(directory, owned);
			}
			const evidence = {
				label,
				persistent,
				session,
				ticks,
				contended,
				nativeBoundaryReached,
				nativeAttempts,
				nativeMs,
				writeMs,
				parentAccepted,
				callbackCalls,
				proofResult,
				losses,
				proofClosure,
				writerClosure,
				bridgeClosed,
				clientClosed,
				runtimeClosed,
				parentNativeHandlesClosed: [...handles].every((database) => !database.open),
				fixtureRemoved: !existsSync(directory),
				stateUnchanged: JSON.stringify(before) === JSON.stringify(after),
				committed,
				values,
			};
			process.stdout.write(`BUSY_YIELD_EVIDENCE ${JSON.stringify(evidence)}\n`);
			expect(evidence.parentNativeHandlesClosed).toBe(true);
			expect(evidence.fixtureRemoved).toBe(true);
			expect(proofClosure).toMatchObject({
				exited: true,
				code: 0,
				workerError: false,
				watchdogFired: false,
			});
			expect(writerClosure).toMatchObject({
				exited: true,
				code: 0,
				workerError: false,
				watchdogFired: false,
				messages: expect.arrayContaining([
					expect.objectContaining({ category: "closed", nativeClosed: true }),
				]),
			});
			expect(bridgeClosed && clientClosed && runtimeClosed).toBe(true);
			expect(nativeBoundaryReached).toBe(true);
			expect(callbackCalls).toBe(1);
			expect(after).toEqual(before);
			// These are the desired contract, including retaining the parent's write.
			// A no-wait rejection alone cannot satisfy the regression.
			expect.soft(proofResult).toMatchObject({ accepted: true, callbackCalls: 1 });
			const expectedWrite = !persistent && !session;
			expect.soft(parentAccepted).toBe(expectedWrite);
			expect.soft(losses).toEqual([]);
			expect.soft(values).toEqual([{ id: 1, value: expectedWrite ? 1 : 0 }]);
			expect.soft(committed).toEqual(expectedWrite ? [{ value: 1 }] : []);
			expect.soft(writeMs).toBeLessThan(5500);
			if (persistent) {
				expect(writeMs).toBeGreaterThanOrEqual(4900);
				expect(ticks).toBeGreaterThan(10);
			}
			if (session) {
				expect(writeMs).toBeLessThan(1000);
				expect(nativeAttempts).toBe(1);
			}
		},
		30000,
	);
});

type FencedFixture = {
	path: string;
	writer: Database.Database;
	runtime: RestoreRuntime;
	client: ReturnType<typeof createRuntimePrismaClient>;
	atWrite: Promise<void>;
	handles: Set<Database.Database>;
	losses: unknown[];
	attempts(): number;
};

async function withFencedFixture(
	run: (fixture: FencedFixture) => Promise<void>,
	journal: "WAL" | "DELETE" = "WAL",
) {
	const directory = mkdtempSync(
		join(process.env.ARR_BUSY_YIELD_FIXTURE_ROOT ?? tmpdir(), "arr-runtime-busy-fence-"),
	);
	chmodSync(directory, 0o700);
	const owned = lstatSync(directory, { bigint: true });
	const path = join(directory, "main.sqlite"),
		databaseUrl = `file:${path}`;
	const writer = new Database(path, { timeout: 0 });
	chmodSync(path, 0o600);
	writer.pragma(`journal_mode=${journal}`);
	writer.exec(`CREATE TABLE RestoreRuntimeControl (
		id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,phase TEXT NOT NULL,
		runtimeEpoch TEXT,ownerBackendPid INTEGER,activeRestoreId TEXT,lastCommittedRestoreId TEXT,
		lastCommittedAt DATETIME,destinationInstallationId TEXT);
		CREATE TABLE SqliteRestoreStorageBinding (
		id INTEGER PRIMARY KEY,protocolVersion INTEGER NOT NULL,databaseDevice TEXT NOT NULL,
		databaseInode TEXT NOT NULL,directoryDevice TEXT NOT NULL,directoryInode TEXT NOT NULL,
		coordinationDevice TEXT NOT NULL,coordinationInode TEXT NOT NULL,ownerDevice TEXT NOT NULL,
		ownerInode TEXT NOT NULL,operationsDevice TEXT NOT NULL,operationsInode TEXT NOT NULL);
		CREATE TABLE BusyProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
		INSERT INTO BusyProbe VALUES(1,0);
		CREATE TABLE CommitProbe(value INTEGER NOT NULL);
		CREATE TRIGGER CountProbe AFTER UPDATE ON BusyProbe BEGIN INSERT INTO CommitProbe VALUES(new.value); END;`);
	const handles = new Set<Database.Database>([writer]),
		losses: unknown[] = [];
	const prepare = Database.prototype.prepare;
	let attempts = 0,
		notifyWrite!: () => void;
	const atWrite = new Promise<void>((resolve) => {
		notifyWrite = resolve;
	});
	Database.prototype.prepare = new Proxy(prepare, {
		apply(target, database: Database.Database, args: [string]) {
			handles.add(database);
			const statement: Database.Statement = Reflect.apply(target, database, args);
			if (database.name === path && args[0] === WRITE) {
				const execute = statement.run;
				statement.run = function (...args: unknown[]) {
					attempts++;
					notifyWrite();
					return Reflect.apply(execute, this, args);
				};
			}
			return statement;
		},
	});
	let runtime: RestoreRuntime | undefined,
		client: ReturnType<typeof createRuntimePrismaClient> | undefined;
	try {
		runtime = await openRestoreRuntime({
			databaseUrl,
			onUnavailable: (event) => losses.push(event),
		});
		await runtime.bindDestination("synthetic-destination");
		await runtime.activate();
		client = createRuntimePrismaClient(runtime);
		await runtime.runOperation(() => client!.prisma.$connect());
		await run({
			path,
			writer,
			runtime,
			client,
			atWrite,
			handles,
			losses,
			attempts: () => attempts,
		});
	} finally {
		if (writer.inTransaction) writer.exec("ROLLBACK");
		await client?.close();
		await runtime?.close();
		writer.close();
		Database.prototype.prepare = prepare;
		expect([...handles].every((database) => !database.open)).toBe(true);
		removeOwnedFixture(directory, owned);
	}
}

describe("yielded statements retain their original admission and native lifetime", () => {
	it.each([false, true])(
		"ordinary work waits outside another transaction (commit=%s)",
		async (commit) => {
			await withFencedFixture(async ({ runtime, client, writer, losses }) => {
				let release!: () => void, ready!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const entered = new Promise<void>((resolve) => {
					ready = resolve;
				});
				const transaction = runtime
					.runOperation(() =>
						client.prisma.$transaction(async (tx) => {
							await tx.$executeRawUnsafe(WRITE);
							ready();
							await gate;
							if (!commit) throw new Error("Synthetic rollback");
						}),
					)
					.then(
						() => true,
						() => false,
					);
				await entered;
				const ordinary = runtime
					.runOperation(async () => {
						const rows = await client.prisma.$queryRawUnsafe<Array<{ value: number }>>(
							"SELECT value FROM BusyProbe WHERE id=1",
						);
						await client.prisma.$executeRawUnsafe(WRITE);
						return rows;
					})
					.then(
						(rows) => ({ accepted: true, rows }),
						() => ({ accepted: false, rows: [] }),
					);
				try {
					expect
						.soft(await Promise.race([ordinary.then(() => "settled"), delay(50, "waiting")]))
						.toBe("waiting");
				} finally {
					release();
				}
				expect(await transaction).toBe(commit);
				expect.soft(await ordinary).toEqual({ accepted: true, rows: [{ value: commit ? 1 : 0 }] });
				expect(writer.prepare("SELECT value FROM BusyProbe WHERE id=1").all()).toEqual([
					{ value: commit ? 2 : 1 },
				]);
				expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual(
					commit ? [{ value: 1 }, { value: 2 }] : [{ value: 1 }],
				);
				expect(losses).toEqual([]);
			});
		},
	);

	it("ordinary work waiting outside a transaction cannot borrow a later ticket", async () => {
		await withFencedFixture(async ({ runtime, client, writer, losses }) => {
			let release!: () => void, ready!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const transaction = runtime.runOperation(() =>
				client.prisma.$transaction(async () => {
					ready();
					await gate;
				}),
			);
			await entered;
			let pending!: Promise<boolean>;
			try {
				await runtime.runOperation(async () => {
					pending = Promise.resolve(client.prisma.$executeRawUnsafe(WRITE)).then(
						() => true,
						() => false,
					);
					expect
						.soft(await Promise.race([pending.then(() => "settled"), delay(50, "waiting")]))
						.toBe("waiting");
				});
			} finally {
				release();
			}
			await transaction;
			await runtime.runOperation(async () => {
				expect(await pending).toBe(false);
				expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([]);
				await client.prisma.$executeRawUnsafe(WRITE);
			});
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		});
	});

	it("ordinary work waiting outside a transaction stops after ownership loss", async () => {
		await withFencedFixture(async ({ runtime, client, writer, handles, losses }) => {
			let release!: () => void, ready!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const transaction = runtime
				.runOperation(() =>
					client.prisma.$transaction(async () => {
						ready();
						await gate;
					}),
				)
				.then(
					() => true,
					() => false,
				);
			await entered;
			const ordinary = runtime
				.runOperation(() => client.prisma.$executeRawUnsafe(WRITE))
				.then(
					() => true,
					() => false,
				);
			try {
				expect
					.soft(await Promise.race([ordinary.then(() => "settled"), delay(50, "waiting")]))
					.toBe("waiting");
				const owner = [...handles].find(
					(database) =>
						database.open && database.inTransaction && database.name.endsWith("/owner.sqlite3"),
				);
				expect(owner).toBeDefined();
				owner!.exec("ROLLBACK");
				expect(await ordinary).toBe(false);
			} finally {
				release();
			}
			await transaction;
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([]);
			expect(losses).toHaveLength(1);
		});
	});

	it("ordinary work waiting outside a transaction has a finite deadline without late SQL", async () => {
		await withFencedFixture(async ({ runtime, client, writer, losses }) => {
			let release!: () => void, ready!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const transaction = runtime.runOperation(() =>
				client.prisma.$transaction(
					async () => {
						ready();
						await gate;
					},
					{ timeout: 10000 },
				),
			);
			await entered;
			const began = performance.now();
			try {
				await expect(
					runtime.runOperation(() => client.prisma.$executeRawUnsafe(WRITE)),
				).rejects.toBeDefined();
				expect.soft(performance.now() - began).toBeGreaterThanOrEqual(4900);
				expect.soft(performance.now() - began).toBeLessThan(6000);
				expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([]);
			} finally {
				release();
			}
			await transaction;
			await runtime.runOperation(() => client.prisma.$executeRawUnsafe(WRITE));
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		});
	}, 15000);

	it("shorter explicit Prisma maxWait cancellation leaves no late transaction while its original runtime ticket stays active", async () => {
		await withFencedFixture(async ({ writer, runtime, client, handles, path, losses }) => {
			await client.close();
			const reserved = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
			let initialCalls = 0;
			try {
				await runtime.runOperation(async () => {
					const originalTicket = getRestoreRuntimeClientContext(runtime).captureTicket();
					writer.exec("BEGIN IMMEDIATE");
					const started = performance.now();
					const initialError = await reserved.prisma
						.$transaction(
							async (tx) => {
								initialCalls++;
								await tx.$executeRawUnsafe(WRITE);
							},
							{ maxWait: 250, timeout: 20000 },
						)
						.then(
							() => undefined,
							(error) => error,
						);
					expect(initialError).toMatchObject({ code: "P2028" });
					originalTicket();
					expect(performance.now() - started).toBeGreaterThanOrEqual(200);
					expect(performance.now() - started).toBeLessThan(4000);
					// The very same enclosing admission ticket is intentionally alive.
					// Release before the native reservation's one-second deadline.
					writer.exec("ROLLBACK");
					expect(initialCalls).toBe(0);
					originalTicket();
					expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([]);
					await reserved.prisma.$transaction(
						async (tx) => {
							await tx.$executeRawUnsafe(WRITE);
						},
						{ maxWait: 1000 },
					);
					expect(initialCalls).toBe(0);
					expect(
						[...handles]
							.filter((database) => database.open && database.name === path)
							.every((database) => !database.inTransaction),
					).toBe(true);
				});
				expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
				expect(losses).toEqual([]);
			} finally {
				await reserved.close();
			}
		});
	}, 15000);

	it("yielding opt-in reservation precedes every main-file transaction snapshot", async () => {
		await withFencedFixture(async ({ writer, runtime, client, losses }) => {
			await client.close();
			const reserved = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
			const before = [
				writer.prepare("SELECT * FROM RestoreRuntimeControl").all(),
				writer.prepare("SELECT * FROM SqliteRestoreStorageBinding").all(),
			];
			writer.exec("BEGIN IMMEDIATE; UPDATE BusyProbe SET value=99 WHERE id=1");
			let released = false,
				calls = 0;
			const timer = setTimeout(() => {
				writer.exec("COMMIT");
				released = true;
			}, 40);
			try {
				await runtime.runOperation(() =>
					reserved.prisma.$transaction(async (tx) => {
						calls++;
						expect(released).toBe(true);
						await tx.$executeRawUnsafe(WRITE);
					}),
				);
			} finally {
				clearTimeout(timer);
				await reserved.close();
			}
			expect(calls).toBe(1);
			expect(writer.prepare("SELECT * FROM BusyProbe").all()).toEqual([{ id: 1, value: 100 }]);
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([
				{ value: 99 },
				{ value: 100 },
			]);
			expect([
				writer.prepare("SELECT * FROM RestoreRuntimeControl").all(),
				writer.prepare("SELECT * FROM SqliteRestoreStorageBinding").all(),
			]).toEqual(before);
			expect(losses).toEqual([]);
		});
	});

	it("a busy guard read refuses without recursive waits or leaking a later transaction's mutex", async () => {
		await withFencedFixture(async ({ writer, runtime, client, losses, attempts }) => {
			await runtime.runOperation(async () => {
				writer.exec("BEGIN EXCLUSIVE");
				const started = performance.now();
				await expect(client.prisma.$executeRawUnsafe(WRITE)).rejects.toBeDefined();
				expect(performance.now() - started).toBeLessThan(1000);
				expect(attempts()).toBe(0);
				writer.exec("ROLLBACK");
				await client.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe(WRITE);
				});
			});
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		}, "DELETE");
	});

	it.each(["journal", "binding", "owner", "participation", "storage"] as const)(
		"real %s loss during contention prevents a later autocommit mutation",
		async (kind) => {
			await withFencedFixture(
				async ({ path, writer, runtime, client, atWrite, handles, losses, attempts }) => {
					writer.exec("BEGIN IMMEDIATE");
					const pending = runtime
						.runOperation(() => client.prisma.$executeRawUnsafe(WRITE))
						.then(
							() => true,
							() => false,
						);
					await atWrite;
					if (kind === "journal") writer.exec("UPDATE RestoreRuntimeControl SET phase='invalid'");
					if (kind === "binding") writer.exec("DELETE FROM SqliteRestoreStorageBinding");
					if (kind === "owner" || kind === "participation") {
						const suffix = kind === "owner" ? "/owner.sqlite3" : "/operations.sqlite3";
						const held = [...handles].find(
							(database) =>
								database.open && database.inTransaction && database.name.endsWith(suffix),
						);
						expect(held).toBeDefined();
						held!.exec("ROLLBACK");
					}
					if (kind === "storage")
						renameSync(
							`${path}.arr-restore-runtime/operations.sqlite3`,
							`${path}.arr-restore-runtime/operations-moved.sqlite3`,
						);
					writer.exec("COMMIT");
					expect(await pending).toBe(false);
					expect(attempts()).toBe(1);
					expect(writer.prepare("SELECT * FROM BusyProbe").all()).toEqual([{ id: 1, value: 0 }]);
					expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([]);
					expect(losses).toHaveLength(1);
					await expect(runtime.runOperation(() => true)).rejects.toMatchObject({ statusCode: 503 });
				},
			);
		},
	);

	it("an ended original ticket cannot borrow a later operation's authority", async () => {
		await withFencedFixture(async ({ writer, runtime, client, atWrite, losses, attempts }) => {
			writer.exec("BEGIN IMMEDIATE");
			let pending!: Promise<boolean>;
			await runtime.runOperation(async () => {
				pending = Promise.resolve(client.prisma.$executeRawUnsafe(WRITE)).then(
					() => true,
					() => false,
				);
				await atWrite;
			});
			writer.exec("ROLLBACK");
			await runtime.runOperation(async () => {
				expect(await pending).toBe(false);
				expect(attempts()).toBe(1);
				await client.prisma.$executeRawUnsafe(WRITE);
			});
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		});
	});

	it("a waiting autocommit statement cannot run inside another native transaction", async () => {
		await withFencedFixture(async ({ writer, runtime, client, atWrite, losses }) => {
			writer.exec("BEGIN IMMEDIATE");
			await runtime.runOperation(async () => {
				const pending = Promise.resolve(client.prisma.$executeRawUnsafe(WRITE)).then(
					() => true,
					() => false,
				);
				await atWrite;
				let notifyReady!: () => void, allowWrite!: () => void;
				const ready = new Promise<void>((resolve) => {
					notifyReady = resolve;
				});
				const gate = new Promise<void>((resolve) => {
					allowWrite = resolve;
				});
				const transaction = client.prisma.$transaction(async (tx) => {
					notifyReady();
					await gate;
					await tx.$executeRawUnsafe(WRITE);
				});
				await ready;
				try {
					expect(await pending).toBe(false);
				} finally {
					writer.exec("ROLLBACK");
					allowWrite();
				}
				await transaction;
			});
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		});
	});

	it("a real interactive timeout rolls back before delayed SQL and the driver remains reusable", async () => {
		await withFencedFixture(async ({ writer, runtime, client, atWrite, losses }) => {
			writer.exec("BEGIN IMMEDIATE");
			await runtime.runOperation(async () => {
				let calls = 0,
					pending!: Promise<boolean>;
				const transaction = Promise.resolve(
					client.prisma.$transaction(
						async (tx) => {
							calls++;
							pending = Promise.resolve(tx.$executeRawUnsafe(WRITE)).then(
								() => true,
								() => false,
							);
							await pending;
						},
						{ timeout: 50 },
					),
				).then(
					() => true,
					() => false,
				);
				await atWrite;
				expect(await transaction).toBe(false);
				expect(await pending).toBe(false);
				writer.exec("ROLLBACK");
				await client.prisma.$transaction(async (tx) => {
					await tx.$executeRawUnsafe(WRITE);
				});
				expect(calls).toBe(1);
			});
			expect(writer.prepare("SELECT * FROM CommitProbe").all()).toEqual([{ value: 1 }]);
			expect(losses).toEqual([]);
		});
	});
});
