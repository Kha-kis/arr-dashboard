import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sign } from "@fastify/cookie";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRestoreRuntime } from "../lib/backup/restore-runtime-admission.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../lib/backup/runtime-schema-registry.js";
import { synchronizeSqliteRuntimeSchema } from "../lib/backup/runtime-schema-sqlite.js";

const sessionToken = "synthetic-startup-session-token";
const sessionId = createHash("sha256").update(sessionToken).digest("hex");
const cookieSecret = "synthetic-startup-cookie-secret-not-a-credential";

// Run the supported API entry, including real admission, Fastify plugins,
// Prisma and initial session cleanup. No server or cleanup doubles.
describe.skipIf(process.platform !== "linux")("standalone API date admission", () => {
	let directory: string;
	let path: string;
	let url: string;
	let port: number;
	const actors: Array<{
		child: ChildProcess;
		closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	}> = [];
	const read = (sql: string) => {
		const database = new Database(path, { fileMustExist: true });
		try {
			return database.prepare(sql).all();
		} finally {
			database.close();
		}
	};
	const change = (sql: string) => {
		const database = new Database(path, { fileMustExist: true });
		try {
			database.exec(sql);
		} finally {
			database.close();
		}
	};
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-api-date-admission-"));
		chmodSync(directory, 0o700);
		path = join(directory, "main.db");
		url = `file:${path}`;
		const reserve = createServer();
		await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
		const address = reserve.address();
		if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
		port = address.port;
		await new Promise<void>((resolve, reject) =>
			reserve.close((error) => (error ? reject(error) : resolve())),
		);
		const database = new Database(path);
		try {
			database.pragma("foreign_keys=ON");
			database.pragma("journal_mode=WAL");
			database.exec("BEGIN EXCLUSIVE");
			await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
				provider: "sqlite",
				tables: [],
			}).execute((sql) => {
				database.exec(sql);
			});
			database.exec(`DROP TABLE ArrSchemaMigrationReceipt;
				DROP TABLE ArrRuntimeDataFormatReceipt;
				INSERT INTO User(id,username,hashedPassword,createdAt,updatedAt)
				VALUES('fixture-owner','fixture-owner','opaque-fixture-password',0,0);
				INSERT INTO sessions(id,userId,expiresAt,createdAt,lastAccessedAt)
				VALUES('${sessionId}','fixture-owner',4102444800123,0,0),
				('expired-fixture','fixture-owner',0,0,0);
				INSERT INTO system_settings(id,apiPort,createdAt,updatedAt)
				VALUES(1,1,0,0);
				COMMIT;`);
		} finally {
			database.close();
		}
		// Existing Phase-A enrollment without schema/date cutover is the actual
		// legacy bypass: a valid owner journal alone must not admit cleanup.
		const runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.close();
	});
	afterEach(async () => {
		for (const actor of actors.splice(0)) {
			if (actor.child.exitCode === null && actor.child.signalCode === null)
				actor.child.kill("SIGTERM");
			const timeout = setTimeout(() => actor.child.kill("SIGKILL"), 5000);
			try {
				await actor.closed;
			} finally {
				clearTimeout(timeout);
			}
		}
		expect(directory.startsWith(join(tmpdir(), "arr-api-date-admission-"))).toBe(true);
		expect(lstatSync(directory).isSymbolicLink()).toBe(false);
		rmSync(directory, { recursive: true });
	});
	const launch = () => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx/esm"),
				fileURLToPath(new URL("../index.ts", import.meta.url)),
			],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					LANG: "C.UTF-8",
					TZ: "UTC",
					NODE_ENV: "test",
					DOTENV_CONFIG_PATH: "/dev/null",
					DATABASE_URL: url,
					API_HOST: "127.0.0.1",
					API_PORT: String(port),
					LOG_DIR: join(directory, "logs"),
					LOG_LEVEL: "fatal",
					TRASH_UPDATE_SCHEDULER_ENABLED: "false",
					DISABLE_QUI_CACHE_PREWARM: "true",
					ENCRYPTION_KEY: "01".repeat(32),
					SESSION_COOKIE_SECRET: cookieSecret,
					HEAP_AUTO_SNAPSHOT: "0",
					HEAP_AUTO_SNAPSHOT_AT_WARN: "0",
				},
			},
		);
		// Drain without publishing log contents. Inputs and secrets are synthetic;
		// assertions concern process results, database conservation and /live only.
		let outputBytes = 0;
		const drain = (bytes: Buffer) => {
			outputBytes += bytes.length;
			if (outputBytes > 1024 * 1024) child.kill("SIGKILL");
		};
		child.stdout!.on("data", drain);
		child.stderr!.on("data", drain);
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			},
		);
		const actor = { child, closed };
		actors.push(actor);
		return actor;
	};
	const ready = async (child: ChildProcess) => {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error("Fixture API exited before readiness");
			try {
				const response = await fetch(`http://127.0.0.1:${port}/live`, {
					signal: AbortSignal.timeout(250),
					redirect: "error",
				});
				await response.body?.cancel();
				if (response.status === 200) return;
			} catch {}
			await delay(25);
		}
		throw new Error("Fixture API readiness deadline exceeded");
	};
	// Two real API boots each retain their own 15s readiness deadline. Allow
	// both phases plus authenticated reads and graceful shutdown under suite load.
	it("normalizes a valid future legacy session before real startup cleanup, retaining environment-first port selection", async () => {
		const actor = launch();
		await ready(actor.child);
		expect(read("SELECT id,userId,expiresAt FROM sessions")).toEqual([
			{
				id: sessionId,
				userId: "fixture-owner",
				expiresAt: "2100-01-01T00:00:00.123+00:00",
			},
		]);
		expect(read("SELECT formatVersion FROM ArrRuntimeDataFormatReceipt")).toEqual([
			{ formatVersion: 1 },
		]);
		const authenticated = await fetch(`http://127.0.0.1:${port}/auth/me`, {
			headers: { cookie: `arr_session=${encodeURIComponent(sign(sessionToken, cookieSecret))}` },
			signal: AbortSignal.timeout(2000),
			redirect: "error",
		});
		await authenticated.body?.cancel();
		expect(authenticated.status).toBe(200);
		const unsigned = await fetch(`http://127.0.0.1:${port}/auth/me`, {
			headers: { cookie: `arr_session=${sessionToken}` },
			signal: AbortSignal.timeout(2000),
			redirect: "error",
		});
		await unsigned.body?.cancel();
		expect(unsigned.status).toBe(401);
		actor.child.kill("SIGTERM");
		expect(await actor.closed).toEqual({ code: 0, signal: null });
		const format = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const binding = read("SELECT * FROM SqliteRestoreStorageBinding");
		const restarted = launch();
		await ready(restarted.child);
		expect(read("SELECT id FROM sessions")).toEqual([{ id: sessionId }]);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(format);
		expect(read("SELECT * FROM SqliteRestoreStorageBinding")).toEqual(binding);
	}, 45_000);
	it("refuses malformed dates before listener, journal mutation or session cleanup", async () => {
		change(`UPDATE sessions SET expiresAt='invalid-fixture-date' WHERE id='${sessionId}'`);
		const sessions = read("SELECT * FROM sessions ORDER BY id");
		const journal = read("SELECT * FROM RestoreRuntimeControl");
		const actor = launch();
		const timeout = setTimeout(() => actor.child.kill("SIGKILL"), 15000);
		try {
			expect(await actor.closed).toEqual({ code: 1, signal: null });
		} finally {
			clearTimeout(timeout);
		}
		expect(read("SELECT * FROM sessions ORDER BY id")).toEqual(sessions);
		expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual(journal);
		expect(existsSync(join(directory, "secrets.json"))).toBe(false);
	});
	it("refuses a contradicted format receipt without rewriting its journal or deleting sessions", async () => {
		await synchronizeSqliteRuntimeSchema(url);
		change(`UPDATE sessions SET expiresAt=4102444800123 WHERE id='${sessionId}'`);
		const sessions = read("SELECT * FROM sessions ORDER BY id");
		const journal = read("SELECT * FROM RestoreRuntimeControl");
		const format = read("SELECT * FROM ArrRuntimeDataFormatReceipt");
		const actor = launch();
		const timeout = setTimeout(() => actor.child.kill("SIGKILL"), 15000);
		try {
			expect(await actor.closed).toEqual({ code: 1, signal: null });
		} finally {
			clearTimeout(timeout);
		}
		expect(read("SELECT * FROM sessions ORDER BY id")).toEqual(sessions);
		expect(read("SELECT * FROM RestoreRuntimeControl")).toEqual(journal);
		expect(read("SELECT * FROM ArrRuntimeDataFormatReceipt")).toEqual(format);
	});
});
