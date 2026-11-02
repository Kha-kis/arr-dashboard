import { type ChildProcess, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	assertRestoreRuntimeOperation,
	attachRestoreRuntimeWorker,
	getRestoreRuntimeClientContext,
	getRestoreRuntimeShutdownStatus,
	openRestoreRuntime,
	openRestoreRuntimeWorker,
	retainRestoreRuntimeOperation,
	type RestoreRuntime,
} from "../restore-runtime-admission.js";
import { acquirePostgresRestoreRuntimeOwnership } from "../restore-runtime-postgres.js";
import {
	acquireSqliteRestoreOperationLock,
	acquireSqliteRestoreRuntimeOwnership,
} from "../restore-runtime-sqlite.js";
import * as enrollment from "../restore-runtime-sqlite-enrollment.js";
import {
	enrollSqliteRestoreRuntimeStorage,
	type SqliteRestoreRuntimeEnrollment,
	SqliteRestoreRuntimeEnrollmentError,
} from "../restore-runtime-sqlite-enrollment.js";

const OLD_EPOCH = "11111111-1111-4111-8111-111111111111";
const EPOCH = "44444444-4444-4444-8444-444444444444";
const RESTORE = "22222222-2222-4222-8222-222222222222";
const MARKER = "33333333-3333-4333-8333-333333333333";
const TIME = "2026-10-07T12:00:00.000Z";

