import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import * as admission from "../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";

const WRITE = "UPDATE CooperativeProbe SET value=value+1 WHERE id=1";

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "arr-cooperative-yield-"));
	chmodSync(directory, 0o700);
	const owned = lstatSync(directory, { bigint: true });
	const path = join(directory, "fixture.db");
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
		CREATE TABLE CooperativeProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
		INSERT INTO CooperativeProbe VALUES(1,0)`);
	let nativeAttempts = 0;
	const prepare = Database.prototype.prepare;
	const observed = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (this.name === path && sql === WRITE) {
			const run = statement.run;
			statement.run = function (...args: unknown[]) {
				nativeAttempts++;
				return Reflect.apply(run, this, args);
			};
		}
		return statement;
	});
	const losses: string[] = [];
	const runtime = await admission.openRestoreRuntime({
		databaseUrl: `file:${path}`,
		onUnavailable: (event) => losses.push(event.reason),
	});
	await runtime.bindDestination("synthetic-cooperative-yield");
	await runtime.activate();
	const client = createRuntimePrismaClient(runtime);
	await runtime.runOperation(() => client.prisma.$queryRawUnsafe("SELECT 1"));
	return {
		runtime,
		client,
		losses,
		attempts: () => nativeAttempts,
		value: () =>
			(
				inspector.prepare("SELECT value FROM CooperativeProbe WHERE id=1").get() as {
					value: number;
				}
			).value,
		async close() {
			await client.close();
			await runtime.close();
			inspector.close();
			observed.mockRestore();
			const current = lstatSync(directory, { bigint: true });
			if (current.dev !== owned.dev || current.ino !== owned.ino)
				throw new Error("Synthetic fixture ownership changed");
			rmSync(directory, { recursive: true });
		},
	};
}

describe("ordinary SQLite cooperative ownership guards", () => {
	it.each(["unique", "mixed", "same-batch"] as const)(
		"characterizes %s read guards in one transaction and preserves its values and reuse",
		async (mode) => {
			const f = await fixture();
			await f.client.close();
			let armed = false;
			let proofs = 0;
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const originalContext = admission.getRestoreRuntimeClientContext;
			const observed = vi
				.spyOn(admission, "getRestoreRuntimeClientContext")
				.mockImplementation((runtime) => {
					const context = originalContext(runtime);
					return {
						...context,
						async assertOwned() {
							const proof = armed ? ++proofs : 0;
							await context.assertOwned();
							if (proof === 1) {
								enter();
								await held;
							}
						},
					};
				});
			const client = createRuntimePrismaClient(f.runtime);
			try {
				await f.runtime.runOperation(() =>
					client.prisma.$transaction(async (tx) => {
						await tx.$queryRawUnsafe("SELECT 1");
						armed = true;
						const reading = Promise.all([
							mode === "unique"
								? tx.restoreRuntimeControl.findUnique({ where: { id: 1 }, select: { id: true } })
								: tx.restoreRuntimeControl.findMany({ select: { id: true } }),
							mode === "same-batch"
								? tx.sqliteRestoreStorageBinding.findMany({ select: { id: true } })
								: tx.sqliteRestoreStorageBinding.findUnique({
										where: { id: 1 },
										select: { id: true },
									}),
						]);
						let proofsWhileFirstHeld: number;
						try {
							await entered;
							await turn();
							proofsWhileFirstHeld = proofs;
						} finally {
							release();
						}
						const values = await reading;
						armed = false;
						expect(values).toEqual(
							mode === "unique"
								? [{ id: 1 }, { id: 1 }]
								: mode === "mixed"
									? [[{ id: 1 }], { id: 1 }]
									: [[{ id: 1 }], [{ id: 1 }]],
						);
						expect(proofsWhileFirstHeld).toBe(mode === "same-batch" ? 1 : 2);
					}),
				);
				expect(
					await f.runtime.runOperation(() =>
						client.prisma.$transaction((tx) =>
							tx.$queryRawUnsafe("SELECT value FROM CooperativeProbe WHERE id=1"),
						),
					),
				).toEqual([{ value: 0 }]);
				expect(f.value()).toBe(0);
				expect(f.attempts()).toBe(0);
				expect(f.losses).toEqual([]);
			} finally {
				release();
				await client.close();
				observed.mockRestore();
				await f.close();
			}
		},
	);

	it("services a queued event-loop turn before a warm guarded query sequence finishes", async () => {
		const f = await fixture();
		try {
			let completed = 0;
			let servicedAfter: number | undefined;
			await f.runtime.runOperation(async () => {
				const serviced = turn().then(() => {
					servicedAfter = completed;
				});
				for (let i = 0; i < 8; i++) {
					await f.client.prisma.$executeRawUnsafe(WRITE);
					completed++;
				}
				await serviced;
			});
			expect(completed).toBe(8);
			expect(servicedAfter).toBeLessThan(8);
			expect(f.value()).toBe(8);
			expect(f.attempts()).toBe(8);
			expect(f.losses).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("rejects native work when a queued turn revokes the runtime ticket", async () => {
		const f = await fixture();
		try {
			const context = admission.getRestoreRuntimeClientContext(f.runtime);
			await f.runtime.runOperation(async () => {
				const revoked = turn().then(() => context.unavailable("native-owner-unavailable"));
				const accepted = await f.client.prisma.$executeRawUnsafe(WRITE).then(
					() => true,
					() => false,
				);
				await revoked;
				expect(accepted).toBe(false);
			});
			expect(f.value()).toBe(0);
			expect(f.attempts()).toBe(0);
			expect(f.losses).toEqual(["native-owner-unavailable"]);
		} finally {
			await f.close();
		}
	});

	it("rejects a captured operation loan after its callback has returned", async () => {
		const f = await fixture();
		let pending: Promise<boolean> | undefined;
		try {
			await f.runtime.runOperation(() => {
				pending = f.client.prisma.$executeRawUnsafe(WRITE).then(
					() => true,
					() => false,
				);
			});
			expect(await pending).toBe(false);
			expect(f.value()).toBe(0);
			expect(f.attempts()).toBe(0);
			await f.runtime.runOperation(() => f.client.prisma.$executeRawUnsafe(WRITE));
			expect(f.value()).toBe(1);
			expect(f.attempts()).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			await pending;
			await f.close();
		}
	});

	it.each(["disconnect", "client close"] as const)(
		"rejects late native work when a queued turn starts %s",
		async (mode) => {
			const f = await fixture();
			let closing: Promise<void> | undefined;
			try {
				await f.runtime.runOperation(async () => {
					const started = turn().then(() => {
						closing = mode === "disconnect" ? f.client.prisma.$disconnect() : f.client.close();
					});
					const accepted = await f.client.prisma.$executeRawUnsafe(WRITE).then(
						() => true,
						() => false,
					);
					await started;
					expect(accepted).toBe(false);
				});
				await closing;
				expect(f.value()).toBe(0);
				expect(f.attempts()).toBe(0);
				expect(f.losses).toEqual([]);
			} finally {
				await closing;
				await f.close();
			}
		},
	);

	it("rolls back before a pending transaction write resumes and preserves the callback error", async () => {
		const f = await fixture();
		const failure = new Error("Synthetic callback failure");
		let pending: Promise<boolean> | undefined;
		try {
			await f.runtime.runOperation(async () => {
				await expect(
					f.client.prisma.$transaction(async (tx) => {
						await tx.$queryRawUnsafe("SELECT 1");
						pending = tx.$executeRawUnsafe(WRITE).then(
							() => true,
							() => false,
						);
						throw failure;
					}),
				).rejects.toBe(failure);
				expect(await pending).toBe(false);
				expect(f.value()).toBe(0);
				expect(f.attempts()).toBe(0);
				await f.client.prisma.$executeRawUnsafe(WRITE);
			});
			expect(f.value()).toBe(1);
			expect(f.attempts()).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			await pending;
			await f.close();
		}
	});
});
