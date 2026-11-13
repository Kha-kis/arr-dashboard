import { fork } from "node:child_process";
import { Client, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../prisma.js";
import { openRestoreRuntime, type RestoreRuntime } from "../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";
import { acquirePostgresRestoreRuntimeOwnership } from "../restore-runtime-postgres.js";
import { createRuntimePostgresAdapter } from "../restore-runtime-postgres-client.js";

describe("actual PostgreSQL runtime-owned ordinary pool", () => {
	let fixture: Client;
	let runtime: RestoreRuntime;
	let adapter: ReturnType<typeof createRuntimePostgresAdapter> | undefined;
	let prisma: PrismaClient | undefined;
	let integrated: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let losses: number;
	let url: string;
	beforeEach(async () => {
		url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!parsed.pathname.endsWith("_test") ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Isolated native PostgreSQL fixture required");
		fixture = new Client({ connectionString: url });
		await fixture.connect();
		await fixture.query('DELETE FROM "User"');
		await fixture.query('DELETE FROM "RestoreRuntimeControl"');
		await fixture.query(
			'INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,\'idle\')',
		);
		losses = 0;
		runtime = await openRestoreRuntime({
			databaseUrl: url,
			onUnavailable: () => {
				losses++;
			},
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await prisma?.$disconnect();
		await adapter?.close();
		await integrated?.close();
		await runtime?.close();
		await fixture?.end();
		adapter = undefined;
		prisma = undefined;
		integrated = undefined;
	});
	function create() {
		adapter = createRuntimePostgresAdapter(runtime);
		prisma = new PrismaClient({ adapter });
		return prisma;
	}
	async function activate() {
		await runtime.bindDestination("fixture-destination");
		await runtime.activate();
	}
	async function sharedCount() {
		return Number(
			(
				await fixture.query(
					"SELECT COUNT(*) AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=1095914052::oid AND objid=2::oid AND objsubid=2 AND granted AND mode='ShareLock'",
				)
			).rows[0]?.count,
		);
	}
	it("branded authority refuses structurally cloned runtime objects", () => {
		expect(() => createRuntimePostgresAdapter({ ...runtime })).toThrow(
			"Restore runtime admission is unavailable.",
		);
	});
	it("the shared native Prisma factory selects a guarded PG client and joins physical runtime shutdown", async () => {
		integrated = createRuntimePrismaClient(runtime);
		await activate();
		await runtime.runOperation(() =>
			integrated!.prisma.user.create({ data: { username: "fixture-integrated" } }),
		);
		expect(await sharedCount()).toBe(1);
		await runtime.close();
		expect(await sharedCount()).toBe(0);
		await expect(integrated.prisma.user.count()).rejects.toThrow();
	});
	it("real CRUD and direct lazy Prisma work succeed under bootstrap then running tickets", async () => {
		const client = create();
		await runtime.runStarting(() =>
			client.user.create({ data: { id: "fixture-pg", username: "fixture-pg" } }),
		);
		await activate();
		await runtime.runOperation(async () => {
			expect(await client.user.count()).toBe(1);
			await client.user.update({
				where: { id: "fixture-pg" },
				data: { username: "fixture-updated" },
			});
			await client.user.delete({ where: { id: "fixture-pg" } });
			expect(await client.user.count()).toBe(0);
		});
	});
	it("idle actual backends retain SHARED until physical disconnection", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(() => client.user.count());
		expect(await sharedCount()).toBe(1);
		await client.$disconnect();
		expect(await sharedCount()).toBe(0);
	});
	it("missing and inactive inherited tickets cannot issue actual SQL", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(() => client.user.count());
		await expect(client.user.create({ data: { username: "fixture-no-ticket" } })).rejects.toThrow();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let orphan!: Promise<unknown>;
		await runtime.runOperation(() => {
			orphan = gate.then(() => client.user.create({ data: { username: "fixture-orphan" } }));
		});
		release();
		await expect(orphan).rejects.toThrow();
		expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
			{ count: "0" },
		]);
	});
	it("real interactive transactions commit and roll back without publishing aborted rows", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(async () => {
			await client.$transaction(async (tx) => {
				await tx.user.create({ data: { username: "fixture-commit" } });
			});
			await expect(
				client.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-abort" } });
					throw new Error("Synthetic abort");
				}),
			).rejects.toThrow("Synthetic abort");
			expect(await client.user.count()).toBe(1);
		});
	});
	it.each([
		["SERIALIZABLE", "serializable"],
		["REPEATABLE READ", "repeatable read"],
		["READ COMMITTED", "read committed"],
		["READ UNCOMMITTED", "read uncommitted"],
	] as const)(
		"native %s initialization retains the requested isolation",
		async (isolation, want) => {
			adapter = createRuntimePostgresAdapter(runtime);
			const driver = await runtime.runStarting(() => adapter!.connect());
			await activate();
			await runtime.runOperation(async () => {
				const transaction = await driver.startTransaction(isolation);
				try {
					const result = await transaction.queryRaw({
						sql: "SHOW transaction_isolation",
						args: [],
						argTypes: [],
					});
					expect(result.rows).toEqual([[want]]);
				} finally {
					await transaction.rollback();
				}
			});
			expect(losses).toBe(0);
		},
	);
	it("Serializable Prisma transactions commit and roll back without publishing aborted rows", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(async () => {
			await client.$transaction(
				async (tx) => {
					const rows = await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>(
						"SHOW transaction_isolation",
					);
					expect(rows).toEqual([{ transaction_isolation: "serializable" }]);
					await tx.user.create({ data: { username: "fixture-serializable-commit" } });
				},
				{ isolationLevel: "Serializable" },
			);
			await expect(
				client.$transaction(
					async (tx) => {
						await tx.user.create({ data: { username: "fixture-serializable-abort" } });
						throw new Error("Synthetic Serializable abort");
					},
					{ isolationLevel: "Serializable" },
				),
			).rejects.toThrow("Synthetic Serializable abort");
		});
		expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
			{ username: "fixture-serializable-commit" },
		]);
		expect(losses).toBe(0);
	});
	it("ordinary isolation SQL cannot reuse initialization to bypass a changed destination", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		await activate();
		await runtime.runOperation(async () => {
			const transaction = await driver.startTransaction("SERIALIZABLE");
			try {
				await fixture.query('UPDATE "RestoreRuntimeControl" SET "destinationInstallationId"=$1', [
					"other-fixture-destination",
				]);
				await expect(
					transaction.executeRaw({
						sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
						args: [],
						argTypes: [],
					}),
				).rejects.toThrow("Restore runtime admission is unavailable.");
				expect(losses).toBe(1);
			} finally {
				await transaction.rollback();
			}
		});
	});
	it("owner death during native isolation setup fences the transaction before its body", async () => {
		const client = create();
		await activate();
		const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, "query")!;
		const original = Client.prototype.query;
		let armed = true;
		Object.defineProperty(Client.prototype, "query", {
			...descriptor,
			value: function (this: Client, ...args: unknown[]) {
				const text =
					typeof args[0] === "string"
						? args[0]
						: args[0] && typeof args[0] === "object"
							? Reflect.get(args[0], "text")
							: undefined;
				if (
					armed &&
					this.constructor !== Client &&
					text === "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
				) {
					armed = false;
					return fixture
						.query('SELECT pg_terminate_backend("ownerBackendPid") FROM "RestoreRuntimeControl"')
						.then(() => Reflect.apply(original, this, args));
				}
				return Reflect.apply(original, this, args);
			},
		});
		let bodyEntered = false;
		try {
			await runtime.runOperation(() =>
				expect(
					client.$transaction(
						async (tx) => {
							bodyEntered = true;
							await tx.user.create({ data: { username: "fixture-fenced-isolation" } });
						},
						{ isolationLevel: "Serializable" },
					),
				).rejects.toThrow(),
			);
			expect(armed).toBe(false);
			expect(bodyEntered).toBe(false);
			expect(losses).toBe(1);
			await client.$disconnect();
			expect(await sharedCount()).toBe(0);
			expect((await fixture.query('SELECT count(*) AS count FROM "User"')).rows).toEqual([
				{ count: "0" },
			]);
		} finally {
			Object.defineProperty(Client.prototype, "query", descriptor);
		}
	});
	it("disconnect and reconnect create a new guarded physical pool generation", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(async () => {
			await client.user.count();
			const [original] = await client.$queryRawUnsafe<{ pid: number }[]>(
				"SELECT pg_backend_pid() AS pid",
			);
			await client.$disconnect();
			expect(
				(
					await fixture.query(
						"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present",
						[original!.pid],
					)
				).rows,
			).toEqual([{ present: false }]);
			// The ordinary pool is physically gone; the accepted outer operation
			// still owns its independent shared lifetime participant.
			expect(await sharedCount()).toBe(1);
			await client.user.create({ data: { username: "fixture-reconnected" } });
			const [replacement] = await client.$queryRawUnsafe<{ pid: number }[]>(
				"SELECT pg_backend_pid() AS pid",
			);
			expect(replacement!.pid).not.toBe(original!.pid);
			expect(await sharedCount()).toBe(2);
		});
		expect(await sharedCount()).toBe(1);
		await client.$disconnect();
		expect(await sharedCount()).toBe(0);
	});
	it("normal admission closure lets an already accepted transaction commit", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(() =>
			client.$transaction(async (tx) => {
				runtime.closeAdmission();
				await tx.user.create({ data: { username: "fixture-accepted" } });
			}),
		);
		expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
			{ count: "1" },
		]);
	});
	it("actual owner death fences a borrowed transaction and blocks exclusive cutover until pool closure", async () => {
		const client = create();
		await activate();
		let contender: Awaited<ReturnType<typeof acquirePostgresRestoreRuntimeOwnership>> | undefined;
		try {
			await runtime.runOperation(async () => {
				await expect(
					client.$transaction(async (tx) => {
						await tx.user.create({ data: { username: "fixture-not-published" } });
						const row = (
							await fixture.query('SELECT "ownerBackendPid" FROM "RestoreRuntimeControl"')
						).rows[0];
						await fixture.query("SELECT pg_terminate_backend($1)", [row.ownerBackendPid]);
						contender = await acquirePostgresRestoreRuntimeOwnership(url);
						expect(await contender.tryAcquireExclusive()).toBe(false);
						await tx.user.create({ data: { username: "fixture-fenced" } });
					}),
				).rejects.toThrow();
			});
			expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
				{ count: "0" },
			]);
			expect(losses).toBe(1);
			expect(contender).toBeDefined();
			expect(await contender!.tryAcquireExclusive()).toBe(false);
			await client.$disconnect();
			expect(await contender!.tryAcquireExclusive()).toBe(true);
		} finally {
			await contender?.close();
		}
	});
	it("callback and promise native Pool checkout preserve guarded query and release behavior", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		await runtime.runOperation(async () => {
			const borrowed = await pool.connect();
			try {
				expect((await borrowed.query("SELECT 7 AS value")).rows).toEqual([{ value: 7 }]);
			} finally {
				borrowed.release();
			}
			const value = await new Promise<number>((resolve, reject) =>
				pool.connect((error, connection, release) => {
					if (error || !connection) {
						reject(error);
						return;
					}
					connection.query("SELECT 9 AS value", (failure, result) => {
						release(failure);
						if (failure) reject(failure);
						else resolve(result.rows[0]?.value);
					});
				}),
			);
			expect(value).toBe(9);
		});
	});
	it("changed running destination fences actual pooled statements and signals once", async () => {
		const client = create();
		await activate();
		await runtime.runOperation(async () => {
			await client.user.count();
			await fixture.query('UPDATE "RestoreRuntimeControl" SET "destinationInstallationId"=$1', [
				"other-fixture-destination",
			]);
			await expect(client.user.count()).rejects.toThrow();
			expect(losses).toBe(1);
		});
	});
	it("queued callback checkout keeps the waiting caller's ticket when another caller releases", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		pool.options.max = 1;
		await activate();
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runtime.runOperation(async () => {
			const connection = await pool.connect();
			try {
				entered();
				await gate;
			} finally {
				connection.release();
			}
		});
		await ready;
		const second = runtime.runOperation(
			() =>
				new Promise<number>((resolve, reject) =>
					pool.connect((error, connection, done) => {
						if (error || !connection) {
							reject(error);
							return;
						}
						connection.query("SELECT 11 AS value", (failure, result) => {
							done(failure);
							if (failure) reject(failure);
							else resolve(result.rows[0]?.value);
						});
					}),
				),
		);
		try {
			const deadline = performance.now() + 2000;
			while (pool.waitingCount === 0 && performance.now() < deadline)
				await new Promise<void>((resolve) => setImmediate(resolve));
			expect(pool.waitingCount).toBe(1);
			release();
			expect(await second).toBe(11);
			await first;
		} finally {
			release();
			await Promise.allSettled([first, second]);
		}
	});
	it("physical session end is joined even when native Pool bookkeeping already reports empty", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		const connection = await runtime.runOperation(() => pool.connect());
		connection.release();
		const original: unknown = Reflect.get(connection, "end");
		if (typeof original !== "function") throw new Error("Actual native client end method required");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		Object.defineProperty(connection, "end", {
			configurable: true,
			value: (...args: unknown[]) => {
				void gate.then(() => Reflect.apply(original, connection, args));
			},
		});
		let closed = false;
		const close = adapter.close().then(() => {
			closed = true;
		});
		try {
			const deadline = performance.now() + 2000;
			while (pool.totalCount !== 0 && performance.now() < deadline)
				await new Promise<void>((resolve) => setImmediate(resolve));
			expect(pool.totalCount).toBe(0);
			expect(await sharedCount()).toBe(1);
			expect(closed).toBe(false);
			release();
			await close;
			expect(await sharedCount()).toBe(0);
		} finally {
			release();
			await close;
		}
	});
	it("failed native rollback retires the session rather than returning a live transaction to the pool", async () => {
		const client = create();
		await activate();
		const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, "query")!;
		const query = Client.prototype.query;
		let armed = true;
		Object.defineProperty(Client.prototype, "query", {
			...descriptor,
			value: function (this: Client, ...args: unknown[]) {
				const text =
					typeof args[0] === "string"
						? args[0]
						: args[0] && typeof args[0] === "object"
							? Reflect.get(args[0], "text")
							: undefined;
				if (armed && text === "ROLLBACK")
					return Promise.reject(new Error("Synthetic native rollback failure"));
				return Reflect.apply(query, this, args);
			},
		});
		try {
			await runtime.runOperation(async () => {
				await expect(
					client.$transaction(async (tx) => {
						await tx.user.create({ data: { username: "fixture-rollback-failure" } });
						throw new Error("Synthetic abort");
					}),
				).rejects.toThrow();
				armed = false;
				expect(await client.user.count()).toBe(0);
				await client.user.create({ data: { username: "fixture-safe-replacement" } });
			});
			expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
				{ count: "1" },
			]);
		} finally {
			armed = false;
			Object.defineProperty(Client.prototype, "query", descriptor);
		}
	});
	it.each(["promise", "callback"] as const)(
		"checked-out %s connection loss cannot crash, write, or change runtime authority",
		async (mode) => {
			adapter = createRuntimePostgresAdapter(runtime);
			const driver = await runtime.runStarting(() => adapter!.connect());
			const pool = driver.underlyingDriver();
			await activate();
			const control = (await fixture.query('SELECT * FROM "RestoreRuntimeControl"')).rows;
			let oldPid: number | undefined;
			await runtime.runOperation(async () => {
				const borrowed =
					mode === "promise"
						? await pool.connect()
						: await new Promise<PoolClient>((resolve, reject) =>
								pool.connect((error, connection) => {
									if (error || !connection) reject(error);
									else resolve(connection);
								}),
							);
				try {
					oldPid = (await borrowed.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
					const ended = new Promise<void>((resolve) => borrowed.once("end", resolve));
					expect(
						(await fixture.query("SELECT pg_terminate_backend($1) AS stopped", [oldPid])).rows[0]
							.stopped,
					).toBe(true);
					await ended;
					await expect(
						borrowed.query('INSERT INTO "User" (id,username) VALUES($1,$2)', [
							"fixture-lost-connection",
							"fixture-lost-connection",
						]),
					).rejects.toThrow("Restore runtime admission is unavailable.");
				} finally {
					borrowed.release();
				}
			});
			await runtime.runOperation(async () => {
				const row = (await pool.query("SELECT pg_backend_pid() AS pid, 17 AS value")).rows[0];
				expect(row.pid).not.toBe(oldPid);
				expect(row.value).toBe(17);
			});
			expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
				{ count: "0" },
			]);
			expect((await fixture.query('SELECT * FROM "RestoreRuntimeControl"')).rows).toEqual(control);
			expect(await sharedCount()).toBe(1);
			expect(losses).toBe(0);
		},
		15000,
	);
	it("an idle backend transport loss replaces only that session under the same live owner and epoch", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		let oldPid: number;
		await runtime.runOperation(async () => {
			oldPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
		});
		const removed = new Promise<void>((resolve) => pool.once("remove", () => resolve()));
		await fixture.query("SELECT pg_terminate_backend($1)", [oldPid!]);
		await removed;
		expect(await sharedCount()).toBe(0);
		await runtime.runOperation(async () => {
			const row = (await pool.query("SELECT pg_backend_pid() AS pid, 13 AS value")).rows[0];
			expect(row.pid).not.toBe(oldPid!);
			expect(row.value).toBe(13);
		});
		expect(await sharedCount()).toBe(1);
		expect(losses).toBe(0);
	});
	it.each(["throw", "callback", "promise"])(
		"failed physical end (%s) reports failure and retains exclusion until actual actor exit",
		async (mode) => {
			await runtime.close();
			const actor = process.env.SQLITE_RESTORE_ADMISSION_ACTOR_FILE;
			if (!actor) throw new Error("Native actor fixture required");
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
			const child = fork(actor, [url, "unused-fixture-epoch", `postgres-close-${mode}`], {
				env,
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			let diagnostic = "";
			child.stderr?.on("data", (chunk) => {
				diagnostic = (diagnostic + String(chunk)).slice(0, 2400);
			});
			const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
				child.once("exit", (code, signal) => resolve({ code, signal })),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await new Promise<unknown>((resolve, reject) => {
					child.once("message", resolve);
					child.once("error", reject);
					child.once("exit", () =>
						reject(new Error(`Native PG actor exited before evidence: ${diagnostic}`)),
					);
					timer = setTimeout(() => reject(new Error("Native PG actor evidence timeout")), 5000);
				});
				expect(result).toEqual({
					kind: "postgres-disposal-failure",
					closeRejected: true,
					runtimeCloseRejected: true,
					physicalStillOpen: true,
					losses: 1,
					callbackCount: 1,
					callbackFailed: true,
					unhandled: 0,
					promiseRejected: mode === "promise",
				});
				expect(await sharedCount()).toBe(1);
				await expect(acquirePostgresRestoreRuntimeOwnership(url)).rejects.toThrow();
				child.send({ kind: "close-and-exit" });
				expect(await exit).toEqual({ code: 0, signal: null });
				expect(await sharedCount()).toBe(0);
				const owner = await acquirePostgresRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
				} finally {
					await owner.close();
				}
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exit;
			}
		},
	);
	it("a genuine failed initial connection publishes no rows and permits a guarded retry", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		const unavailable = new URL(url);
		unavailable.pathname = "/absent_fixture_test";
		pool.options.connectionString = unavailable.toString();
		await runtime.runOperation(async () => {
			await expect(
				pool.query(
					"INSERT INTO \"User\" (id, username, \"updatedAt\") VALUES ('fixture-no-connect','fixture-no-connect',CURRENT_TIMESTAMP)",
				),
			).rejects.toThrow();
			expect(pool.totalCount).toBe(0);
			// Failed pool creation publishes no ordinary session, while the
			// enclosing accepted operation keeps its one independent guard.
			expect(await sharedCount()).toBe(1);
			pool.options.connectionString = url;
			expect((await pool.query("SELECT 17 AS value")).rows).toEqual([{ value: 17 }]);
		});
		expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
			{ count: "0" },
		]);
		expect(losses).toBe(0);
		await adapter.close();
		expect(await sharedCount()).toBe(0);
	});
	it("a real deferred-constraint COMMIT failure rolls back and leaves the guarded PG client usable", async () => {
		const client = create();
		await activate();
		await fixture.query(
			"CREATE TABLE ClientFixtureParent(id INTEGER PRIMARY KEY); CREATE TABLE ClientFixtureChild(id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES ClientFixtureParent(id) DEFERRABLE INITIALLY DEFERRED)",
		);
		try {
			await runtime.runOperation(async () => {
				await expect(
					client.$transaction(async (tx) => {
						await tx.$executeRawUnsafe("INSERT INTO ClientFixtureChild(id,parentId) VALUES(1,42)");
					}),
				).rejects.toThrow();
				expect(
					(
						await client.$queryRawUnsafe<{ count: bigint }[]>(
							"SELECT COUNT(*) AS count FROM ClientFixtureChild",
						)
					)[0]?.count,
				).toBe(0n);
				await client.$transaction((tx) =>
					tx.user.create({ data: { username: "fixture-after-commit-failure" } }),
				);
			});
			expect((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows).toEqual([
				{ count: "1" },
			]);
			expect(losses).toBe(0);
		} finally {
			await fixture.query("DROP TABLE ClientFixtureChild; DROP TABLE ClientFixtureParent");
		}
	});
	it("runtime shutdown joins an accepted in-flight native pool connection before releasing its owner", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connect = Client.prototype.connect;
		const descriptor = Object.getOwnPropertyDescriptor(Client.prototype, "connect")!;
		Object.defineProperty(Client.prototype, "connect", {
			...descriptor,
			value: function (this: Client, callback?: (error?: Error) => void) {
				if (this.constructor === Client)
					return Reflect.apply(connect, this, callback ? [callback] : []);
				return Reflect.apply(connect, this, [
					(error?: Error) => {
						entered();
						void gate.then(() => callback?.(error));
					},
				]);
			},
		});
		const work = runtime.runOperation(async () => {
			const connection = await pool.connect();
			try {
				return (await connection.query("SELECT 23 AS value")).rows[0].value;
			} finally {
				connection.release();
			}
		});
		let closed = false;
		let close: Promise<void> | undefined;
		try {
			await ready;
			close = runtime.close().then(() => {
				closed = true;
			});
			await expect(runtime.runOperation(() => pool.query("SELECT 1"))).rejects.toThrow();
			await expect(acquirePostgresRestoreRuntimeOwnership(url)).rejects.toThrow();
			expect(closed).toBe(false);
			release();
			expect(await work).toBe(23);
			await close;
			expect(closed).toBe(true);
			expect(await sharedCount()).toBe(0);
			const owner = await acquirePostgresRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		} finally {
			release();
			Object.defineProperty(Client.prototype, "connect", descriptor);
			await Promise.allSettled([work, ...(close ? [close] : [])]);
		}
	});
	it("custom native Query submission cannot bypass the guarded SQL interface", async () => {
		adapter = createRuntimePostgresAdapter(runtime);
		const driver = await runtime.runStarting(() => adapter!.connect());
		const pool = driver.underlyingDriver();
		await activate();
		await runtime.runOperation(async () => {
			const connection = await pool.connect();
			const Query = Reflect.get(Client, "Query");
			const query = new Query({ text: "SELECT 29 AS value" });
			const submit = query.submit.bind(query);
			let submitted = false;
			query.submit = (native: unknown) => {
				submitted = true;
				return submit(native);
			};
			const done = new Promise<void>((resolve) => query.once("end", resolve));
			try {
				await expect(Reflect.apply(connection.query, connection, [query])).rejects.toThrow();
				expect(submitted).toBe(false);
			} finally {
				if (submitted) await done;
				connection.release();
			}
		});
	});
});
