import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { Client } from "pg";
import { envSchema } from "../../../config/env.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { SessionService } from "../../../lib/auth/session.js";
import { registerBackupMutationGuard } from "../../../lib/backup/backup-mutation-gate.js";
import { encryptBackupData } from "../../../lib/backup/backup-crypto.js";
import { exportDatabase } from "../../../lib/backup/backup-database.js";
import { BackupService } from "../../../lib/backup/backup-service.js";
import { preparePublicationCredentialFixture } from "../../../lib/backup/__tests__/fixtures/restore-runtime-replacement-actor.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { prismaPlugin } from "../../../plugins/prisma.js";
import { registerSessionValidationHook } from "../../../server.js";
import { registerBackupRoutes } from "../../backup.js";
import { registerAuthRoutes } from "../../auth.js";

// Owned synthetic fixtures only. No buildServer, scheduler, provider or live URL.
const api = resolve(import.meta.dirname, "../../../..");
export const fixtureBackupPassword = "synthetic-backup-password";
type FixtureMode = "wal" | "delete" | "postgres";
export const restoreHttpFixtureModes: readonly FixtureMode[] = process.env
	.RESTORE_RUNTIME_TEST_PG_URL
	? ["postgres"]
	: ["wal", "delete"];

function ownedPostgres() {
	const connection = process.env.RESTORE_RUNTIME_TEST_PG_URL;
	const project = process.env.RESTORE_RUNTIME_TEST_PROJECT;
	if (!connection || !project) throw new Error("Owned PostgreSQL fixture required");
	const url = new URL(connection);
	if (
		url.hostname !== "127.0.0.1" ||
		!/^\/arr_native_[a-f0-9]{32}_test$/.test(url.pathname) ||
		url.search ||
		url.hash ||
		resolve(process.cwd()) !== project ||
		!project.startsWith(join(tmpdir(), "arr-native-postgres-test-")) ||
		!project.endsWith("/artifacts/restore-application-admission-native")
	)
		throw new Error("Explicit runner-owned PostgreSQL database and working directory required");
	return { connection, project };
}

export async function createRestoreHttpTemplate() {
	const directory = await mkdtemp(join(tmpdir(), "arr-restore-publication-http-template-"));
	await chmod(directory, 0o700);
	if (process.env.RESTORE_RUNTIME_TEST_PG_URL) {
		ownedPostgres(); // The runner has already created the full native PG schema.
		return directory;
	}
	const schema = join(directory, "schema.prisma"),
		config = join(directory, "safe.config.ts");
	await writeFile(
		schema,
		(await readFile(join(api, "prisma/schema.prisma"), "utf8")).replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		),
		{ mode: 0o600 },
	);
	await writeFile(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
		mode: 0o600,
	});
	const url = `file:${join(directory, "main.db")}`;
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
			timeout: 60000,
			env: {
				PATH: process.env.PATH,
				LANG: "C.UTF-8",
				TZ: "UTC",
				NODE_ENV: "test",
				CI: "true",
				DOTENV_CONFIG_PATH: "/dev/null",
				CHECKPOINT_DISABLE: "1",
				DATABASE_URL: url,
			},
		},
	);
	await chmod(join(directory, "main.db"), 0o600);
	return directory;
}