describe("native SQLite starting admission enrollment", () => {
	let directory: string;
	let url: string;
	let main: Database.Database;
	const held: SqliteRestoreRuntimeEnrollment[] = [];
	const actors: { child: ChildProcess; exit: Promise<void> }[] = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-starting-"));
		const path = join(directory, "main.db");
		url = `file:${path}`;
		main = new Database(path);
		main.pragma("journal_mode = WAL");
		main.exec(`CREATE TABLE Marker(value INTEGER); INSERT INTO Marker VALUES(7);
			CREATE TABLE RestoreRuntimeControl (
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
		chmodSync(path, 0o600);
	});
	afterEach(async () => {
		for (const actor of actors.splice(0)) {
			if (actor.child.exitCode === null && actor.child.signalCode === null)
				actor.child.kill("SIGKILL");
			await actor.exit;
		}
		for (const result of held.splice(0)) await result.ownership.close();
		if (main.open) main.close();
		rmSync(directory, { recursive: true, force: true });
	});
	// Exercise the actual boundary, including runtime-invalid inputs, without
	// weakening the production signature or replacing its native implementation.
	async function start(options: unknown = { runtimeEpoch: EPOCH }) {
		const result = (await Reflect.apply(enrollSqliteRestoreRuntimeStorage, undefined, [
			url,
			options,
		])) as SqliteRestoreRuntimeEnrollment;
		held.push(result);
		return result;
	}
	const journal = () => main.prepare("SELECT * FROM RestoreRuntimeControl").all();
	const binding = () => main.prepare("SELECT * FROM SqliteRestoreStorageBinding").all();
	const unchangedData = () =>
		expect(main.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
	const refuse = async (work: Promise<unknown>) => {
		await expect(work).rejects.toMatchObject({
			name: "SqliteRestoreRuntimeEnrollmentError",
			statusCode: 503,
		});
	};
	async function seedPrior(phase: string, active: string | null = null, marker: string = MARKER) {
		const first = await enrollSqliteRestoreRuntimeStorage(url);
		held.push(first);
		await first.ownership.close();
		main
			.prepare("INSERT INTO RestoreRuntimeControl VALUES (1,1,?,?,?,?,?,?,?)")
			.run(
				phase,
				phase === "idle" ? null : OLD_EPOCH,
				null,
				active,
				marker,
				Date.parse(TIME),
				"fixture-destination",
			);
	}

	it("commits initial starting journal with its binding and retains native exclusion", async () => {
		const result = await start();
		expect(journal()).toEqual([
			{
				id: 1,
				protocolVersion: 1,
				phase: "starting",
				runtimeEpoch: EPOCH,
				ownerBackendPid: null,
				activeRestoreId: null,
				lastCommittedRestoreId: null,
				lastCommittedAt: null,
				destinationInstallationId: null,
			},
		]);
		expect(binding()).toHaveLength(1);
		await result.ownership.assertOwned();
		await expect(acquireSqliteRestoreOperationLock(url)).rejects.toBeDefined();
		unchangedData();
	});

	it.each([
		{ kind: "proof", mode: "settled-control" },
		{ kind: "owner-proof", mode: "settled-control" },
		{ kind: "proof", mode: "close-valid" },
		{ kind: "owner-proof", mode: "close-valid" },
		{ kind: "proof", mode: "close-owner-loss" },
		{ kind: "owner-proof", mode: "close-owner-loss" },
	] as const)(
		"bridge closing with $kind and $mode preserves actual authority",
		async ({ kind, mode }) => {
			let armed = false,
				heldProof = false;
			let enter!: () => void, release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const actual = enrollment.enrollSqliteRestoreRuntimeStorage;
			vi.spyOn(enrollment, "enrollSqliteRestoreRuntimeStorage").mockImplementation(
				async (...args) => {
					const result = await actual(...args);
					return {
						...result,
						ownership: {
							...result.ownership,
							assertOwned: async () => {
								await result.ownership.assertOwned();
								if (armed && !heldProof) {
									heldProof = true;
									enter();
									await gate;
									// Never synthesize a successful owner result after the timing gate.
									await result.ownership.assertOwned();
								}
							},
						},
					};
				},
			);
			const losses: string[] = [];
			let runtime: RestoreRuntime | undefined;
			let bridge: Awaited<ReturnType<typeof attachRestoreRuntimeWorker>> | undefined;
			try {
				runtime = await openRestoreRuntime({
					databaseUrl: url,
					onUnavailable: (event) => losses.push(event.reason),
				});
				await runtime.bindDestination("fixture-proof-close");
				await runtime.activate();
				await runtime.runOperation(async () => {
					bridge = await attachRestoreRuntimeWorker(url);
					let receivedProof = false;
					bridge.binding.port.on("message", (message: unknown) => {
						if (
							typeof message === "object" &&
							message !== null &&
							"kind" in message &&
							message.kind === "proof"
						)
							receivedProof = true;
					});
					const response = once(bridge.binding.port, "message");
					armed = true;
					Atomics.store(new Int32Array(bridge.binding.fence), 1, 1);
					bridge.binding.port.postMessage({ kind, id: 1 });
					await entered;
					if (mode === "settled-control") {
						release();
						await response;
						expect(receivedProof).toBe(true);
						await bridge.close();
					} else {
						if (mode === "close-owner-loss")
							renameSync(
								join(directory, "main.db.arr-restore-runtime", "operations.sqlite3"),
								join(directory, "main.db.arr-restore-runtime", "retained-operations.sqlite3"),
							);
						const closing = bridge.close();
						await Promise.resolve();
						release();
						await closing;
						expect(receivedProof).toBe(false);
					}
					await expect(openRestoreRuntimeWorker(bridge.binding, url)).rejects.toMatchObject({
						statusCode: 503,
					});
					unchangedData();
				});
				if (mode === "close-owner-loss") {
					expect(losses).toEqual(["native-owner-unavailable"]);
					await expect(runtime.runOperation(() => true)).rejects.toMatchObject({ statusCode: 503 });
				} else {
					expect(losses, JSON.stringify({ kind, mode, losses })).toEqual([]);
					await expect(runtime.runOperation(() => true)).resolves.toBe(true);
				}
			} finally {
				release();
				await bridge?.close();
				bridge?.binding.port.close();
				await runtime?.close();
				vi.restoreAllMocks();
			}
		},
	);

	it("rolls back the binding when real journal insertion aborts and refuses the orphan on retry", async () => {
		main.exec(`CREATE TRIGGER reject_journal BEFORE INSERT ON RestoreRuntimeControl
			BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`);
		await refuse(start());
		expect(binding()).toEqual([]);
		expect(journal()).toEqual([]);
		unchangedData();
		main.exec("DROP TRIGGER reject_journal");
		await refuse(start());
		expect(binding()).toEqual([]);
		expect(journal()).toEqual([]);
	});

	it("rolls back both rows when the actual binding insert aborts", async () => {
		main.exec(`CREATE TRIGGER reject_binding AFTER INSERT ON SqliteRestoreStorageBinding
			BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`);
		await refuse(start());
		expect(binding()).toEqual([]);
		expect(journal()).toEqual([]);
		unchangedData();
	});

	it("a real deferred foreign-key COMMIT failure cannot publish either row", async () => {
		main.exec(`CREATE TABLE RequiredParent(id INTEGER PRIMARY KEY);
			CREATE TABLE DeferredFailure(parentId INTEGER REFERENCES RequiredParent(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER fail_commit AFTER INSERT ON RestoreRuntimeControl
			BEGIN INSERT INTO DeferredFailure VALUES(1); END`);
		await refuse(start());
		expect(binding()).toEqual([]);
		expect(journal()).toEqual([]);
		expect(main.prepare("SELECT * FROM DeferredFailure").all()).toEqual([]);
		unchangedData();
	});

	it.each(["interrupt", "interrupt-after-journal"])(
		"real SIGKILL at %s cannot commit either row",
		async (mode) => {
			const file = process.env.SQLITE_RESTORE_ADMISSION_ACTOR_FILE;
			if (!file || !existsSync(file)) throw new Error("Compiled starting actor required");
			const child = fork(file, [url, EPOCH, mode], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			actors.push({ child, exit });
			await exit;
			expect(child.signalCode).toBe("SIGKILL");
			expect(binding()).toEqual([]);
			expect(journal()).toEqual([]);
			unchangedData();
			await refuse(start());
		},
	);

	it("reconciles the actual Prisma adapter's DateTime storage without rewriting its positive marker", async () => {
		const first = await enrollSqliteRestoreRuntimeStorage(url);
		held.push(first);
		await first.ownership.close();
		const prisma = createTestPrismaClient(join(directory, "main.db"));
		try {
			await prisma.restoreRuntimeControl.create({
				data: {
					id: 1,
					protocolVersion: 1,
					phase: "restart-required",
					runtimeEpoch: OLD_EPOCH,
					ownerBackendPid: null,
					activeRestoreId: RESTORE,
					lastCommittedRestoreId: RESTORE,
					lastCommittedAt: new Date(TIME),
					destinationInstallationId: "fixture-destination",
				},
			});
			expect(await prisma.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toMatchObject({
				lastCommittedAt: new Date(TIME),
			});
		} finally {
			await prisma.$disconnect();
		}
		const original = binding();
		const [before] = journal() as Record<string, unknown>[];
		await start();
		expect(journal()).toEqual([
			{ ...before, phase: "starting", runtimeEpoch: EPOCH, activeRestoreId: null },
		]);
		expect(binding()).toEqual(original);
		unchangedData();
	});

	it.each([
		["idle", null, MARKER],
		["starting", null, MARKER],
		["running", null, MARKER],
		["restore-pending", RESTORE, MARKER],
		["restore-pending", RESTORE, RESTORE],
		["restart-required", RESTORE, RESTORE],
	])(
		"reconciles %s without replay and preserves original binding and historical marker",
		async (phase, active, marker) => {
			await seedPrior(phase!, active, marker!);
			const original = binding();
			await start();
			expect(journal()).toEqual([
				{
					id: 1,
					protocolVersion: 1,
					phase: "starting",
					runtimeEpoch: EPOCH,
					ownerBackendPid: null,
					activeRestoreId: null,
					lastCommittedRestoreId: marker,
					lastCommittedAt: Date.parse(TIME),
					destinationInstallationId: "fixture-destination",
				},
			]);
			expect(binding()).toEqual(original);
			unchangedData();
		},
	);

	it("does not reconstruct a missing journal for an already enrolled destination", async () => {
		const first = await enrollSqliteRestoreRuntimeStorage(url);
		held.push(first);
		await first.ownership.close();
		const original = binding();
		await refuse(start());
		expect(journal()).toEqual([]);
		expect(binding()).toEqual(original);
	});

	it.each([
		"invalid-phase",
		"ambiguous",
		"same-epoch",
		"wrong-pid",
		"invalid-time",
		"fractional-time",
	])("refuses %s prior journal without altering either row", async (kind) => {
		await seedPrior("running");
		if (kind === "invalid-phase")
			main.exec("UPDATE RestoreRuntimeControl SET phase='synthetic-invalid'");
		if (kind === "ambiguous")
			main.exec("INSERT INTO RestoreRuntimeControl (id,protocolVersion,phase) VALUES(2,1,'idle')");
		if (kind === "same-epoch")
			main.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch=?").run(EPOCH);
		if (kind === "wrong-pid") main.exec("UPDATE RestoreRuntimeControl SET ownerBackendPid=123");
		if (kind === "invalid-time")
			main.exec("UPDATE RestoreRuntimeControl SET lastCommittedAt='invalid'");
		if (kind === "fractional-time")
			main.exec("UPDATE RestoreRuntimeControl SET lastCommittedAt=1.5");
		const before = journal();
		const original = binding();
		await refuse(start());
		expect(journal()).toEqual(before);
		expect(binding()).toEqual(original);
		unchangedData();
	});

	it.each([
		{ runtimeEpoch: null },
		{ runtimeEpoch: "not-an-epoch" },
		{ runtimeEpoch: "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF" },
		{ runtimeEpoch: EPOCH, extra: true },
		null,
		{},
		{
			get runtimeEpoch() {
				throw new Error("Accessor must not execute");
			},
		},
	])("refuses malformed startup input before provisioning coordination", async (options) => {
		await refuse(start(options));
		expect(journal()).toEqual([]);
		expect(binding()).toEqual([]);
		expect(existsSync(`${join(directory, "main.db")}.arr-restore-runtime`)).toBe(false);
	});

	it("does not enroll a destination whose old journal has no original physical binding", async () => {
		main.exec("INSERT INTO RestoreRuntimeControl (id,protocolVersion,phase) VALUES(1,1,'idle')");
		await refuse(start());
		expect(binding()).toEqual([]);
		expect(journal()).toHaveLength(1);
		unchangedData();
	});

	it("bounds refusal without retaining storage paths or driver causes", async () => {
		await seedPrior("running");
		main.exec("UPDATE RestoreRuntimeControl SET phase='synthetic-invalid'");
		try {
			await start();
			expect.fail("Invalid state cannot return native authority");
		} catch (error) {
			expect(error).toBeInstanceOf(SqliteRestoreRuntimeEnrollmentError);
			expect(error).not.toHaveProperty("cause");
			expect(String(error)).not.toContain(directory);
		}
	});
});

describe("actor-owned restore runtime operation admission", () => {
	const postgres = process.env.RESTORE_RUNTIME_ENGINE === "postgres";
	let directory: string;
	let url: string;
	let sqlite: Database.Database | undefined;
	let pg: Client | undefined;
	const runtimes: RestoreRuntime[] = [];
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}
	async function rows(): Promise<Record<string, unknown>[]> {
		if (pg) return (await pg.query('SELECT * FROM "RestoreRuntimeControl" ORDER BY id')).rows;
		return sqlite!.prepare("SELECT * FROM RestoreRuntimeControl ORDER BY id").all() as Record<
			string,
			unknown
		>[];
	}
	async function start(onUnavailable?: () => void) {
		const runtime = await openRestoreRuntime({ databaseUrl: url, onUnavailable });
		runtimes.push(runtime);
		return runtime;
	}
	async function running(onUnavailable?: () => void) {
		const runtime = await start(onUnavailable);
		await runtime.bindDestination("fixture-destination");
		await runtime.activate();
		return runtime;
	}
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-runtime-"));
		if (postgres) {
			url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
			const parsed = new URL(url);
			if (
				parsed.hostname !== "127.0.0.1" ||
				!parsed.pathname.endsWith("_test") ||
				parsed.search ||
				parsed.hash
			)
				throw new Error("Isolated native PostgreSQL fixture required");
			pg = new Client({ connectionString: url });
			await pg.connect();
			await pg.query('DELETE FROM "RestoreRuntimeControl"');
			await pg.query(
				'INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,\'idle\')',
			);
		} else {
			const path = join(directory, "main.db");
			url = `file:${path}`;
			sqlite = new Database(path);
			sqlite.pragma("journal_mode = WAL");
			sqlite.exec(`CREATE TABLE RestoreRuntimeControl (
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
			chmodSync(path, 0o600);
		}
	});
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
		await pg?.end();
		pg = undefined;
		if (sqlite?.open) sqlite.close();
		sqlite = undefined;
		rmSync(directory, { recursive: true, force: true });
	});

	it("admits explicit bootstrap but refuses ordinary work until a bound running journal commits", async () => {
		const runtime = await start();
		await expect(runtime.runOperation(() => 7)).rejects.toMatchObject({ statusCode: 503 });
		await expect(runtime.activate()).rejects.toMatchObject({ statusCode: 503 });
		expect(
			await runtime.runStarting(async () => {
				await assertRestoreRuntimeOperation(runtime);
				return 7;
			}),
		).toBe(7);
		await runtime.bindDestination("fixture-destination");
		await runtime.activate();
		expect(
			await runtime.runOperation(async () => {
				await assertRestoreRuntimeOperation(runtime);
				return 9;
			}),
		).toBe(9);
		expect((await rows())[0]).toMatchObject({
			phase: "running",
			destinationInstallationId: "fixture-destination",
		});
		await expect(runtime.runStarting(() => 1)).rejects.toMatchObject({ statusCode: 503 });
	});

	it("never grants operation authority to absent tickets or structurally cloned runtime objects", async () => {
		const runtime = await running();
		await expect(assertRestoreRuntimeOperation(runtime)).rejects.toMatchObject({ statusCode: 503 });
		await runtime.runOperation(async () => {
			await expect(assertRestoreRuntimeOperation({ ...runtime })).rejects.toMatchObject({
				statusCode: 503,
			});
			await assertRestoreRuntimeOperation(runtime);
		});
	});

	it("preserves accepted nested work after normal closure while refusing newly admitted work", async () => {
		const runtime = await running();
		await runtime.runOperation(async () => {
			runtime.closeAdmission();
			expect(
				await runtime.runOperation(async () => {
					await assertRestoreRuntimeOperation(runtime);
					return 11;
				}),
			).toBe(11);
		});
		await expect(runtime.runOperation(() => 12)).rejects.toMatchObject({ statusCode: 503 });
		await runtime.drain();
	});

	it("rejects an inherited async ticket after its actual parent callback settles", async () => {
		const runtime = await running();
		const later = deferred();
		let orphan!: Promise<unknown>;
		await runtime.runOperation(() => {
			orphan = later.promise.then(() => assertRestoreRuntimeOperation(runtime));
		});
		later.resolve();
		await expect(orphan).rejects.toMatchObject({ statusCode: 503 });
	});

	it("independent producer holds drain beyond parent completion and may settle after admission closes", async () => {
		const runtime = await running();
		const entered = deferred();
		const finish = deferred();
		let producer!: Promise<void>;
		await runtime.runOperation(async () => {
			producer = runtime.runIndependentOperation(async () => {
				entered.resolve();
				await finish.promise;
				await assertRestoreRuntimeOperation(runtime);
			});
			await entered.promise;
		});
		runtime.closeAdmission();
		let drained = false;
		const drain = runtime.drain().then(() => {
			drained = true;
		});
		try {
			await Promise.resolve();
			expect(drained).toBe(false);
		} finally {
			finish.resolve();
		}
		await producer;
		await drain;
		expect(drained).toBe(true);
	});

	it("activation joins accepted bootstrap rather than publishing running while it remains active", async () => {
		const runtime = await start();
		await runtime.bindDestination("fixture-destination");
		const entered = deferred();
		const finish = deferred();
		const bootstrap = runtime.runStarting(async () => {
			entered.resolve();
			await finish.promise;
			await assertRestoreRuntimeOperation(runtime);
		});
		await entered.promise;
		const activation = runtime.activate();
		try {
			expect((await rows())[0]?.phase).toBe("starting");
		} finally {
			finish.resolve();
		}
		await bootstrap;
		await activation;
		expect((await rows())[0]?.phase).toBe("running");
	});

	it("refuses changed destination identity and leaves the starting journal unchanged", async () => {
		const runtime = await start();
		await runtime.bindDestination("fixture-destination");
		const before = await rows();
		await expect(runtime.bindDestination("other-fixture-destination")).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(await rows()).toEqual(before);
		await runtime.activate();
	});
	it("changed running destination identity fences both accepted and subsequent operations", async () => {
		let losses = 0;
		const runtime = await running(() => {
			losses++;
		});
		await runtime.runOperation(async () => {
			if (pg)
				await pg.query('UPDATE "RestoreRuntimeControl" SET "destinationInstallationId"=$1', [
					"other-fixture-destination",
				]);
			else
				sqlite!
					.prepare("UPDATE RestoreRuntimeControl SET destinationInstallationId=?")
					.run("other-fixture-destination");
			await expect(assertRestoreRuntimeOperation(runtime)).rejects.toMatchObject({
				statusCode: 503,
			});
		});
		await expect(runtime.runOperation(() => 1)).rejects.toMatchObject({ statusCode: 503 });
		expect(losses).toBe(1);
	});

	it("keeps native ownership until the actual accepted promise settles and joins concurrent close calls", async () => {
		const runtime = await running();
		const initial = getRestoreRuntimeShutdownStatus(runtime);
		expect(initial).toEqual({
			phase: "idle",
			failedPhase: null,
			admissionClosed: false,
			activeOperations: 0,
			retainedOperations: 0,
			registeredClients: 0,
			pendingClientCloses: 0,
		});
		expect(Object.isFrozen(initial)).toBe(true);
		const entered = deferred();
		const finish = deferred();
		const work = runtime.runOperation(async () => {
			entered.resolve();
			await finish.promise;
			await assertRestoreRuntimeOperation(runtime);
		});
		await entered.promise;
		const close = runtime.close();
		expect(runtime.close()).toBe(close);
		try {
			await vi.waitFor(() =>
				expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
					phase: "operations",
					admissionClosed: true,
					activeOperations: 1,
				}),
			);
			expect(initial).toMatchObject({ phase: "idle", activeOperations: 0 });
			await expect(
				postgres
					? acquirePostgresRestoreRuntimeOwnership(url)
					: acquireSqliteRestoreRuntimeOwnership(url),
			).rejects.toBeDefined();
		} finally {
			finish.resolve();
		}
		await work;
		await close;
		expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
			phase: "closed",
			failedPhase: null,
			activeOperations: 0,
		});
		const next = await start();
		await next.bindDestination("fixture-destination");
		await next.activate();
	});

	it("attributes a retained queue obligation after its parent has actually settled", async () => {
		const runtime = await running();
		const retained = await runtime.runOperation(() => retainRestoreRuntimeOperation()!);
		const closing = runtime.close();
		try {
			await vi.waitFor(() =>
				expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
					phase: "operations",
					activeOperations: 0,
					retainedOperations: 1,
				}),
			);
		} finally {
			await retained.release();
			await closing;
		}
		expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
			phase: "closed",
			retainedOperations: 0,
		});
	});

	it("counts actual client settlements without releasing native ownership early", async () => {
		const runtime = await running();
		const context = getRestoreRuntimeClientContext(runtime);
		const first = deferred(),
			second = deferred();
		let firstClosed = false;
		const unregisterFirst = context.registerClose(async () => {
			await first.promise;
			firstClosed = true;
		});
		const unregisterSecond = context.registerClose(async () => {
			await second.promise;
		});
		const closing = runtime.close();
		const result = closing.then(
			() => "closed",
			() => "rejected",
		);
		expect(runtime.close()).toBe(closing);
		try {
			await vi.waitFor(() =>
				expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
					phase: "clients",
					registeredClients: 2,
					pendingClientCloses: 2,
				}),
			);
			first.resolve();
			await vi.waitFor(() => expect(firstClosed).toBe(true));
			expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
				phase: "clients",
				pendingClientCloses: 1,
			});
			await expect(
				postgres
					? acquirePostgresRestoreRuntimeOwnership(url)
					: acquireSqliteRestoreRuntimeOwnership(url),
			).rejects.toBeDefined();
		} finally {
			first.resolve();
			second.resolve();
		}
		expect(await result).toBe("closed");
		expect(getRestoreRuntimeShutdownStatus(runtime)).toMatchObject({
			phase: "closed",
			failedPhase: null,
			pendingClientCloses: 0,
			admissionClosed: true,
		});
		unregisterFirst();
		unregisterSecond();
	});

	it("attributes rejected native client closure while retaining failed-close fencing in a disposable child", () => {
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx/esm"),
				"--input-type=module",
				"--eval",
				`
			import {openRestoreRuntime,getRestoreRuntimeClientContext,getRestoreRuntimeShutdownStatus} from "./src/lib/backup/restore-runtime-admission.ts";
			import {acquireSqliteRestoreRuntimeOwnership} from "./src/lib/backup/restore-runtime-sqlite.ts";
			import {acquirePostgresRestoreRuntimeOwnership} from "./src/lib/backup/restore-runtime-postgres.ts";
			const runtime=await openRestoreRuntime({databaseUrl:process.env.FIXTURE_DATABASE_URL});
			await runtime.bindDestination("fixture-destination");await runtime.activate();
			getRestoreRuntimeClientContext(runtime).registerClose(async()=>{throw new Error("Synthetic private client failure");});
			const closing=runtime.close(),duplicate=runtime.close();
			const rejected=await closing.then(()=>false,()=>true);
			const retryRejected=await runtime.close().then(()=>false,()=>true);
			const operationFenced=await runtime.runOperation(()=>1).then(()=>false,()=>true);
			const acquire=process.env.FIXTURE_ENGINE==="postgres"?acquirePostgresRestoreRuntimeOwnership:acquireSqliteRestoreRuntimeOwnership;
			const ownershipFenced=await acquire(process.env.FIXTURE_DATABASE_URL).then(async owner=>{await owner.close();return false;},()=>true);
			process.stdout.write(JSON.stringify({sameClose:closing===duplicate,rejected,retryRejected,operationFenced,ownershipFenced,status:getRestoreRuntimeShutdownStatus(runtime)})+"\\n");
			process.exit(0);
		`,
			],
			{
				cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
				env: {
					NODE_ENV: "test",
					DOTENV_CONFIG_PATH: "/dev/null",
					FIXTURE_DATABASE_URL: url,
					FIXTURE_ENGINE: postgres ? "postgres" : "sqlite",
				},
				encoding: "utf8",
				timeout: 5000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.signal).toBeNull();
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({
			sameClose: true,
			rejected: true,
			retryRejected: true,
			operationFenced: true,
			ownershipFenced: true,
			status: {
				phase: "failed",
				failedPhase: "clients",
				admissionClosed: true,
				activeOperations: 0,
				retainedOperations: 0,
				registeredClients: 1,
				pendingClientCloses: 0,
			},
		});
	});

	it("starts a distinct epoch after physical owner closure without replacing the persistent destination", async () => {
		const first = await running();
		const [old] = await rows();
		await first.close();
		const next = await start();
		const [fresh] = await rows();
		expect(fresh?.runtimeEpoch).not.toBe(old?.runtimeEpoch);
		expect(fresh).toMatchObject({
			phase: "starting",
			destinationInstallationId: "fixture-destination",
		});
		await next.bindDestination("fixture-destination");
	});

	it("terminal native owner loss fences accepted nested statements and notifies only once", async () => {
		let losses = 0;
		const runtime = await running(() => {
			losses++;
		});
		await runtime.runOperation(async () => {
			if (pg) {
				const [record] = await rows();
				await pg.query("SELECT pg_terminate_backend($1)", [record?.ownerBackendPid]);
			} else {
				const coordination = `${join(directory, "main.db")}.arr-restore-runtime`;
				renameSync(
					join(coordination, "operations.sqlite3"),
					join(coordination, "retained-operations.sqlite3"),
				);
			}
			await expect(assertRestoreRuntimeOperation(runtime)).rejects.toMatchObject({
				statusCode: 503,
			});
			await expect(assertRestoreRuntimeOperation(runtime)).rejects.toMatchObject({
				statusCode: 503,
			});
		});
		await expect(runtime.runOperation(() => 1)).rejects.toMatchObject({ statusCode: 503 });
		expect(losses).toBe(1);
	});

	it("activation does not block an accepted bootstrap's queued identity binding", async () => {
		const runtime = await start();
		const entered = deferred();
		const bindNow = deferred();
		const unblockOnFailure = deferred();
		let binding!: Promise<void>;
		const bootstrap = runtime.runStarting(async () => {
			entered.resolve();
			await bindNow.promise;
			binding = runtime.bindDestination("fixture-destination");
			await Promise.race([binding, unblockOnFailure.promise]);
		});
		await entered.promise;
		const activation = runtime.activate();
		const activationResult = activation.then(
			() => true,
			() => false,
		);
		bindNow.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const finished = await Promise.race([
				bootstrap.then(
					() => true,
					() => false,
				),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), 2000);
				}),
			]);
			expect(finished).toBe(true);
		} finally {
			if (timer) clearTimeout(timer);
			unblockOnFailure.resolve();
			await bootstrap.catch(() => {});
			await activationResult;
			await binding?.catch(() => {});
		}
		expect((await rows())[0]?.phase).toBe("running");
	});

	it("rejects close from its own accepted callback rather than deadlocking its own drain", async () => {
		const runtime = await running();
		await runtime.runOperation(async () => {
			let result = "pending";
			const close = runtime.close().then(
				() => {
					result = "closed";
				},
				() => {
					result = "rejected";
				},
			);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(result).toBe("rejected");
			void close;
		});
	});

	it("same-epoch bind and activation work while an actual native participant holds SHARED", async () => {
		const runtime = await start();
		let participant: { close(): Promise<void> };
		if (postgres) {
			const client = new Client({ connectionString: url });
			await client.connect();
			const result = await client.query(
				"SELECT pg_try_advisory_lock_shared(1095914052,2) AS acquired",
			);
			expect(result.rows[0]?.acquired).toBe(true);
			participant = { close: () => client.end() };
		} else {
			participant = await acquireSqliteRestoreOperationLock(url);
		}
		try {
			await runtime.bindDestination("fixture-destination");
			await runtime.activate();
			expect((await rows())[0]?.phase).toBe("running");
		} finally {
			await participant.close();
		}
	});

	it("a previously initialized destination missing its journal refuses automatic reconstruction", async () => {
		const first = await start();
		await first.close();
		if (pg) await pg.query('DELETE FROM "RestoreRuntimeControl"');
		else sqlite!.exec("DELETE FROM RestoreRuntimeControl");
		await expect(start()).rejects.toMatchObject({ statusCode: 503 });
		expect(await rows()).toEqual([]);
	});

	it("preserves exact UTC historical marker across a fresh native runtime epoch", async () => {
		const first = await start();
		await first.close();
		if (pg) {
			await pg.query(
				'UPDATE "RestoreRuntimeControl" SET phase=\'idle\', "runtimeEpoch"=NULL, "ownerBackendPid"=NULL, "destinationInstallationId"=$1, "lastCommittedRestoreId"=$2, "lastCommittedAt"=$3',
				["fixture-destination", MARKER, TIME],
			);
		} else {
			sqlite!
				.prepare(
					"UPDATE RestoreRuntimeControl SET phase='idle', runtimeEpoch=NULL, ownerBackendPid=NULL, destinationInstallationId=?, lastCommittedRestoreId=?, lastCommittedAt=?",
				)
				.run("fixture-destination", MARKER, TIME);
		}
		const runtime = await start();
		await runtime.bindDestination("fixture-destination");
		await runtime.activate();
		if (pg) {
			const result = await pg.query(
				'SELECT to_char("lastCommittedAt",\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS marker, "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
			);
			expect(result.rows).toEqual([{ marker: TIME, lastCommittedRestoreId: MARKER }]);
		} else {
			expect((await rows())[0]).toMatchObject({
				lastCommittedAt: TIME,
				lastCommittedRestoreId: MARKER,
			});
		}
	});

	it("native owner loss after an actual control write rolls back while the writing actor retains participation", async () => {
		let losses = 0;
		const runtime = await start(() => {
			losses++;
		});
		const before = await rows();
		let checked = false;
		if (pg) {
			const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, "query")!;
			const query = Client.prototype.query;
			let contender: Awaited<ReturnType<typeof acquirePostgresRestoreRuntimeOwnership>> | undefined;
			let armed = true;
			Object.defineProperty(Client.prototype, "query", {
				...descriptor,
				value: function (this: Client, ...args: unknown[]) {
					const result = Reflect.apply(query, this, args);
					if (
						!armed ||
						typeof args[0] !== "string" ||
						!args[0].startsWith('UPDATE "RestoreRuntimeControl"')
					)
						return result;
					armed = false;
					return Promise.resolve(result).then(async (value) => {
						// Execute the real UPDATE first, then kill only the separate owner.
						await pg!.query("SELECT pg_terminate_backend($1)", [before[0]?.ownerBackendPid]);
						contender = await acquirePostgresRestoreRuntimeOwnership(url);
						expect(await contender.tryAcquireExclusive()).toBe(false);
						checked = true;
						return value;
					});
				},
			});
			try {
				await expect(runtime.bindDestination("fixture-destination")).rejects.toMatchObject({
					statusCode: 503,
				});
				expect(checked).toBe(true);
				expect(await rows()).toEqual(before);
				expect(await contender!.tryAcquireExclusive()).toBe(true);
			} finally {
				Object.defineProperty(Client.prototype, "query", descriptor);
				await contender?.close();
			}
		} else {
			const descriptor = Object.getOwnPropertyDescriptor(Database.prototype, "prepare")!;
			const prepare = Database.prototype.prepare;
			Object.defineProperty(Database.prototype, "prepare", {
				...descriptor,
				value: function (this: Database.Database, source: string) {
					const statement = Reflect.apply(prepare, this, [source]) as Database.Statement;
					if (source.startsWith("UPDATE RestoreRuntimeControl SET phase=@nextPhase")) {
						statement.run = new Proxy(statement.run, {
							apply(target, self, args) {
								const value = Reflect.apply(target, self, args);
								const coordination = `${join(directory, "main.db")}.arr-restore-runtime`;
								renameSync(
									join(coordination, "operations.sqlite3"),
									join(coordination, "retained-operations.sqlite3"),
								);
								checked = true;
								return value;
							},
						});
					}
					return statement;
				},
			});
			try {
				await expect(runtime.bindDestination("fixture-destination")).rejects.toMatchObject({
					statusCode: 503,
				});
				expect(checked).toBe(true);
				expect(await rows()).toEqual(before);
				expect(losses).toBe(1);
			} finally {
				Object.defineProperty(Database.prototype, "prepare", descriptor);
			}
		}
		await expect(runtime.runStarting(() => 1)).rejects.toMatchObject({ statusCode: 503 });
		expect(losses).toBe(1);
	});
});
