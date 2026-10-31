import { execFile, fork } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as admission from "../restore-runtime-admission.js";
import { openRestoreRuntime, type RestoreRuntime } from "../restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	createRuntimeSessionMetadataPrismaClient,
} from "../restore-runtime-client.js";
import { acquireSqliteRestoreRuntimeOwnership } from "../restore-runtime-sqlite.js";

describe.each([
	["ordinary", createRuntimePrismaClient],
	["session metadata", createRuntimeSessionMetadataPrismaClient],
] as const)("actual SQLite %s Prisma connection admission", (purpose, createClient) => {
	let directory: string;
	let path: string;
	let url: string;
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let losses: number;
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-runtime-prisma-"));
		path = join(directory, "fixture.db");
		url = `file:${path}`;
		const api = resolve(import.meta.dirname, "../../../..");
		const source = readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		);
		const schema = join(directory, "schema.prisma");
		const config = join(directory, "safe.config.ts");
		writeFileSync(schema, source, { mode: 0o600 });
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		const env = Object.fromEntries(
			// Keep synthetic actor logs in the caller's private evidence directory.
			// No database URL, provider secret, or dotenv setting is inherited.
			["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		await promisify(execFile)(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				url,
			],
			{
				cwd: directory,
				env: { ...env, DATABASE_URL: url, CHECKPOINT_DISABLE: "1" },
				timeout: 60000,
			},
		);
		chmodSync(path, 0o600);
	}, 90000);
	beforeEach(async () => {
		const main = new Database(path);
		main.pragma("journal_mode = WAL");
		main.exec('DELETE FROM "User"');
		main.close();
		losses = 0;
		runtime = await openRestoreRuntime({
			databaseUrl: url,
			onUnavailable: () => {
				losses++;
			},
		});
		native = createClient(runtime);
	});
	afterEach(async () => {
		await native?.close();
		await runtime?.close();
	});
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	async function activate() {
		await runtime.bindDestination("fixture-destination");
		await runtime.activate();
	}
	function persistedCount() {
		const main = new Database(path, { readonly: true });
		try {
			return (main.prepare('SELECT COUNT(*) AS count FROM "User"').get() as { count: number })
				.count;
		} finally {
			main.close();
		}
	}
	it(`uses nonblocking native calls for guarded ${purpose} connections`, async () => {
		await activate();
		const connect = PrismaBetterSqlite3.prototype.connect;
		let observed = -1;
		const hook = vi
			.spyOn(PrismaBetterSqlite3.prototype, "connect")
			.mockImplementation(async function (this: PrismaBetterSqlite3) {
				const driver = await connect.call(this);
				const db = Reflect.get(driver, "client") as Database.Database;
				observed = Number(db.pragma("busy_timeout", { simple: true }));
				return driver;
			});
		try {
			await runtime.runOperation(() => native.prisma.user.count());
			expect(observed).toBe(0);
		} finally {
			hook.mockRestore();
		}
	});
	it("does not hold a DELETE-mode control read across an asynchronous native ownership wait", async () => {
		const writer = new Database(path, { timeout: 0 });
		writer.pragma("journal_mode = DELETE");
		await activate();
		let releaseWriter!: () => void;
		let enteredWriter!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			enteredWriter = resolve;
		});
		let committed = false;
		let failure: string | undefined;
		// An already-admitted producer uses a real zero-wait native writer. Its
		// release is queued at the actual control BEGIN, not a wall-clock sleep.
		const writing = runtime.runOperation(async () => {
			enteredWriter();
			await release;
			try {
				writer.exec("BEGIN IMMEDIATE");
				writer.exec(
					"INSERT INTO User (id, username, createdAt, updatedAt) VALUES ('control-read-race', 'control-read-race', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
				);
				writer.exec("COMMIT");
				committed = true;
			} catch (error) {
				failure = error instanceof Database.SqliteError ? error.code : "unknown";
				if (writer.inTransaction) writer.exec("ROLLBACK");
			}
		});
		await entered;
		const exec = Database.prototype.exec;
		let armed = true;
		const observed = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const result = exec.call(this, sql);
			if (armed && this.name === path && sql === "BEGIN") {
				armed = false;
				queueMicrotask(releaseWriter);
			}
			return result;
		});
		try {
			await runtime.runOperation(async () => undefined);
			await writing;
			expect(armed).toBe(false);
			expect(failure).toBeUndefined();
			expect(committed).toBe(true);
			expect(persistedCount()).toBe(1);
			expect(losses).toBe(0);
		} finally {
			releaseWriter();
			await writing;
			observed.mockRestore();
			writer.close();
		}
	});
	it("real CRUD succeeds under trusted bootstrap then running tickets without replacing its connection", async () => {
		await runtime.runStarting(async () => {
			await native.prisma.$connect();
			await native.prisma.user.create({ data: { id: "fixture-1", username: "fixture-one" } });
		});
		await activate();
		await runtime.runOperation(async () => {
			expect(await native.prisma.user.count()).toBe(1);
			await native.prisma.user.update({
				where: { id: "fixture-1" },
				data: { username: "fixture-updated" },
			});
			await native.prisma.user.delete({ where: { id: "fixture-1" } });
			expect(await native.prisma.user.count()).toBe(0);
		});
	});
	it("a structurally cloned runtime cannot construct an ordinary database client", () => {
		expect(() => createClient({ ...runtime })).toThrow("Restore runtime admission is unavailable.");
		expect(persistedCount()).toBe(0);
	});
	it("transient DELETE-mode control contention refuses new work without losing the native owner", async () => {
		const writer = new Database(path, { timeout: 0 });
		writer.pragma("journal_mode = DELETE");
		await activate();
		writer.exec("BEGIN EXCLUSIVE");
		try {
			const observer = new Database(path, { timeout: 0 });
			try {
				expect(() => observer.prepare("SELECT * FROM RestoreRuntimeControl").all()).toThrowError(
					/database is locked/,
				);
			} finally {
				observer.close();
			}
			let entered = false;
			await expect(
				runtime.runOperation(() => {
					entered = true;
				}),
			).rejects.toThrow();
			expect(entered).toBe(false);
			expect(losses).toBe(0);
		} finally {
			writer.exec("ROLLBACK");
			writer.close();
		}
		await runtime.runOperation(() =>
			native.prisma.user.create({ data: { username: "fixture-after-busy" } }),
		);
		expect(persistedCount()).toBe(1);
		expect(losses).toBe(0);
	});
	it.each(["statement", "commit"] as const)(
		"terminal loss in the final guard-to-SQL microtask gap fences a native %s",
		async (mode) => {
			await activate();
			await native.close();
			let inject = false,
				armed = false,
				injected = false;
			const contextOf = admission.getRestoreRuntimeClientContext;
			vi.spyOn(admission, "getRestoreRuntimeClientContext").mockImplementation((actor) => {
				const context = contextOf(actor);
				return Object.freeze({
					...context,
					assertTicket: () => {
						context.assertTicket();
						if (armed) {
							armed = false;
							injected = true;
							queueMicrotask(context.unavailable);
						}
					},
				});
			});
			const connect = PrismaBetterSqlite3.prototype.connect;
			vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
				this: PrismaBetterSqlite3,
			) {
				const driver = await connect.call(this);
				const query = driver.queryRaw.bind(driver);
				vi.spyOn(driver, "queryRaw").mockImplementation(async (statement) => {
					const result = await query(statement);
					if (inject && statement.sql.includes("FROM SqliteRestoreStorageBinding")) armed = true;
					return result;
				});
				return driver;
			});
			native = createClient(runtime);
			try {
				await runtime.runOperation(async () => {
					await native.prisma.$connect();
					if (mode === "statement") {
						inject = true;
						await expect(
							native.prisma.$executeRawUnsafe(
								"INSERT INTO User (id, username, createdAt, updatedAt) VALUES ('fixture-gap', 'fixture-gap', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
							),
						).rejects.toThrow();
					} else {
						await expect(
							native.prisma.$transaction(async (tx) => {
								await tx.user.create({ data: { username: "fixture-gap" } });
								inject = true;
							}),
						).rejects.toThrow();
					}
				});
				expect(injected).toBe(true);
				expect(losses).toBe(1);
				expect(persistedCount()).toBe(0);
			} finally {
				vi.restoreAllMocks();
			}
		},
	);
	it("directly returned lazy Prisma queries execute inside starting, ordinary and nested tickets", async () => {
		await runtime.runStarting(() =>
			native.prisma.user.create({ data: { id: "fixture-lazy", username: "fixture-lazy" } }),
		);
		await activate();
		expect(await runtime.runOperation(() => native.prisma.user.count())).toBe(1);
		await runtime.runOperation(() =>
			runtime.runOperation(() =>
				native.prisma.user.update({
					where: { id: "fixture-lazy" },
					data: { username: "fixture-lazy-updated" },
				}),
			),
		);
		expect(persistedCount()).toBe(1);
	});
	it("missing and inactive inherited tickets cannot issue real SQL", async () => {
		await activate();
		await expect(
			native.prisma.user.create({ data: { username: "fixture-refused" } }),
		).rejects.toThrow();
		let release!: () => void;
		const later = new Promise<void>((resolve) => {
			release = resolve;
		});
		let orphan!: Promise<unknown>;
		await runtime.runOperation(async () => {
			await native.prisma.$connect();
			orphan = later.then(() =>
				native.prisma.user.create({ data: { username: "fixture-orphan" } }),
			);
		});
		release();
		await expect(orphan).rejects.toThrow();
		expect(persistedCount()).toBe(0);
	});
	it.each([
		{ method: "query", terminal: "rollback" },
		{ method: "execute", terminal: "rollback" },
		{ method: "query", terminal: "commit" },
		{ method: "execute", terminal: "commit" },
		{ method: "query", terminal: "commit-gap" },
		{ method: "execute", terminal: "commit-gap" },
	] as const)(
		"fences pending $method after native $terminal while its runtime ticket remains valid",
		async ({ method, terminal }) => {
			await activate();
			await native.close();
			let armed = false,
				held = false,
				nativeClosed = false;
			let enter!: () => void, release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const originalContext = admission.getRestoreRuntimeClientContext;
			vi.spyOn(admission, "getRestoreRuntimeClientContext").mockImplementation((value) => {
				const context = originalContext(value);
				return {
					...context,
					assertOwned: async () => {
						await context.assertOwned();
						if (armed && !held) {
							held = true;
							enter();
							await released;
						}
					},
				};
			});
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				const statement = prepare.call(this, sql);
				if (this.name === path && sql === (terminal === "rollback" ? "ROLLBACK" : "COMMIT")) {
					const run = statement.run;
					statement.run = function (this: Database.Statement, ...args: unknown[]) {
						const result = Reflect.apply(run, this, args);
						if (armed) {
							nativeClosed = true;
							if (terminal === "commit-gap") release();
						}
						return result;
					} as typeof statement.run;
				}
				return statement;
			});
			native = createClient(runtime);
			let pending: Promise<boolean> | undefined;
			let finished: Promise<boolean> | undefined;
			try {
				await runtime.runOperation(async () => {
					finished = native.prisma
						.$transaction(async (tx) => {
							armed = true;
							const query =
								method === "query"
									? tx.user.create({
											data: { id: "late-transaction", username: "late-transaction" },
										})
									: tx.$executeRawUnsafe(
											"INSERT INTO User(id,username,createdAt,updatedAt) VALUES('late-transaction','late-transaction',0,0)",
										);
							pending = query.then(
								() => true,
								() => false,
							);
							await entered;
							if (terminal === "rollback") throw new Error("Synthetic callback failure");
						})
						.then(
							() => true,
							() => false,
						);
					await vi.waitFor(() => expect(nativeClosed).toBe(true), { timeout: 2000, interval: 5 });
					release();
					expect(await finished).toBe(terminal !== "rollback");
					expect(await pending).toBe(false);
					expect(persistedCount()).toBe(0);
					expect(losses).toBe(0);
					await native.prisma.user.create({
						data: { id: "after-transaction", username: "after-transaction" },
					});
					expect(persistedCount()).toBe(1);
				});
			} finally {
				release();
				await pending;
				await finished;
				vi.restoreAllMocks();
			}
		},
	);
	it("actual interactive commit and rollback preserve the transaction mutex for later work", async () => {
		await activate();
		await runtime.runOperation(async () => {
			await native.prisma.$transaction(async (tx) => {
				await tx.user.create({ data: { username: "fixture-committed" } });
			});
			await expect(
				native.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-aborted" } });
					throw new Error("Synthetic abort");
				}),
			).rejects.toThrow("Synthetic abort");
			expect(await native.prisma.user.count()).toBe(1);
		});
	});
	it.skipIf(purpose !== "ordinary")(
		"preserves native busy provenance when its guarded transaction ends during retry",
		async () => {
			await activate();
			const writer = new Database(path, { timeout: 0 });
			let callbacks = 0;
			try {
				await runtime.runOperation(async () => {
					const error = await native.prisma
						.$transaction(
							async (tx) => {
								callbacks++;
								writer.exec("BEGIN IMMEDIATE");
								await tx.user.create({ data: { username: "never-published-busy" } });
							},
							{ timeout: 100 },
						)
						.then(
							() => undefined,
							(error) => error,
						);
					expect(error).toMatchObject({
						code: "P1008",
						meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
					});
					expect(callbacks).toBe(1);
					expect(persistedCount()).toBe(0);
					writer.exec("ROLLBACK");
					expect(await native.prisma.user.count()).toBe(0);
					await native.prisma.user.create({ data: { username: "safe-after-busy" } });
					expect(persistedCount()).toBe(1);
					expect(losses).toBe(0);
				});
			} finally {
				if (writer.inTransaction) writer.exec("ROLLBACK");
				writer.close();
			}
		},
	);
	it("normal admission closure permits already accepted transaction statements and commit", async () => {
		await activate();
		await runtime.runOperation(async () => {
			await native.prisma.$transaction(async (tx) => {
				runtime.closeAdmission();
				await tx.user.create({ data: { username: "fixture-accepted" } });
			});
		});
		expect(persistedCount()).toBe(1);
	});
	it("actual native loss fences borrowed statements and permits rollback without publishing prospective rows", async () => {
		await activate();
		await runtime.runOperation(async () => {
			await expect(
				native.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-not-published" } });
					const coordination = `${path}.arr-restore-runtime`;
					renameSync(
						join(coordination, "operations.sqlite3"),
						join(coordination, "retained-operations.sqlite3"),
					);
					await tx.user.create({ data: { username: "fixture-fenced" } });
				}),
			).rejects.toThrow();
		});
		expect(persistedCount()).toBe(0);
		// Restore only this disposable fixture's original inode after all native
		// actors close; it is not a live repair or new ownership capability.
		await native.close();
		await runtime.close();
		const coordination = `${path}.arr-restore-runtime`;
		renameSync(
			join(coordination, "retained-operations.sqlite3"),
			join(coordination, "operations.sqlite3"),
		);
	});
	it.each([
		{ terminal: "disconnect", method: "read" },
		{ terminal: "disconnect", method: "write" },
		{ terminal: "close", method: "read" },
		{ terminal: "close", method: "write" },
	] as const)(
		"local $terminal rejects pending $method without revoking the runtime",
		async ({ terminal, method }) => {
			await activate();
			await native.close();
			let armed = false;
			let held = false;
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const originalContext = admission.getRestoreRuntimeClientContext;
			vi.spyOn(admission, "getRestoreRuntimeClientContext").mockImplementation((value) => {
				const context = originalContext(value);
				return {
					...context,
					assertOwned: async () => {
						await context.assertOwned();
						if (armed && !held) {
							held = true;
							enter();
							await released;
						}
					},
				};
			});
			const connect = PrismaBetterSqlite3.prototype.connect;
			let physical: Database.Database | undefined;
			vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
				this: PrismaBetterSqlite3,
			) {
				const driver = await connect.call(this);
				physical = Reflect.get(driver, "client") as Database.Database;
				return driver;
			});
			native = createClient(runtime);
			let pending: Promise<boolean> | undefined;
			let closing: Promise<void> | undefined;
			try {
				await runtime.runOperation(async () => {
					await native.prisma.user.count();
					armed = true;
					pending = (
						method === "read"
							? native.prisma.user.count()
							: native.prisma.user.create({ data: { username: "late-client-write" } })
					).then(
						() => true,
						() => false,
					);
					await entered;
					closing = terminal === "disconnect" ? native.prisma.$disconnect() : native.close();
					// Observe actual driver disposal, not a forced close or a timed sleep.
					await vi.waitFor(() => expect(physical?.open).toBe(false), {
						timeout: 2000,
						interval: 5,
					});
					release();
					expect(await pending).toBe(false);
					await closing;
					expect(losses).toBe(0);
					expect(persistedCount()).toBe(0);
					const next = createClient(runtime);
					try {
						expect(await next.prisma.user.count()).toBe(0);
					} finally {
						await next.close();
					}
				});
			} finally {
				release();
				await pending;
				await closing;
				vi.restoreAllMocks();
			}
		},
	);
	it("still fences coordination replacement during an awaited live-client guard", async () => {
		await activate();
		await native.close();
		let armed = false;
		let held = false;
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalContext = admission.getRestoreRuntimeClientContext;
		vi.spyOn(admission, "getRestoreRuntimeClientContext").mockImplementation((value) => {
			const context = originalContext(value);
			return {
				...context,
				assertOwned: async () => {
					await context.assertOwned();
					if (armed && !held) {
						held = true;
						enter();
						await released;
					}
				},
			};
		});
		native = createClient(runtime);
		const operations = join(`${path}.arr-restore-runtime`, "operations.sqlite3");
		const retained = join(directory, "retained-operations.sqlite3");
		let replaced = false;
		let pending: Promise<boolean> | undefined;
		try {
			await runtime.runOperation(async () => {
				await native.prisma.user.count();
				armed = true;
				pending = native.prisma.user.count().then(
					() => true,
					() => false,
				);
				await entered;
				// Only synthetic coordination files are replaced, after the owner proof.
				renameSync(operations, retained);
				replaced = true;
				writeFileSync(operations, "", { mode: 0o600 });
				release();
				expect(await pending).toBe(false);
				expect(losses).toBe(1);
			});
			await expect(runtime.runOperation(() => native.prisma.user.count())).rejects.toThrow();
			expect(persistedCount()).toBe(0);
		} finally {
			release();
			await pending;
			if (replaced) {
				rmSync(operations, { force: true });
				renameSync(retained, operations);
			}
			vi.restoreAllMocks();
		}
	});
	it("disconnect and reconnect rejoin native participation before issuing later queries", async () => {
		await activate();
		await runtime.runOperation(async () => {
			await native.prisma.$connect();
			await native.prisma.$disconnect();
			await native.prisma.$connect();
			await native.prisma.user.create({ data: { username: "fixture-reconnected" } });
		});
		expect(persistedCount()).toBe(1);
	});
	it("startup failure can close its registered client before the next owner starts", async () => {
		await expect(
			runtime.runStarting(async () => {
				await native.prisma.$connect();
				throw new Error("Synthetic startup failure");
			}),
		).rejects.toThrow("Synthetic startup failure");
		await runtime.close();
		const owner = await acquireSqliteRestoreRuntimeOwnership(url);
		try {
			expect(await owner.tryAcquireExclusive()).toBe(true);
		} finally {
			await owner.close();
		}
		await expect(native.prisma.$connect()).rejects.toThrow();
	});
	it("runtime close joins and physically disposes its registered client before the next owner starts", async () => {
		await activate();
		await runtime.runOperation(async () => {
			await native.prisma.user.count();
		});
		await runtime.close();
		const owner = await acquireSqliteRestoreRuntimeOwnership(url);
		try {
			expect(await owner.tryAcquireExclusive()).toBe(true);
		} finally {
			await owner.close();
		}
		await expect(native.prisma.$connect()).rejects.toThrow();
	});
	it.each([
		["missing journal", "RestoreRuntimeControl", 'DELETE FROM "RestoreRuntimeControl"'],
		[
			"malformed journal",
			"RestoreRuntimeControl",
			"UPDATE \"RestoreRuntimeControl\" SET phase = 'invalid-fixture-phase'",
		],
		[
			"changed destination",
			"RestoreRuntimeControl",
			"UPDATE \"RestoreRuntimeControl\" SET destinationInstallationId = 'other-fixture-destination'",
		],
		["missing binding", "SqliteRestoreStorageBinding", 'DELETE FROM "SqliteRestoreStorageBinding"'],
	])(
		"%s fences an already-open actual connection and immediately signals loss",
		async (_category, table, mutation) => {
			await activate();
			await runtime.runOperation(async () => {
				await native.prisma.user.count();
				const fixture = new Database(path);
				const original = fixture.prepare(`SELECT * FROM "${table}"`).get() as Record<
					string,
					unknown
				>;
				try {
					fixture.exec(mutation);
					await expect(native.prisma.user.count()).rejects.toThrow();
					expect(losses).toBe(1);
					await expect(
						native.prisma.user.create({ data: { username: "fixture-fenced-corruption" } }),
					).rejects.toThrow();
					expect(persistedCount()).toBe(0);
				} finally {
					const columns = Object.keys(original);
					fixture.exec(`DELETE FROM "${table}"`);
					fixture
						.prepare(
							`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
						)
						.run(original);
					fixture.close();
				}
			});
			await expect(runtime.runOperation(() => native.prisma.user.count())).rejects.toThrow();
			expect(losses).toBe(1);
		},
	);
	it("a real deferred-constraint COMMIT failure rolls back and leaves the actual client usable", async () => {
		await activate();
		const fixture = new Database(path);
		fixture.exec(
			"CREATE TABLE ClientFixtureParent (id INTEGER PRIMARY KEY); CREATE TABLE ClientFixtureChild (id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES ClientFixtureParent(id) DEFERRABLE INITIALLY DEFERRED)",
		);
		try {
			await runtime.runOperation(async () => {
				await expect(
					native.prisma.$transaction(async (tx) => {
						await tx.$executeRawUnsafe(
							"INSERT INTO ClientFixtureChild (id, parentId) VALUES (1, 42)",
						);
					}),
				).rejects.toThrow();
				await native.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-after-failed-commit" } });
				});
			});
			expect(fixture.prepare("SELECT COUNT(*) AS count FROM ClientFixtureChild").get()).toEqual({
				count: 0,
			});
			expect(persistedCount()).toBe(1);
			expect(losses).toBe(0);
		} finally {
			fixture.exec("DROP TABLE ClientFixtureChild; DROP TABLE ClientFixtureParent");
			fixture.close();
		}
	});
	it("fenced COMMIT with failed rollback disposes the physical driver and rejects its queued transaction promptly", async () => {
		await activate();
		let queued!: () => void;
		const queuedReady = new Promise<void>((resolve) => {
			queued = resolve;
		});
		const connect = PrismaBetterSqlite3.prototype.connect;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			const start = driver.startTransaction.bind(driver);
			let starts = 0;
			vi.spyOn(driver, "startTransaction").mockImplementation((isolation) => {
				if (++starts === 2) queued();
				return start(isolation);
			});
			return driver;
		});
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (sql === "ROLLBACK") throw new Error("Synthetic native rollback failure");
			return prepare.call(this, sql);
		});
		let written!: () => void;
		const writtenReady = new Promise<void>((resolve) => {
			written = resolve;
		});
		let release!: () => void;
		const releaseFirst = new Promise<void>((resolve) => {
			release = resolve;
		});
		const coordination = `${path}.arr-restore-runtime`;
		let renamed = false;
		let secondCallback = false;
		try {
			const first = runtime.runOperation(() =>
				native.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-cleanup-failure" } });
					written();
					await releaseFirst;
					renameSync(
						join(coordination, "operations.sqlite3"),
						join(coordination, "retained-operations.sqlite3"),
					);
					renamed = true;
				}),
			);
			const firstResult = first.then(
				() => "resolved",
				() => "rejected",
			);
			await writtenReady;
			const second = runtime.runOperation(() =>
				native.prisma.$transaction(async (tx) => {
					secondCallback = true;
					await tx.user.create({ data: { username: "fixture-queued-unsafe" } });
				}),
			);
			const secondResult = second.then(
				() => "resolved",
				() => "rejected",
			);
			await queuedReady;
			const started = performance.now();
			release();
			expect(await firstResult).toBe("rejected");
			expect(await secondResult).toBe("rejected");
			expect(performance.now() - started).toBeLessThan(1000);
			expect(secondCallback).toBe(false);
			expect(persistedCount()).toBe(0);
			expect(losses).toBe(1);
		} finally {
			release();
			vi.restoreAllMocks();
			await native.close();
			await runtime.close();
			if (renamed)
				renameSync(
					join(coordination, "retained-operations.sqlite3"),
					join(coordination, "operations.sqlite3"),
				);
		}
	});
	it("native COMMIT recovery failure signals runtime loss instead of silently leaving admission open", async () => {
		await activate();
		const fixture = new Database(path);
		fixture.exec(
			"CREATE TABLE ClientFixtureParent (id INTEGER PRIMARY KEY); CREATE TABLE ClientFixtureChild (id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES ClientFixtureParent(id) DEFERRABLE INITIALLY DEFERRED)",
		);
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (sql === "ROLLBACK") throw new Error("Synthetic native rollback failure");
			return prepare.call(this, sql);
		});
		try {
			await runtime.runOperation(async () => {
				await expect(
					native.prisma.$transaction(async (tx) => {
						await tx.$executeRawUnsafe(
							"INSERT INTO ClientFixtureChild (id, parentId) VALUES (1, 42)",
						);
					}),
				).rejects.toThrow();
				expect(losses).toBe(1);
			});
			await expect(
				runtime.runOperation(() =>
					native.prisma.user.create({ data: { username: "fixture-after-poison" } }),
				),
			).rejects.toThrow();
			expect(fixture.prepare("SELECT COUNT(*) AS count FROM ClientFixtureChild").get()).toEqual({
				count: 0,
			});
			expect(persistedCount()).toBe(0);
		} finally {
			vi.restoreAllMocks();
			fixture.exec("DROP TABLE ClientFixtureChild; DROP TABLE ClientFixtureParent");
			fixture.close();
		}
	});
	it("loss immediately after native BEGIN with failed rollback physically closes the borrowed driver", async () => {
		await activate();
		const coordination = `${path}.arr-restore-runtime`;
		const connect = PrismaBetterSqlite3.prototype.connect;
		let actual!: Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;
		let renamed = false;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			actual = await connect.call(this);
			const start = actual.startTransaction.bind(actual);
			vi.spyOn(actual, "startTransaction").mockImplementation(async (isolation) => {
				const transaction = await start(isolation);
				renameSync(
					join(coordination, "operations.sqlite3"),
					join(coordination, "retained-operations.sqlite3"),
				);
				renamed = true;
				return transaction;
			});
			return actual;
		});
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (sql === "ROLLBACK") throw new Error("Synthetic native rollback failure");
			return prepare.call(this, sql);
		});
		let callbackRan = false;
		try {
			await runtime.runOperation(async () => {
				await expect(
					native.prisma.$transaction(async (tx) => {
						callbackRan = true;
						await tx.user.create({ data: { username: "fixture-unaccepted" } });
					}),
				).rejects.toThrow();
			});
			expect(callbackRan).toBe(false);
			expect(losses).toBe(1);
			await expect(actual.queryRaw({ sql: "SELECT 1", args: [], argTypes: [] })).rejects.toThrow();
			expect(persistedCount()).toBe(0);
		} finally {
			vi.restoreAllMocks();
			await native.close();
			await runtime.close();
			if (renamed)
				renameSync(
					join(coordination, "retained-operations.sqlite3"),
					join(coordination, "operations.sqlite3"),
				);
		}
	});
	it("failed physical closure retains SHARED exclusion until the actual actor exits", async () => {
		await native.close();
		await runtime.close();
		const actorFile = process.env.SQLITE_RESTORE_ADMISSION_ACTOR_FILE;
		if (!actorFile) throw new Error("Native client actor fixture required");
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		const child = fork(actorFile, [url, "unused-fixture-epoch", "client-close-failure"], {
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
					reject(new Error(`Native client actor exited before evidence: ${diagnostic}`)),
				);
				timer = setTimeout(() => reject(new Error("Native client actor evidence timeout")), 5000);
			});
			expect(result).toEqual({
				kind: "disposal-failure",
				closeRejected: true,
				runtimeCloseRejected: true,
				physicalStillOpen: true,
				losses: 1,
			});
			const probe = new Database(join(`${path}.arr-restore-runtime`, "operations.sqlite3"), {
				timeout: 0,
				fileMustExist: true,
			});
			try {
				expect(() => probe.exec("BEGIN EXCLUSIVE")).toThrow();
			} finally {
				if (probe.inTransaction) probe.exec("ROLLBACK");
				probe.close();
			}
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			child.send({ kind: "close-and-exit" });
			expect(await exit).toEqual({ code: 0, signal: null });
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
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
	});
	it("runtime shutdown joins an in-flight real connection before releasing the owner", async () => {
		await activate();
		let entered!: () => void;
		const connectionReady = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const finishConnect = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connect = PrismaBetterSqlite3.prototype.connect;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			entered();
			await finishConnect;
			return driver;
		});
		const work = runtime.runOperation(() => native.prisma.user.count());
		let close: Promise<void> | undefined;
		try {
			await connectionReady;
			let closed = false;
			close = runtime.close().then(() => {
				closed = true;
			});
			await expect(runtime.runOperation(() => native.prisma.user.count())).rejects.toThrow();
			expect(closed).toBe(false);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			release();
			expect(await work).toBe(0);
			await close;
			const next = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await next.tryAcquireExclusive()).toBe(true);
			} finally {
				await next.close();
			}
		} finally {
			release();
			await work.catch(() => {});
			await close;
			vi.restoreAllMocks();
		}
	});
});