export async function bootRestoreHttpFixture(
	template: string,
	mode: FixtureMode,
	existing?: string,
	options: { routes?: boolean; passwordLogin?: boolean; createSession?: boolean } = {},
) {
	if (!template.startsWith(join(tmpdir(), "arr-restore-publication-http-template-")))
		throw new Error("Owned HTTP schema template required");
	const postgres = mode === "postgres" ? ownedPostgres() : undefined;
	const directory = postgres
		? join(postgres.project, "data")
		: (existing ?? (await mkdtemp(join(tmpdir(), "arr-restore-publication-http-"))));
	if (
		postgres
			? existing !== undefined && existing !== directory
			: !directory.startsWith(join(tmpdir(), "arr-restore-publication-http-")) ||
				resolve(directory) !== directory
	)
		throw new Error("Owned HTTP installation directory required");
	if (!existing) {
		if (postgres) {
			await mkdir(directory, { mode: 0o700 });
			const client = new Client({ connectionString: postgres.connection });
			try {
				await client.connect();
				const tables = (
					await client.query(
						"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
					)
				).rows as Array<{ tablename: string }>;
				if (
					tables.length !== 95 ||
					tables.some(({ tablename }) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename))
				)
					throw new Error("Exact owned 95-model schema required before fixture reset");
				await client.query(
					`TRUNCATE TABLE ${tables.map(({ tablename }) => `"${tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
				);
				await client.query(
					'INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,\'idle\')',
				);
			} finally {
				await client.end();
			}
		}
		await chmod(directory, 0o700);
		if (!postgres) {
			await copyFile(join(template, "main.db"), join(directory, "main.db"));
			await chmod(join(directory, "main.db"), 0o600);
		}
		await writeFile(
			join(directory, "secrets.json"),
			JSON.stringify({
				encryptionKey: "64".repeat(32),
				sessionCookieSecret: "synthetic-cookie-signature-key-32-characters",
			}),
			{ mode: 0o600 },
		);
	}
	const app = Fastify({ logger: false });
	const env = envSchema.parse({
		NODE_ENV: "test",
		DATABASE_URL: postgres?.connection ?? `file:${join(directory, "main.db")}`,
		SQLITE_JOURNAL_MODE: mode === "postgres" ? "preserve" : mode,
		COOKIE_SECURE: "false",
	});
	app.decorate("config", env);
	app.decorate("encryptor", new Encryptor("64".repeat(32)));
	app.decorate("secretsSynchronized", true);
	registerBackupMutationGuard(app);
	await app.register(prismaPlugin);
	await app.register(lifecyclePlugin);
	await app.register(fastifyCookie, { secret: "synthetic-cookie-signature-key-32-characters" });
	await app.register(fastifyRateLimit, { max: 1000, timeWindow: "1 minute" });
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.decorate("sessionService", new SessionService(app.prisma, env));
	app.addHook("preClose", async () => app.sessionService.closeValidationAdmission());
	app.addHook("onClose", async () => app.sessionService.drainValidations());
	registerSessionValidationHook(app);
	if (options.passwordLogin) await app.register(registerAuthRoutes, { prefix: "/auth" });
	if (options.routes === false) {
		app.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser) return reply.code(401).send({ error: "Unauthorized" });
		});
	} else {
		await app.register(async (protectedApp) => {
			protectedApp.addHook("preHandler", async (request, reply) => {
				if (!request.currentUser) return reply.code(401).send({ error: "Unauthorized" });
			});
			await protectedApp.register(registerBackupRoutes, { prefix: "/api/backup" });
		});
	}
	await app.restoreRuntime.bindDestination("synthetic-destination");
	await app.restoreRuntime.activate();
	const session =
		options.createSession === false
			? null
			: await app.restoreRuntime.runOperation(async () => {
					if (!existing)
						await app.prisma.user.create({
							data: {
								id: "publication-owner",
								username: "synthetic-old",
								hashedPassword: "synthetic-not-login-password",
							},
						});
					return app.sessionService.createSession("publication-owner");
				});
	return {
		app,
		directory,
		cookie: session ? `arr_session=${encodeURIComponent(app.signCookie(session.token))}` : "",
		async dispose() {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** Only timing pauses: native SQL and branded preparation still execute once. */
function installPublicCrashPoint(
	fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>,
	stage: string,
	restorePosts: () => number,
) {
	if (
		![
			"crash-before-pending",
			"crash-after-pending",
			"crash-before-commit",
			"crash-after-commit",
		].includes(stage)
	)
		throw new Error("Known public crash stage required");
	const barrier = () => {
		writeSync(
			1,
			`${JSON.stringify({ kind: "public-restore-crash-barrier", stage, pid: process.pid, restorePosts: restorePosts() })}\n`,
		);
		// Only the parent's joined SIGKILL ends this real publisher. Never
		// acknowledge HTTP completion or return a fabricated native outcome.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		throw new Error("Public crash barrier cannot resume publication");
	};
	if (stage === "crash-before-pending") {
		const prepare = BackupService.prototype.prepareBackupRestore;
		BackupService.prototype.prepareBackupRestore = async function (...args) {
			const prepared = await prepare.apply(this, args);
			let entered!: () => void;
			const held = new Promise<void>((resolve) => {
				entered = resolve;
			});
			void fixture.app.restoreRuntime
				.runIndependentOperation(async () => {
					await fixture.app.prisma.user.count();
					entered();
					await new Promise<void>(() => {});
				})
				.catch(() => {});
			await held;
			setImmediate(() => {
				void (async () => {
					for (;;) {
						const admitted = await fixture.app.restoreRuntime
							.runIndependentOperation(() => 0)
							.then(
								() => true,
								() => false,
							);
						if (!admitted) barrier();
						await new Promise<void>((resolve) => setTimeout(resolve, 5));
					}
				})().catch(() => process.exit(1));
			});
			return prepared;
		};
		return;
	}
	const pauseBefore = (phase: unknown) => {
		if (phase === "restart-required" && stage === "crash-before-commit") barrier();
	};
	const pauseAfter = (phase: unknown) => {
		if (
			(phase === "restore-pending" && stage === "crash-after-pending") ||
			(phase === "restart-required" && stage === "crash-after-commit")
		)
			barrier();
	};
	if (fixture.app.dbProvider === "postgresql") {
		const query = Client.prototype.query;
		Client.prototype.query = new Proxy(query, {
			apply(target, receiver: Client, args: unknown[]) {
				const sql =
					typeof args[0] === "string"
						? args[0]
						: args[0] && typeof args[0] === "object"
							? Reflect.get(args[0], "text")
							: undefined;
				if (
					typeof sql !== "string" ||
					!/^\s*COMMIT\s*;?\s*$/i.test(sql) ||
					typeof args.at(-1) === "function"
				)
					return Reflect.apply(target, receiver, args);
				return (async () => {
					const before = await Reflect.apply(target, receiver, [
						'SELECT phase FROM "RestoreRuntimeControl"',
					]);
					const phase: unknown = before.rows[0]?.phase;
					pauseBefore(phase);
					const result = await Reflect.apply(target, receiver, args);
					pauseAfter(phase);
					return result;
				})();
			},
		});
	} else {
		const prepare = Database.prototype.prepare,
			exec = Database.prototype.exec;
		const path = join(fixture.directory, "main.db");
		const intercept = <T>(database: Database.Database, sql: string, execute: () => T): T => {
			if (database.name !== path || !/^\s*COMMIT\s*;?\s*$/i.test(sql)) return execute();
			const phase = (
				Reflect.apply(prepare, database, ['SELECT phase FROM "RestoreRuntimeControl"']).get() as {
					phase: string;
				}
			).phase;
			pauseBefore(phase);
			const result = execute();
			pauseAfter(phase);
			return result;
		};
		Database.prototype.exec = function (sql) {
			return intercept(this, sql, () => Reflect.apply(exec, this, [sql]));
		};
		Database.prototype.prepare = function (this: Database.Database, sql: string) {
			const statement = Reflect.apply(prepare, this, [sql]) as Database.Statement;
			if (this.name === path && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
				const database = this;
				statement.run = new Proxy(statement.run, {
					apply(target, receiver, args) {
						return intercept(database, sql, () => Reflect.apply(target, receiver, args));
					},
				});
			}
			return statement;
		} as typeof Database.prototype.prepare;
	}
}

/** A real child owns this listener/runtime. No scheduler or provider is started. */
function installPublicCloseFault(
	fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>,
	stage: string,
	restorePosts: () => number,
) {
	if (stage !== "writer-close-throw" && stage !== "writer-close-false-ack")
		throw new Error("Known public physical-close stage required");
	let reported = false;
	const fault = () => {
		if (!reported) {
			reported = true;
			writeSync(
				1,
				`${JSON.stringify({
					kind: "public-restore-close-barrier",
					stage,
					pid: process.pid,
					restorePosts: restorePosts(),
				})}\n`,
			);
		}
		if (stage === "writer-close-throw")
			throw new Error("Synthetic native publishing close failure");
	};
	if (fixture.app.dbProvider === "postgresql") {
		let publisher: Client | undefined;
		const query = Client.prototype.query,
			end = Client.prototype.end;
		Client.prototype.query = new Proxy(query, {
			apply(target, receiver: Client, args: unknown[]) {
				if (
					receiver.constructor !== Client &&
					args[0] === "SELECT pg_try_advisory_lock(1095914052,2) AS acquired"
				)
					publisher = receiver;
				return Reflect.apply(target, receiver, args);
			},
		});
		Client.prototype.end = function (this: Client, callback?: (error?: Error) => void) {
			if (this !== publisher) return Reflect.apply(end, this, callback ? [callback] : []);
			fault();
			// Deliberately fail native closure only: no synthetic SQL or publication result.
			if (callback) {
				callback();
				return;
			}
			return Promise.resolve();
		} as Client["end"];
	} else {
		const prepare = BackupService.prototype.prepareBackupRestore;
		BackupService.prototype.prepareBackupRestore = async function (...args) {
			const prepared = await prepare.apply(this, args);
			const connect = PrismaBetterSqlite3.prototype.connect;
			PrismaBetterSqlite3.prototype.connect = async function () {
				const driver = await connect.call(this);
				const native = Reflect.get(driver, "client") as Database.Database;
				if (
					native.name === join(fixture.directory, "main.db") &&
					(native.prepare('SELECT phase FROM "RestoreRuntimeControl"').get() as { phase: string })
						.phase === "restore-pending"
				) {
					driver.dispose = async () => {
						fault();
					};
				}
				return driver;
			};
			return prepared;
		};
	}
}

/** A real child owns this listener/runtime. No scheduler or provider is started. */
async function runRecoveryActor() {
	const role = process.argv[5];
	if (!process.connected || (role !== "recover" && role !== "publish"))
		throw new Error("Explicit owned recovery actor required");
	const template = process.argv[2]!,
		mode = process.argv[3],
		directory = process.argv[4]!;
	if (mode !== "wal" && mode !== "delete" && mode !== "postgres")
		throw new Error("Owned recovery database mode required");
	const fixture = await bootRestoreHttpFixture(template, mode, directory, {
		passwordLogin: true,
		createSession: false,
	});
	const stage = process.argv[6];
	const closeFault = role === "publish" && stage?.startsWith("writer-close-");
	let restorePosts = 0,
		restartRequests = 0,
		responsesFinished = 0,
		stopping = false;
	fixture.app.server.on("request", (request, response) => {
		if (
			request.method === "POST" &&
			["/api/backup/restore", "/api/backup/restore-from-file"].includes(request.url ?? "")
		) {
			restorePosts++;
			response.once("finish", () => {
				responsesFinished++;
			});
		}
	});
	if (closeFault) {
		const restart = fixture.app.lifecycle.restart.bind(fixture.app.lifecycle);
		fixture.app.lifecycle.restart = async (reason) => {
			restartRequests++;
			return restart(reason);
		};
		installPublicCloseFault(fixture, stage!, () => restorePosts);
	} else if (role === "publish") installPublicCrashPoint(fixture, stage!, () => restorePosts);
	const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
	process.on("message", (message) => {
		if (
			closeFault &&
			message &&
			typeof message === "object" &&
			Reflect.get(message, "kind") === "inspect-close"
		) {
			void (async () => {
				const ordinaryRefused = await fixture.app.restoreRuntime
					.runIndependentOperation(() => 0)
					.then(
						() => false,
						() => true,
					);
				let shutdownSettled = false,
					shutdownRefused = false;
				const shutdown = fixture.app.lifecycle.shutdown().then(
					() => {
						shutdownSettled = true;
					},
					() => {
						shutdownSettled = true;
						shutdownRefused = true;
					},
				);
				if (mode === "postgres" && stage === "writer-close-false-ack")
					await new Promise<void>((resolve) => setImmediate(resolve));
				else await shutdown;
				process.send!({
					kind: "public-restore-close-inspection",
					restorePosts,
					restartRequests,
					responsesFinished,
					ordinaryRefused,
					shutdownSettled,
					shutdownRefused,
				});
			})().catch(() => process.exit(1));
			return;
		}
		if (
			stopping ||
			!message ||
			typeof message !== "object" ||
			!("kind" in message) ||
			message.kind !== "stop"
		)
			return;
		stopping = true;
		void (async () => {
			await fixture.app.close();
			await new Promise<void>((resolve, reject) =>
				process.send!({ kind: "restore-http-recovery-stopped", restorePosts }, (error) =>
					error ? reject(error) : resolve(),
				),
			);
			process.disconnect?.();
			// Standalone test actors explicitly terminate after actual Fastify /
			// native shutdown and flushed evidence, like the managed runtime exit.
			process.exit(0);
		})().catch(() => process.exit(1));
	});
	process.send!({
		kind: role === "publish" ? "restore-http-publication-ready" : "restore-http-recovery-ready",
		address,
		pid: process.pid,
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void runRecoveryActor().catch(() => {
		process.send?.({ kind: "restore-http-recovery-failed", category: "boot-unavailable" });
		process.exit(1);
	});
}

/** Independent read-only witness, never an HTTP success/body as its own oracle. */
export async function readRestoreFixtureRows(
	fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>,
	sql: string,
): Promise<Record<string, unknown>[]> {
	if (!/^SELECT\s/i.test(sql) || sql.includes(";"))
		throw new Error("Single read-only fixture SELECT required");
	if (fixture.app.dbProvider === "postgresql") {
		const owned = ownedPostgres();
		if (
			fixture.app.config.DATABASE_URL !== owned.connection ||
			fixture.directory !== join(owned.project, "data")
		)
			throw new Error("Owned PostgreSQL witness required");
		const client = new Client({ connectionString: owned.connection });
		try {
			await client.connect();
			return (await client.query(sql)).rows;
		} finally {
			await client.end();
		}
	}
	if (!fixture.directory.startsWith(join(tmpdir(), "arr-restore-publication-http-")))
		throw new Error("Owned SQLite witness required");
	const db = new Database(join(fixture.directory, "main.db"), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
}

export async function fixtureRestoreEnvelope(
	fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>,
) {
	await preparePublicationCredentialFixture(fixture.app.restoreRuntime, fixture.app.prisma, true);
	const data = await fixture.app.restoreRuntime.runOperation(() =>
		exportDatabase(fixture.app.prisma),
	);
	data.users[0]!.username = "synthetic-restored";
	const backup = {
		version: "1.3",
		appVersion: "2.24.2",
		timestamp: "2026-10-09T00:00:00.000Z",
		data,
		secrets: { encryptionKey: "64".repeat(32), sessionCookieSecret: "synthetic-source-cookie" },
	};
	return JSON.stringify(await encryptBackupData(JSON.stringify(backup), fixtureBackupPassword));
}
