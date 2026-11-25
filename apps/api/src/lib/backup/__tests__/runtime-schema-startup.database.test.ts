import { type ChildProcess, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	readdirSync as fsReaddir,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSqliteRestoreRuntimeOwnership } from "../restore-runtime-sqlite.js";
import {
	classifySqliteBindingObject,
	classifySqliteUnavailableStorageObject,
} from "../restore-runtime-sqlite-enrollment.js";
import * as postgres from "../runtime-schema-postgres.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../runtime-schema-registry.js";
import * as sqlite from "../runtime-schema-sqlite.js";
import * as startup from "../runtime-schema-startup.js";

const connectionString = process.env.RUNTIME_SCHEMA_TEST_DATABASE_URL;
const namespaceKey = 1095914052;
let sequence = 0;
const startupCliTimeoutMs = 10000;
// Leave time to join physical child closure and check the result after its watchdog.
const startupCliTestTimeoutMs = startupCliTimeoutMs + 5000;
const startupCliActors = new Map<ChildProcess, Promise<void>>();

async function closeStartupCliActors() {
	for (const [child, closed] of startupCliActors) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	}
}

async function runStartupCli(databaseUrl?: string, args: readonly string[] = []) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx/esm"),
			fileURLToPath(new URL("../../../schema-startup.ts", import.meta.url)),
			...args,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: "C.UTF-8",
				TZ: "UTC",
				...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
			},
		},
	);
	startupCliActors.set(
		child,
		new Promise<void>((resolve) => {
			child.once("close", () => {
				startupCliActors.delete(child);
				resolve();
			});
		}),
	);
	let stdout = "",
		stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
		if (stdout.length > 16384) child.kill("SIGKILL");
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
		if (stderr.length > 16384) child.kill("SIGKILL");
	});
	return await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		stdout: string;
		stderr: string;
	}>((done, reject) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), startupCliTimeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, signal, stdout, stderr });
		});
	});
}

const cliUnavailable = {
	code: 1,
	signal: null,
	stdout: "",
	stderr: "ERROR: Database schema startup is unavailable (startup-unavailable).\n",
};

function validateSqliteCliDiagnostics(
	result: Awaited<ReturnType<typeof runStartupCli>>,
	success: boolean,
	currentDateReceipt = false,
) {
	const error = success ? "" : cliUnavailable.stderr;
	if (!success) expect(result.stderr.endsWith(error)).toBe(true);
	const diagnostics = success ? result.stderr : result.stderr.slice(0, -error.length);
	expect(diagnostics.endsWith("\n")).toBe(true);
	const events = diagnostics
		.slice(0, -1)
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	// Reject extra fields/lines rather than hiding arbitrary stderr or private data.
	for (const event of events) {
		const failed = event.outcome === "failed";
		expect(Object.keys(event).sort()).toEqual(
			failed
				? ["category", "code", "elapsedMs", "errorCategory", "level", "outcome", "phase"]
				: ["category", "elapsedMs", "level", "outcome", "phase"],
		);
		if (failed) {
			expect(success).toBe(false);
			expect(event.phase).toBe("total");
			expect(event.errorCategory).toBe("schema");
			expect(event.code).toBeNull();
		}
		expect(event.category).toBe("sqlite-startup-phase");
		expect(event.level).toBe(30);
		expect(typeof event.elapsedMs).toBe("number");
		expect(Number.isFinite(event.elapsedMs)).toBe(true);
		expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
	}
	const datePlan = [
		["date-plan", "started"],
		["date-plan", "completed"],
	];
	expect(events.map((event) => [event.phase, event.outcome])).toEqual([
		["catalog-preflight", "completed"],
		["schema-plan", "started"],
		["schema-plan", "completed"],
		// Current receipts plan dates only after preparing FK tracking, while
		// fresh schemas still plan legacy normalization before applying DDL.
		...(!currentDateReceipt
			? [
					...datePlan,
					["catalog-preflight", "completed"],
					["schema-plan", "started"],
					["schema-plan", "completed"],
					...datePlan,
				]
			: []),
		["schema-apply", "completed"],
		["catalog-postflight", "completed"],
		...(currentDateReceipt ? datePlan : []),
		["date-apply", "completed"],
		...(success
			? [
					["foreign-key-check", "started"],
					["foreign-key-check", "completed"],
					["commit", "completed"],
				]
			: []),
		["total", success ? "completed" : "failed"],
	]);
	return { ...result, stderr: error };
}

describe("SQLite binding diagnostic classifications", () => {
	it.each([
		["device match", "42", "7", "42", "7", "match"],
		["device mismatch", "42", "7", "43", "7", "device-mismatch"],
		["inode mismatch", "42", "7", "42", "8", "inode-mismatch"],
		["both mismatch", "42", "7", "43", "8", "device-and-inode-mismatch"],
		["invalid stored identity", "invalid", "7", "42", "7", "invalid"],
		["unknown live identity", "42", "7", undefined, "7", "unknown"],
	])("%s", (_name, storedDevice, storedInode, currentDevice, currentInode, expected) => {
		expect(
			classifySqliteBindingObject(storedDevice, storedInode, currentDevice, currentInode),
		).toBe(expected);
	});
	it.each([
		["missing", "ENOENT", "missing"],
		["invalid path component", "ENOTDIR", "invalid"],
		["unclassified observation", "EIO", "unknown"],
		["missing code", undefined, "unknown"],
	])("%s", (_name, code, expected) => {
		expect(classifySqliteUnavailableStorageObject(code)).toBe(expected);
	});
});

describe.skipIf(process.platform !== "linux")("native SQLite schema startup writer", () => {
	let directory: string;
	let path: string;
	let url: string;
	const actors = new Map<
		ChildProcess,
		Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	>();
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-native-schema-"));
		chmodSync(directory, 0o700);
		path = join(directory, "fixture.sqlite");
		url = `file:${path}`;
	});
	afterEach(async () => {
		await closeStartupCliActors();
		for (const [actor, closed] of actors) {
			if (actor.exitCode === null && actor.signalCode === null) actor.kill("SIGKILL");
			await closed;
		}
		actors.clear();
		rmSync(directory, { recursive: true, force: true });
	});
	const database = <T>(read: (main: Database.Database) => T): T => {
		const main = new Database(path, { fileMustExist: true, timeout: 0 });
		try {
			return read(main);
		} finally {
			main.close();
		}
	};
	const synchronize = () => sqlite.synchronizeSqliteRuntimeSchema(url);
	const isApplicationDdl = (sql: string) =>
		sql.startsWith("CREATE TABLE ") &&
		!/^CREATE TABLE "(?:RestoreRuntimeControl|ArrSqliteEnrollmentIntent)"/.test(sql);
	const expectOnlyEnrollmentEvidence = (main: Database.Database) => {
		expect(
			main
				.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
				.all(),
		).toEqual([{ name: "ArrSqliteEnrollmentIntent" }, { name: "RestoreRuntimeControl" }]);
		expect(
			main.prepare("SELECT id,protocolVersion,phase FROM RestoreRuntimeControl").all(),
		).toEqual([{ id: 1, protocolVersion: 0, phase: "sqlite-enrollment-intent" }]);
		const row = main.prepare("SELECT payload FROM ArrSqliteEnrollmentIntent WHERE id=1").get() as {
			payload: string;
		};
		expect(JSON.parse(row.payload)).toMatchObject({ phase: "publishing" });
	};

	const rows = (
		table:
			| "RestoreRuntimeControl"
			| "SqliteRestoreStorageBinding"
			| "ArrSchemaMigrationReceipt"
			| "ArrSnapshotDateValidation"
			| "ArrSnapshotDateDirty",
	) => database((main) => main.prepare(`SELECT * FROM "${table}" ORDER BY id`).all());
	const objects = () =>
		database(
			(main) =>
				main.prepare("SELECT type,name,rootpage,sql FROM sqlite_schema ORDER BY name").all() as {
					type: string;
					name: string;
					rootpage: number;
					sql: string | null;
				}[],
		);
	const refuse = () =>
		expect(synchronize()).rejects.toMatchObject({ category: "startup-unavailable" });
	const fullUnenrolled = () => {
		const main = new Database(path);
		main.pragma("foreign_keys=ON");
		main.exec("BEGIN EXCLUSIVE");
		return prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
			provider: "sqlite",
			tables: [],
		})
			.execute((sql) => {
				main.exec(sql);
			})
			.then(() => {
				main.exec('DROP TABLE "ArrSchemaMigrationReceipt"; COMMIT');
			})
			.finally(() => main.close());
	};
	const actorAt = async (
		action:
			| "after-first-ddl"
			| "before-commit"
			| "after-commit"
			| "hold-shared"
			| "hold-partial-owner",
	) => {
		const actor = fork(
			fileURLToPath(new URL("./fixtures/runtime-schema-actor.ts", import.meta.url)),
			[],
			{
				execArgv: ["--import", import.meta.resolve("tsx/esm")],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" },
			},
		);
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(done, reject) => {
				actor.once("error", reject);
				actor.once("close", (code, signal) => done({ code, signal }));
			},
		);
		actors.set(actor, closed);
		const checkpoint = new Promise<void>((done, reject) => {
			let pending = "";
			const timer = setTimeout(
				() => reject(new Error("Native fixture checkpoint deadline exceeded")),
				6000,
			);
			actor.stdout!.on("data", (bytes) => {
				pending += String(bytes);
				if (pending === '{"category":"native-checkpoint"}\n') {
					clearTimeout(timer);
					done();
				} else if (pending.length > 128) {
					clearTimeout(timer);
					reject(new Error("Unexpected native fixture output"));
				}
			});
			actor.once("close", () => {
				clearTimeout(timer);
				reject(new Error("Native fixture closed before checkpoint"));
			});
		});
		actor.send({ databaseUrl: url, action });
		await checkpoint;
		return { actor, closed };
	};
	it(
		"joins an interrupted CLI child before fixture teardown can remove its database",
		async () => {
			const result = runStartupCli(url);
			expect(startupCliActors.size).toBe(1);
			await closeStartupCliActors();
			expect(await result).toMatchObject({ code: null, signal: "SIGKILL" });
			expect(startupCliActors.size).toBe(0);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"actual CLI commits fresh SQLite before reporting the exact missing-settings projection and closing locks",
		async () => {
			expect(validateSqliteCliDiagnostics(await runStartupCli(url), true)).toEqual({
				code: 0,
				signal: null,
				stdout: '{"apiPort":null,"webPort":null,"listenAddress":null}\n',
				stderr: "",
			});
			expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(1);
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		},
		startupCliTestTimeoutMs,
	);
	it(
		"actual CLI returns configured SQLite settings, not invented first-run defaults",
		async () => {
			await synchronize();
			database((db) =>
				db.exec(`INSERT INTO system_settings(id,apiPort,webPort,listenAddress,createdAt,updatedAt)
				VALUES(1,43101,43102,'127.0.0.1','2026-10-08T00:00:00.000+00:00','2026-10-08T00:00:00.000+00:00')`),
			);
			expect(validateSqliteCliDiagnostics(await runStartupCli(url), true, true)).toEqual({
				code: 0,
				signal: null,
				stdout: '{"apiPort":43101,"webPort":43102,"listenAddress":"127.0.0.1"}\n',
				stderr: "",
			});
		},
		startupCliTestTimeoutMs,
	);
	it(
		"actual CLI fails privately rather than defaulting or committing a failed SQLite settings read",
		async () => {
			await synchronize();
			database((db) =>
				db.exec(`INSERT INTO system_settings(id,apiPort,createdAt,updatedAt)
				VALUES(1,0,'2026-10-08T00:00:00.000+00:00','2026-10-08T00:00:00.000+00:00')`),
			);
			const before = rows("RestoreRuntimeControl"),
				receipt = rows("ArrSchemaMigrationReceipt");
			expect(validateSqliteCliDiagnostics(await runStartupCli(url), false, true)).toEqual(
				cliUnavailable,
			);
			expect(rows("RestoreRuntimeControl")).toEqual(before);
			expect(rows("ArrSchemaMigrationReceipt")).toEqual(receipt);
		},
		startupCliTestTimeoutMs,
	);
	it.each([
		["unanchored coordination", "cold-enrollment-check", "schema"],
		["copied enrolled file", "storage-binding-validation", "storage-identity"],
	])(
		"distinguishes the #934 pre-apply signature for %s and conserves data",
		async (scenario, phase, errorCategory) => {
			if (scenario === "unanchored coordination") {
				new Database(path).close();
				mkdirSync(path + ".arr-restore-runtime", { mode: 0o700 });
			} else {
				await synchronize();
				const original = path + ".original";
				renameSync(path, original);
				copyFileSync(original, path);
			}
			const before = readFileSync(path);
			const result = await runStartupCli(url);
			expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
			expect(result.stderr.endsWith(cliUnavailable.stderr)).toBe(true);
			expect(result.stderr).not.toContain(directory);
			const logText = result.stderr.slice(0, -cliUnavailable.stderr.length);
			expect(logText.endsWith("\n")).toBe(true);
			const diagnostics = logText
				.slice(0, -1)
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ phase: "catalog-preflight", outcome: "completed" }),
					expect.objectContaining({ phase: "schema-plan", outcome: "completed" }),
				]),
			);
			if (scenario === "unanchored coordination") {
				expect(diagnostics).toContainEqual(
					expect.objectContaining({ phase: "date-plan", outcome: "completed" }),
				);
			}
			expect(diagnostics.some((event) => event.phase === "schema-apply")).toBe(false);
			expect(diagnostics.at(-2)).toEqual({
				level: 30,
				category: "sqlite-startup-phase",
				elapsedMs: expect.any(Number),
				phase,
				outcome: "failed",
				errorCategory,
				...(scenario === "unanchored coordination"
					? { refusal: "coordination-path" }
					: {
							storageBinding: {
								header: "valid",
								objects: [
									{ object: "database", classification: "inode-mismatch" },
									{ object: "directory", classification: "match" },
									{ object: "coordination", classification: "match" },
									{ object: "owner", classification: "match" },
									{ object: "operations", classification: "match" },
								],
							},
						}),
				code: null,
			});
			expect(diagnostics.at(-1)).toMatchObject({ phase: "total", outcome: "failed" });
			expect(readFileSync(path)).toEqual(before);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"classifies all five stored device mismatches while preserving inode values and refusing startup",
		async () => {
			await synchronize();
			database((db) =>
				db.exec(`UPDATE SqliteRestoreStorageBinding SET
				databaseDevice=CASE WHEN databaseDevice='0' THEN '1' ELSE '0' END,
				directoryDevice=CASE WHEN directoryDevice='0' THEN '1' ELSE '0' END,
				coordinationDevice=CASE WHEN coordinationDevice='0' THEN '1' ELSE '0' END,
				ownerDevice=CASE WHEN ownerDevice='0' THEN '1' ELSE '0' END,
				operationsDevice=CASE WHEN operationsDevice='0' THEN '1' ELSE '0' END`),
			);
			const before = readFileSync(path);
			const result = await runStartupCli(url);
			expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
			expect(result.stderr.endsWith(cliUnavailable.stderr)).toBe(true);
			const logText = result.stderr.slice(0, -cliUnavailable.stderr.length);
			expect(logText).not.toContain(path);
			const events = logText
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.at(-2)).toEqual({
				level: 30,
				category: "sqlite-startup-phase",
				elapsedMs: expect.any(Number),
				phase: "storage-binding-validation",
				outcome: "failed",
				errorCategory: "storage-identity",
				code: null,
				storageBinding: {
					header: "valid",
					objects: [
						{ object: "database", classification: "device-mismatch" },
						{ object: "directory", classification: "device-mismatch" },
						{ object: "coordination", classification: "device-mismatch" },
						{ object: "owner", classification: "device-mismatch" },
						{ object: "operations", classification: "device-mismatch" },
					],
				},
			});
			expect(events.some((event) => event.phase === "schema-apply")).toBe(false);
			expect(readFileSync(path)).toEqual(before);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"classifies a missing coordination object and leaves later objects unknown",
		async () => {
			await synchronize();
			const retired = join(directory, "retired-coordination");
			renameSync(`${path}.arr-restore-runtime`, retired);
			const before = readFileSync(path);
			const result = await runStartupCli(url);
			expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
			const logText = result.stderr.slice(0, -cliUnavailable.stderr.length);
			expect(logText).not.toContain(directory);
			const events = logText
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.at(-2)).toMatchObject({
				phase: "storage-binding-validation",
				outcome: "failed",
				errorCategory: "filesystem",
				code: "ENOENT",
				storageBinding: {
					header: "valid",
					objects: [
						{ object: "database", classification: "match" },
						{ object: "directory", classification: "match" },
						{ object: "coordination", classification: "missing" },
						{ object: "owner", classification: "unknown" },
						{ object: "operations", classification: "unknown" },
					],
				},
			});
			expect(events.some((event) => event.phase === "schema-apply")).toBe(false);
			expect(readFileSync(path)).toEqual(before);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"marks malformed binding identity and header fields invalid without exposing values",
		async () => {
			await synchronize();
			database((db) =>
				db.exec(
					"UPDATE SqliteRestoreStorageBinding SET protocolVersion=2, databaseInode='private-binding-value'",
				),
			);
			const before = readFileSync(path);
			const result = await runStartupCli(url);
			expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
			const logText = result.stderr.slice(0, -cliUnavailable.stderr.length);
			expect(logText).not.toContain("private-binding-value");
			expect(logText).not.toContain(directory);
			const events = logText
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.at(-2)).toMatchObject({
				phase: "storage-binding-validation",
				errorCategory: "storage-identity",
				code: null,
				storageBinding: {
					header: "invalid",
					objects: [
						{ object: "database", classification: "invalid" },
						{ object: "directory", classification: "match" },
						{ object: "coordination", classification: "match" },
						{ object: "owner", classification: "match" },
						{ object: "operations", classification: "match" },
					],
				},
			});
			expect(readFileSync(path)).toEqual(before);
		},
		startupCliTestTimeoutMs,
	);
	it.each([undefined, "unsupported://synthetic.invalid/no-database"])(
		"actual CLI rejects missing or unsupported database configuration without a schema file or defaults",
		async (databaseUrl) => {
			expect(await runStartupCli(databaseUrl)).toEqual(cliUnavailable);
			expect(existsSync(path)).toBe(false);
		},
		startupCliTestTimeoutMs,
	);
	it.each(["--accept-data-loss", "--force-reset", "--ownership"])(
		"actual CLI rejects the unsupported %s flag before opening a destination",
		async (flag) => {
			expect(await runStartupCli(url, [flag])).toEqual(cliUnavailable);
			expect(existsSync(path)).toBe(false);
		},
		startupCliTestTimeoutMs,
	);
	it("creates a fresh private file and commits schema, original binding, journal and receipt together", async () => {
		expect(existsSync(path)).toBe(false);
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		// 103 registered tables, two date-checkpoint tables and ArrForeignKeyValidation.
		expect(
			database(
				(main) =>
					(
						main
							.prepare(
								"SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
							)
							.get() as { n: number }
					).n,
			),
		).toBe(106);
		expect(rows("ArrSnapshotDateValidation")).toEqual([
			expect.objectContaining({
				id: 1,
				protocolVersion: 1,
				generation: 0,
				dirtyCount: 0,
				fullScanRequired: 0,
			}),
		]);
		expect(rows("ArrSnapshotDateDirty")).toEqual([]);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		const coordination = `${path}.arr-restore-runtime`;
		expect(lstatSync(coordination).mode & 0o777).toBe(0o700);
		for (const file of ["owner.sqlite3", "operations.sqlite3"])
			expect(lstatSync(join(coordination, file)).mode & 0o777).toBe(0o600);
		expect(rows("RestoreRuntimeControl")).toEqual([
			expect.objectContaining({
				id: 1,
				protocolVersion: 1,
				phase: "starting",
				ownerBackendPid: null,
				activeRestoreId: null,
				lastCommittedRestoreId: null,
				destinationInstallationId: null,
			}),
		]);
		expect(rows("SqliteRestoreStorageBinding")).toEqual([
			expect.objectContaining({
				id: 1,
				protocolVersion: 1,
				databaseDevice: String(lstatSync(path, { bigint: true }).dev),
				databaseInode: String(lstatSync(path, { bigint: true }).ino),
			}),
		]);
		expect(rows("ArrSchemaMigrationReceipt")).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/^[0-9a-f-]{36}$/),
				protocolVersion: 1,
				registryVersion: 1,
				provider: "sqlite",
				targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		]);
		const ownership = await acquireSqliteRestoreRuntimeOwnership(url);
		try {
			expect(await ownership.tryAcquireExclusive()).toBe(true);
		} finally {
			await ownership.close();
		}
		database((main) => {
			main.exec("BEGIN EXCLUSIVE; ROLLBACK");
		});
	});
	it.each([0, 1, 2, 3])(
		"resumes cold enrollment after acknowledged checkpoint with %i objects",
		async (objectsRecorded) => {
			const original = Database.prototype.exec;
			let interrupted = false;
			const hook = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				if (this.name === path && sql === "BEGIN EXCLUSIVE" && interrupted)
					throw new Error("interrupted after the cold intent checkpoint");
				const result = original.call(this, sql);
				if (
					this.name === path &&
					sql === "COMMIT" &&
					this.prepare("SELECT 1 FROM sqlite_schema WHERE name='ArrSqliteEnrollmentIntent'").get()
				) {
					const row = this.prepare("SELECT payload FROM ArrSqliteEnrollmentIntent").get() as {
						payload: string;
					};
					const intent = JSON.parse(row.payload);
					interrupted = intent.phase === "preparing" && intent.objects.length === objectsRecorded;
				}
				return result;
			});
			try {
				await expect(synchronize()).rejects.toThrow();
			} finally {
				hook.mockRestore();
			}
			expect(interrupted).toBe(true);
			expect(existsSync(`${path}.arr-restore-runtime`)).toBe(objectsRecorded !== 0);
			const { enrollSqliteRestoreRuntimeStorage } = await import(
				"../restore-runtime-sqlite-enrollment.js"
			);
			await expect(enrollSqliteRestoreRuntimeStorage(url)).rejects.toMatchObject({
				statusCode: 503,
			});
			if (objectsRecorded === 2) {
				const contender = await actorAt("hold-partial-owner");
				try {
					await refuse();
					expect(existsSync(join(`${path}.arr-restore-runtime`, "operations.sqlite3"))).toBe(false);
				} finally {
					contender.actor.send({ category: "close" });
					expect(await contender.closed).toEqual({ code: 0, signal: null });
				}
			}
			await expect(synchronize()).resolves.toMatchObject({ apiPort: null });
			expect(rows("SqliteRestoreStorageBinding")).toHaveLength(1);
			expect(rows("RestoreRuntimeControl")[0]).toMatchObject({
				protocolVersion: 1,
				phase: "starting",
			});
			expect(objects().some((object) => object.name === "ArrSqliteEnrollmentIntent")).toBe(false);
		},
	);

	it.each([0, 1, 2])(
		"preserves an object created before its durable checkpoint with %i prior objects",
		async (objectsRecorded) => {
			const original = Database.prototype.prepare;
			let interrupted = false;
			const hook = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql: string,
			) {
				if (this.name === path && sql.startsWith("UPDATE main.ArrSqliteEnrollmentIntent")) {
					const statement = original.call(
						this,
						"SELECT payload FROM ArrSqliteEnrollmentIntent",
					) as Database.Statement<[]>;
					const row = statement.get() as { payload: string };
					if (JSON.parse(row.payload).objects.length === objectsRecorded) {
						interrupted = true;
						throw new Error("interrupted before checkpoint publication");
					}
				}
				return original.call(this, sql);
			});
			try {
				await refuse();
			} finally {
				hook.mockRestore();
			}
			expect(interrupted).toBe(true);
			const namespace = `${path}.arr-restore-runtime`;
			const created = fsReaddir(namespace);
			expect(created).toHaveLength(objectsRecorded);
			const committedIntent = database((main) =>
				main.prepare("SELECT payload FROM ArrSqliteEnrollmentIntent").get(),
			);
			await refuse();
			expect(fsReaddir(namespace)).toEqual(created);
			expect(
				database((main) => main.prepare("SELECT payload FROM ArrSqliteEnrollmentIntent").get()),
			).toEqual(committedIntent);
		},
	);
	it("dispatches file startup through the actual SQLite writer without extra result fields", async () => {
		expect(await startup.synchronizeRuntimeSchema(url)).toEqual({
			apiPort: null,
			webPort: null,
			listenAddress: null,
		});
		expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(1);
	});
	it("adopts compatible empty first-enrollment tables without inventing a prior completion", async () => {
		await fullUnenrolled();
		expect(rows("RestoreRuntimeControl")).toEqual([]);
		expect(rows("SqliteRestoreStorageBinding")).toEqual([]);
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		expect(rows("RestoreRuntimeControl")).toHaveLength(1);
		expect(rows("SqliteRestoreStorageBinding")).toHaveLength(1);
		expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(1);
	});
	it("uses bounded presence in both canonical restart catalog phases while preserving schema and rows", async () => {
		await synchronize();
		database((db) =>
			db.exec(
				"CREATE TABLE SyntheticExtra(id INTEGER PRIMARY KEY); INSERT INTO SyntheticExtra VALUES(1),(2),(3)",
			),
		);
		const savedObjects = objects();
		const original = Database.prototype.prepare;
		const queries: string[] = [];
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql: string,
		) {
			if (this.name === path) queries.push(sql);
			return original.call(this, sql);
		});
		try {
			expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		} finally {
			vi.restoreAllMocks();
		}
		expect(
			queries.filter((sql) => sql === 'SELECT 1 AS present FROM main."SyntheticExtra" LIMIT 1'),
		).toHaveLength(2);
		expect(queries.filter((sql) => /^SELECT COUNT\(\*\) AS count FROM main\./.test(sql))).toEqual([
			'SELECT COUNT(*) AS count FROM main."oidc_providers"',
			'SELECT COUNT(*) AS count FROM main."oidc_providers"',
		]);
		expect(objects()).toEqual(savedObjects);
		expect(database((db) => db.prepare("SELECT * FROM SyntheticExtra ORDER BY id").all())).toEqual([
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
		]);
		expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(2);
	});
	it("upgrades the populated exact legacy OIDC allocator and preserves saved settings on restart", async () => {
		await fullUnenrolled();
		database((db) => {
			db.exec(`DROP TABLE oidc_providers;
			CREATE TABLE oidc_providers (
			 id INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
			 displayName TEXT NOT NULL, clientId TEXT NOT NULL,
			 encryptedClientSecret TEXT NOT NULL, clientSecretIv TEXT NOT NULL,
			 issuer TEXT NOT NULL, redirectUri TEXT NOT NULL,
			 scopes TEXT NOT NULL DEFAULT 'openid,email,profile',
			 enabled BOOLEAN NOT NULL DEFAULT true,
			 createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			 updatedAt DATETIME NOT NULL);
			INSERT INTO oidc_providers VALUES(41,'synthetic-provider','synthetic-client',
			 'opaque-ciphertext','opaque-iv','https://synthetic.invalid',
			 'https://synthetic.invalid/callback','openid,email,profile',1,
			 '2026-10-08T12:00:00.000+00:00','2026-10-08T12:00:00.000+00:00');
			INSERT INTO oidc_providers SELECT 42,'synthetic-second',clientId||'2',encryptedClientSecret||'2',clientSecretIv,issuer,redirectUri,scopes,0,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			INSERT INTO oidc_providers SELECT 43,'synthetic-third',clientId||'3',encryptedClientSecret||'3',clientSecretIv,issuer,redirectUri,scopes,1,createdAt,updatedAt FROM oidc_providers WHERE id=41;
			INSERT INTO system_settings(id,apiPort,webPort,listenAddress,createdAt,updatedAt)
			 VALUES(1,4321,5432,'127.0.0.1','2026-10-08T12:00:00.000+00:00',
			 '2026-10-08T12:00:00.000+00:00');`);
		});
		const saved = database((db) => db.prepare("SELECT * FROM oidc_providers").all());
		expect(saved).toHaveLength(3);
		expect(await synchronize()).toEqual({
			apiPort: 4321,
			webPort: 5432,
			listenAddress: "127.0.0.1",
		});
		expect(database((db) => db.prepare("SELECT * FROM oidc_providers").all())).toEqual(saved);
		expect(objects().find((object) => object.name === "oidc_providers")!.sql).toContain(
			"AUTOINCREMENT",
		);
		const binding = rows("SqliteRestoreStorageBinding");
		expect(await synchronize()).toEqual({
			apiPort: 4321,
			webPort: 5432,
			listenAddress: "127.0.0.1",
		});
		expect(database((db) => db.prepare("SELECT * FROM oidc_providers").all())).toEqual(saved);
		expect(rows("SqliteRestoreStorageBinding")).toEqual(binding);
		expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(2);
		expect(
			new Set(
				rows("ArrSchemaMigrationReceipt").map((row) => (row as { planDigest: string }).planDigest),
			).size,
		).toBe(2);
	});
	it.each(["DELETE", "WAL"] as const)(
		"preserves %s mode, original binding, row pages, credentials, sessions and custom objects",
		async (mode) => {
			const main = new Database(path);
			main.pragma(`journal_mode=${mode}`);
			main.close();
			await synchronize();
			const marker = randomUUID();
			database((db) => {
				db.exec(`ALTER TABLE "User" DROP COLUMN "failedLoginAttempts";
			ALTER TABLE "User" ADD COLUMN fixtureExtra TEXT;
			CREATE INDEX fixture_extra ON "User"(fixtureExtra);
			CREATE TABLE fixtureAudit(id TEXT NOT NULL PRIMARY KEY);
			CREATE TRIGGER fixture_audit AFTER UPDATE ON "User" BEGIN INSERT INTO fixtureAudit VALUES('synthetic-audit'); END;
			CREATE VIEW fixture_view AS SELECT id,fixtureExtra FROM "User";
			INSERT INTO "User"(id,username,hashedPassword,encryptedTmdbApiKey,tmdbEncryptionIv,fixtureExtra,createdAt,updatedAt)
			VALUES('synthetic-user','synthetic-user','opaque-hash','opaque-cipher','opaque-iv','opaque-extra','2026-10-08T12:00:00.000+00:00','2026-10-08T12:00:00.000+00:00');
			INSERT INTO sessions(id,userId,expiresAt,createdAt,lastAccessedAt) VALUES('synthetic-session','synthetic-user','2027-01-01T00:00:00.000+00:00','2026-10-08T12:00:00.000+00:00','2026-10-08T12:00:00.000+00:00');
			INSERT INTO system_settings(id,apiPort,webPort,listenAddress,createdAt,updatedAt) VALUES(1,4321,5432,'127.0.0.1','2026-10-08T12:00:00.000+00:00','2026-10-08T12:00:00.000+00:00');`);
				db.prepare(
					`UPDATE RestoreRuntimeControl SET phase='restart-required',activeRestoreId=?,lastCommittedRestoreId=?,lastCommittedAt=?,destinationInstallationId='synthetic-original'`,
				).run(marker, marker, "2026-10-08T12:34:56.789+00:00");
			});
			const binding = rows("SqliteRestoreStorageBinding");
			const beforePages = objects()
				.filter((object) => object.type === "table")
				.map((object) => [object.name, object.rootpage]);
			const values = database((db) =>
				db
					.prepare(
						'SELECT id,username,hashedPassword,encryptedTmdbApiKey,tmdbEncryptionIv,fixtureExtra FROM "User"',
					)
					.all(),
			);
			expect(await synchronize()).toEqual({
				apiPort: 4321,
				webPort: 5432,
				listenAddress: "127.0.0.1",
			});
			expect(database((db) => db.pragma("journal_mode", { simple: true }))).toBe(
				mode.toLowerCase(),
			);
			expect(rows("SqliteRestoreStorageBinding")).toEqual(binding);
			expect(
				objects()
					.filter((object) => object.type === "table")
					.map((object) => [object.name, object.rootpage]),
			).toEqual(beforePages);
			expect(
				database((db) =>
					db
						.prepare(
							'SELECT id,username,hashedPassword,encryptedTmdbApiKey,tmdbEncryptionIv,fixtureExtra FROM "User"',
						)
						.all(),
				),
			).toEqual(values);
			expect(database((db) => db.prepare('SELECT failedLoginAttempts FROM "User"').all())).toEqual([
				{ failedLoginAttempts: 0 },
			]);
			expect(database((db) => db.prepare("SELECT id,userId FROM sessions").all())).toEqual([
				{ id: "synthetic-session", userId: "synthetic-user" },
			]);
			expect(database((db) => db.prepare("SELECT * FROM fixture_view").all())).toEqual([
				{ id: "synthetic-user", fixtureExtra: "opaque-extra" },
			]);
			expect(rows("RestoreRuntimeControl")).toEqual([
				expect.objectContaining({
					phase: "starting",
					activeRestoreId: null,
					lastCommittedRestoreId: marker,
					lastCommittedAt: "2026-10-08T12:34:56.789+00:00",
					destinationInstallationId: "synthetic-original",
				}),
			]);
			expect(database((db) => db.pragma("foreign_key_check"))).toEqual([]);
			database((db) => db.exec(`UPDATE "User" SET fixtureExtra='changed'`));
			expect(database((db) => db.prepare("SELECT * FROM fixtureAudit").all())).toEqual([
				{ id: "synthetic-audit" },
			]);
		},
	);
	it("refuses an orphan before creating a missing main file", async () => {
		mkdirSync(`${path}.arr-restore-runtime`, { mode: 0o700 });
		await refuse();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`${path}.arr-restore-runtime`)).toBe(true);
	});
	it("refuses incompatible schema before creating a coordination namespace or unrelated tables", async () => {
		const main = new Database(path);
		main.exec('CREATE TABLE "User"(id INTEGER NOT NULL PRIMARY KEY)');
		main.close();
		const before = objects();
		await refuse();
		expect(objects()).toEqual(before);
		expect(existsSync(`${path}.arr-restore-runtime`)).toBe(false);
	});
	it("rolls back a new receipt table and schema DDL after a real native unique-index failure", async () => {
		await synchronize();
		database((db) =>
			db.exec(`DROP TABLE ArrSchemaMigrationReceipt; DROP INDEX User_username_key;
			INSERT INTO "User"(id,username,createdAt,updatedAt)
			VALUES('first','duplicate','2026-10-08T00:00:00.000+00:00','2026-10-08T00:00:00.000+00:00'),
			('second','duplicate','2026-10-08T00:00:00.000+00:00','2026-10-08T00:00:00.000+00:00')`),
		);
		const before = objects();
		const journal = rows("RestoreRuntimeControl");
		await refuse();
		expect(objects()).toEqual(before);
		expect(rows("RestoreRuntimeControl")).toEqual(journal);
		expect(database((db) => db.prepare('SELECT id FROM "User" ORDER BY id').all())).toEqual([
			{ id: "first" },
			{ id: "second" },
		]);
	});
	it("rolls back an invalid settings read without rotating epoch or fabricating a receipt", async () => {
		await synchronize();
		database((db) =>
			db.exec(`INSERT INTO system_settings(id,apiPort,createdAt,updatedAt)
				VALUES(1,0,'2026-10-08T00:00:00.000+00:00','2026-10-08T00:00:00.000+00:00')`),
		);
		const journal = rows("RestoreRuntimeControl"),
			receipt = rows("ArrSchemaMigrationReceipt");
		await refuse();
		expect(rows("RestoreRuntimeControl")).toEqual(journal);
		expect(rows("ArrSchemaMigrationReceipt")).toEqual(receipt);
	});
	it("refuses a replaced stored inode binding without updating recovery evidence", async () => {
		await synchronize();
		database((db) => db.exec(`UPDATE SqliteRestoreStorageBinding SET databaseInode='0'`));
		const journal = rows("RestoreRuntimeControl"),
			receipt = rows("ArrSchemaMigrationReceipt");
		await refuse();
		expect(rows("RestoreRuntimeControl")).toEqual(journal);
		expect(rows("ArrSchemaMigrationReceipt")).toEqual(receipt);
	});
	it("detects actual main-file replacement after native DDL and does not publish into either inode", async () => {
		const retired = join(directory, "retired.sqlite");
		const originalExec = Database.prototype.exec;
		let replaced = false;
		const intercepted = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database.Database,
			sql: string,
		) {
			const result = originalExec.call(this, sql);
			if (this.name === path && !replaced && isApplicationDdl(sql)) {
				replaced = true;
				renameSync(path, retired);
				const replacement = new Database(path);
				replacement.close();
			}
			return result;
		});
		try {
			await refuse();
		} finally {
			intercepted.mockRestore();
		}
		expect(replaced).toBe(true);
		expect(lstatSync(path).ino).not.toBe(lstatSync(retired).ino);
		expect(objects()).toEqual([]);
		const original = new Database(retired, { fileMustExist: true, timeout: 0 });
		try {
			expectOnlyEnrollmentEvidence(original);
			original.exec("BEGIN EXCLUSIVE; ROLLBACK");
		} finally {
			original.close();
		}
		await refuse();
		expect(existsSync(`${path}.arr-restore-runtime`)).toBe(true);
		expect(objects()).toEqual([]);
	});
	it("refuses another actual main descriptor opened after DDL before committing an anchor or receipt", async () => {
		const originalExec = Database.prototype.exec;
		let extra: Database.Database | undefined;
		const intercepted = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database.Database,
			sql: string,
		) {
			const result = originalExec.call(this, sql);
			if (this.name === path && !extra && isApplicationDdl(sql))
				extra = new Database(path, { fileMustExist: true, timeout: 0 });
			return result;
		});
		try {
			await refuse();
		} finally {
			intercepted.mockRestore();
			extra?.close();
		}
		expect(extra?.open).toBe(false);
		database(expectOnlyEnrollmentEvidence);
		await refuse();
		database(expectOnlyEnrollmentEvidence);
	});
	describe("COMMIT acknowledgement on an enrolled database", () => {
		// Fresh enrollment is fixture setup. The fault and reopen are still timed together.
		beforeEach(async () => {
			await synchronize();
		}, 5_000);

		it.each(["before-native-commit", "after-native-commit"] as const)(
			"keeps %s acknowledgement uncertainty explicit, closes locks and never retries COMMIT",
			async (stage) => {
				const before = rows("RestoreRuntimeControl"),
					receipts = rows("ArrSchemaMigrationReceipt"),
					binding = rows("SqliteRestoreStorageBinding");
				const originalExec = Database.prototype.exec;
				let commits = 0;
				const intercepted = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
					this: Database.Database,
					sql: string,
				) {
					if (this.name === path && sql === "COMMIT") {
						commits++;
						if (stage === "after-native-commit") originalExec.call(this, sql);
						throw new Error("Synthetic native-call acknowledgement interruption");
					}
					return originalExec.call(this, sql);
				});
				try {
					await expect(synchronize()).rejects.toMatchObject({ category: "commit-unknown" });
				} finally {
					intercepted.mockRestore();
				}
				expect(commits).toBe(1);
				expect(rows("SqliteRestoreStorageBinding")).toEqual(binding);
				const after = rows("ArrSchemaMigrationReceipt");
				expect(after).toHaveLength(receipts.length + (stage === "after-native-commit" ? 1 : 0));
				expect(after).toContainEqual(receipts[0]);
				if (stage === "before-native-commit") expect(rows("RestoreRuntimeControl")).toEqual(before);
				else expect(rows("RestoreRuntimeControl")).not.toEqual(before);
				const owner = await acquireSqliteRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
				} finally {
					await owner.close();
				}
				await synchronize();
				expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(after.length + 1);
				expect(rows("SqliteRestoreStorageBinding")).toEqual(binding);
			},
			5_000,
		);
	});
	it("blocks a real child-held shared operation without committing schema or epoch", async () => {
		await synchronize();
		const before = rows("RestoreRuntimeControl"),
			receipt = rows("ArrSchemaMigrationReceipt");
		const { actor, closed } = await actorAt("hold-shared");
		await refuse();
		expect(rows("RestoreRuntimeControl")).toEqual(before);
		expect(rows("ArrSchemaMigrationReceipt")).toEqual(receipt);
		actor.send({ category: "close" });
		expect(await closed).toEqual({ code: 0, signal: null });
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
	});
	it.each([
		["after-first-ddl", "SIGTERM"],
		["after-first-ddl", "SIGKILL"],
		["before-commit", "SIGTERM"],
		["before-commit", "SIGKILL"],
	] as const)(
		"keeps actual cold actor exclusion at %s and rolls back after %s without orphan repair",
		async (stage, signal) => {
			const { actor, closed } = await actorAt(stage);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toMatchObject({
				name: "SqliteRestoreRuntimeOwnershipError",
			});
			await refuse();
			expect(actor.kill(signal)).toBe(true);
			expect(await closed).toMatchObject({ signal });
			database(expectOnlyEnrollmentEvidence);
			const coordination = `${path}.arr-restore-runtime`;
			expect(existsSync(coordination)).toBe(true);
			await refuse();
			database(expectOnlyEnrollmentEvidence);
			expect(existsSync(coordination)).toBe(true);
		},
	);
	it.each(["SIGTERM", "SIGKILL"] as const)(
		"preserves the actual positive commit after %s without admitting a live-actor contender",
		async (signal) => {
			const { actor, closed } = await actorAt("after-commit");
			const before = rows("ArrSchemaMigrationReceipt");
			expect(before).toHaveLength(1);
			const binding = rows("SqliteRestoreStorageBinding");
			await refuse();
			expect(actor.kill(signal)).toBe(true);
			expect(await closed).toMatchObject({ signal });
			expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
			expect(rows("SqliteRestoreStorageBinding")).toEqual(binding);
			expect(rows("ArrSchemaMigrationReceipt")).toHaveLength(2);
			expect(rows("ArrSchemaMigrationReceipt")).toContainEqual(before[0]);
		},
	);
});

describe.skipIf(!connectionString)("native PostgreSQL schema startup writer", () => {
	let database: Client;
	let schema: string;
	let url: string;
	const connections = new Set<Client>();
	const actors = new Map<ChildProcess, Promise<unknown>>();
	const transports = new Set<() => Promise<void>>();
	const roles = new Set<string>();
	beforeEach(async () => {
		database = new Client({ connectionString, connectionTimeoutMillis: 5000 });
		database.on("error", () => {});
		await database.connect();
		schema = `startup_fixture_${process.pid}_${++sequence}`;
		await database.query(`CREATE SCHEMA "${schema}"`);
		await database.query(`SET search_path TO "${schema}"`);
		const parsed = new URL(connectionString!);
		parsed.searchParams.set("schema", schema);
		url = parsed.toString();
	});
	afterEach(async () => {
		try {
			await closeStartupCliActors();
			for (const [actor, closed] of actors) {
				if (actor.exitCode === null && actor.signalCode === null) actor.kill("SIGKILL");
				await closed;
			}
			actors.clear();
			for (const close of transports) await close();
			transports.clear();
			for (const connection of connections) {
				try {
					await connection.query("ROLLBACK");
				} finally {
					await connection.end();
				}
			}
			connections.clear();
			await database.query(`DROP SCHEMA "${schema}" CASCADE`);
			for (const role of roles) await database.query(`DROP ROLE "${role}"`);
			roles.clear();
		} finally {
			await database.end();
		}
	});
	const synchronize = () => postgres.synchronizePostgresRuntimeSchema(url);
	const connection = async () => {
		const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
		client.on("error", () => {});
		await client.connect();
		connections.add(client);
		await client.query(`SET search_path TO "${schema}"`);
		return client;
	};
	const countTables = async () =>
		Number(
			(await database.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname=$1", [schema]))
				.rows[0].n,
		);
	const journal = async () => (await database.query('SELECT * FROM "RestoreRuntimeControl"')).rows;
	const receipts = async () =>
		(
			await database.query(
				`SELECT id,"protocolVersion","registryVersion",provider,"targetDigest","planDigest",
				to_char("completedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt"
				FROM "ArrSchemaMigrationReceipt" ORDER BY "completedAt",id`,
			)
		).rows;
	const fullTarget = async () => {
		const registry = loadRuntimeSchemaRegistry("postgresql");
		await database.query("BEGIN");
		await prepareRuntimeSchemaExecution(registry, { provider: "postgresql", tables: [] }, [
			"ServiceType",
			"ProviderIdentityKind",
			"ProviderIdentityStatus",
			"LibraryItemType",
			"BackupIntervalType",
		]).execute(async (sql) => {
			await database.query(sql);
		});
		await database.query(`INSERT INTO "RestoreRuntimeControl"(id,"protocolVersion",phase)
			VALUES(1,1,'idle')`);
		await database.query("COMMIT");
	};
	const refuse = async () => {
		await expect(synchronize()).rejects.toMatchObject({ category: "startup-unavailable" });
	};
	const waitFor = async <T>(read: () => Promise<T | null>, timeout = 6000): Promise<T> => {
		const deadline = performance.now() + timeout;
		for (;;) {
			const result = await read();
			if (result !== null) return result;
			if (performance.now() >= deadline)
				throw new Error("Native fixture observation deadline exceeded");
			await delay(10);
		}
	};
	const blockedWriter = () =>
		waitFor(async () => {
			const rows = (
				await database.query<{ pid: number }>(
					`SELECT a.pid FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_locks l ON l.pid=a.pid
			WHERE a.datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
			AND a.application_name='arr-dashboard-schema-startup' AND a.wait_event_type='Lock'
			AND a.query LIKE 'CREATE UNIQUE INDEX "User_username_key"%'
			AND l.locktype='advisory' AND l.classid=$1::oid AND l.objid=1 AND l.objsubid=2 AND l.granted`,
					[namespaceKey],
				)
			).rows;
			return rows.length === 1 ? rows[0]!.pid : null;
		});
	const blockIndex = async () => {
		await fullTarget();
		await database.query('DROP INDEX "User_username_key"');
		const locker = await connection();
		await locker.query('BEGIN; LOCK TABLE "User" IN ROW EXCLUSIVE MODE');
		return locker;
	};
	const spawnActor = () => {
		const actor = fork(
			fileURLToPath(new URL("./fixtures/runtime-schema-actor.ts", import.meta.url)),
			[],
			{
				execArgv: ["--import", import.meta.resolve("tsx/esm")],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" },
			},
		);
		const closed = new Promise((resolve, reject) => {
			actor.once("error", reject);
			actor.once("close", (code, signal) => resolve({ code, signal }));
		});
		actors.set(actor, closed);
		actor.send({ databaseUrl: url });
		return { actor, closed };
	};
	const writerTransport = async (connectionUrl = url, dropCommitAcknowledgement = true) => {
		const destination = new URL(connectionString!);
		if (destination.hostname !== "127.0.0.1") throw new Error("Expected isolated loopback fixture");
		const sockets = new Set<Socket>();
		let dropped = 0;
		const commands = { updates: 0, commits: 0, rollbacks: 0 };
		const server = createServer((front) => {
			const back = connect({ host: "127.0.0.1", port: Number(destination.port) });
			// Match installed pg's transport: split protocol frames must not add a
			// Nagle/delayed-ACK wait to every query in this failure-only relay.
			front.setNoDelay(true);
			back.setNoDelay(true);
			sockets.add(front);
			sockets.add(back);
			let pending = Buffer.alloc(0);
			front.on("error", () => {});
			back.on("error", () => {});
			front.once("close", () => {
				sockets.delete(front);
				back.destroy();
			});
			back.once("close", () => {
				sockets.delete(back);
				front.destroy();
				pending = Buffer.alloc(0);
			});
			front.pipe(back);
			back.on("data", (bytes: Buffer) => {
				pending = Buffer.concat([pending, bytes]);
				while (pending.length >= 5) {
					const length = pending.readUInt32BE(1) + 1;
					if (length < 5 || length > 1024 * 1024) {
						front.destroy();
						back.destroy();
						return;
					}
					if (pending.length < length) return;
					const frame = pending.subarray(0, length);
					pending = pending.subarray(length);
					// Inspect only a protocol command tag from this synthetic fixture.
					// Never inspect/record startup, authentication, row or SQL bodies.
					const tag = frame[0] === 67 ? frame.subarray(5) : null;
					if (tag?.equals(Buffer.from("UPDATE 1\0"))) commands.updates++;
					if (tag?.equals(Buffer.from("ROLLBACK\0"))) commands.rollbacks++;
					if (tag?.equals(Buffer.from("COMMIT\0"))) commands.commits++;
					if (dropCommitAcknowledgement && !dropped && tag?.equals(Buffer.from("COMMIT\0"))) {
						dropped++;
						front.destroy();
						back.destroy();
						pending = Buffer.alloc(0);
						return;
					}
					front.write(frame);
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected loopback listener");
		const proxied = new URL(connectionUrl);
		proxied.port = String(address.port);
		transports.add(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		});
		return {
			url: proxied.toString(),
			dropped: () => dropped,
			commandCounts: () => ({ ...commands }),
		};
	};

	it(
		"actual CLI completes PostgreSQL dispatch and physical backend closure before its exact JSON projection",
		async () => {
			expect(await runStartupCli(url)).toEqual({
				code: 0,
				signal: null,
				stdout: '{"apiPort":null,"webPort":null,"listenAddress":null}\n',
				stderr: "",
			});
			expect(await countTables()).toBe(102);
			expect(await receipts()).toHaveLength(1);
			const ownerPid = (await journal())[0].ownerBackendPid;
			expect(
				(await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [ownerPid])).rows,
			).toEqual([]);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"actual CLI reports a failed PostgreSQL settings read without stdout, defaults or recovery-evidence changes",
		async () => {
			await synchronize();
			await database.query(`INSERT INTO system_settings(id,"apiPort","updatedAt")
			VALUES(1,0,CURRENT_TIMESTAMP)`);
			const before = await journal(),
				receipt = await receipts();
			expect(await runStartupCli(url)).toEqual(cliUnavailable);
			expect(await journal()).toEqual(before);
			expect(await receipts()).toEqual(receipt);
		},
		startupCliTestTimeoutMs,
	);
	it(
		"actual CLI keeps an unreachable PostgreSQL connection private and never prints healthy defaults",
		async () => {
			const unreachable = new URL(url);
			unreachable.port = "1";
			expect(await runStartupCli(unreachable.toString())).toEqual(cliUnavailable);
			expect(await countTables()).toBe(0);
		},
		startupCliTestTimeoutMs,
	);
	it("commits the entire fresh target, starting journal and positive receipt before returning closed", async () => {
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		expect(await countTables()).toBe(102);
		const rows = await journal();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: 1,
			protocolVersion: 1,
			phase: "starting",
			activeRestoreId: null,
			lastCommittedRestoreId: null,
			lastCommittedAt: null,
			destinationInstallationId: null,
		});
		expect(rows[0].runtimeEpoch).toMatch(/^[0-9a-f-]{36}$/);
		expect(rows[0].ownerBackendPid).toBeGreaterThan(0);
		expect(
			(
				await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [
					rows[0].ownerBackendPid,
				])
			).rows,
		).toEqual([]);
		expect(await receipts()).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/^[0-9a-f-]{36}$/),
				protocolVersion: 1,
				registryVersion: 1,
				provider: "postgresql",
				targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				planDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				completedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
			}),
		]);
	});
	it("reads configured settings and rotates the epoch without rewriting prior positive restore evidence", async () => {
		await fullTarget();
		const oldEpoch = randomUUID();
		const marker = randomUUID();
		await database.query(
			`UPDATE "RestoreRuntimeControl" SET phase='restart-required',
			"runtimeEpoch"=$1,"ownerBackendPid"=7,"activeRestoreId"=$2,
			"lastCommittedRestoreId"=$2,"lastCommittedAt"='2026-10-08 12:34:56.789',
			"destinationInstallationId"='synthetic-original'`,
			[oldEpoch, marker],
		);
		await database.query(`INSERT INTO system_settings(id,"apiPort","webPort","listenAddress","updatedAt")
			VALUES(1,4321,5432,'127.0.0.1',CURRENT_TIMESTAMP)`);
		expect(await synchronize()).toEqual({
			apiPort: 4321,
			webPort: 5432,
			listenAddress: "127.0.0.1",
		});
		const first = (await journal())[0];
		expect(first).toMatchObject({
			phase: "starting",
			activeRestoreId: null,
			lastCommittedRestoreId: marker,
			destinationInstallationId: "synthetic-original",
		});
		expect(first.runtimeEpoch).not.toBe(oldEpoch);
		expect(first.lastCommittedAt.toISOString()).toBe("2026-10-08T12:34:56.789Z");
		const priorReceipts = await receipts();
		expect(await synchronize()).toEqual({
			apiPort: 4321,
			webPort: 5432,
			listenAddress: "127.0.0.1",
		});
		expect((await journal())[0].runtimeEpoch).not.toBe(first.runtimeEpoch);
		const nextReceipts = await receipts();
		expect(nextReceipts).toHaveLength(2);
		expect(nextReceipts).toContainEqual(priorReceipts[0]);
		expect(new Set(nextReceipts.map((row) => row.planDigest)).size).toBe(1);
	});
	it.each([0, -1, 65536])(
		"refuses invalid configured port %s without committing a receipt or epoch",
		async (port) => {
			await fullTarget();
			await database.query(
				`INSERT INTO system_settings(id,"apiPort","updatedAt") VALUES(1,$1,CURRENT_TIMESTAMP)`,
				[port],
			);
			const before = await journal();
			await refuse();
			expect(await journal()).toEqual(before);
			expect(await receipts()).toEqual([]);
		},
	);
	it("refuses multiple settings rows instead of choosing a healthy default", async () => {
		await fullTarget();
		await database.query(
			`INSERT INTO system_settings(id,"updatedAt") VALUES(1,CURRENT_TIMESTAMP),(2,CURRENT_TIMESTAMP)`,
		);
		await refuse();
		expect(await receipts()).toEqual([]);
	});
	it("rolls back the starting journal when the native final settings read lacks column permission", async () => {
		await fullTarget();
		await database.query(`INSERT INTO system_settings(id,"updatedAt") VALUES(1,CURRENT_TIMESTAMP)`);
		const role = `startup_reader_${process.pid}_${sequence}`;
		const password = randomUUID();
		await database.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
		roles.add(role);
		await database.query(`GRANT USAGE,CREATE ON SCHEMA "${schema}" TO "${role}";
			GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}";
			GRANT INSERT,UPDATE ON "RestoreRuntimeControl","ArrSchemaMigrationReceipt" TO "${role}";
			REVOKE SELECT ON system_settings FROM "${role}";
			GRANT SELECT(id) ON system_settings TO "${role}"`);
		const restricted = new URL(url);
		restricted.username = role;
		restricted.password = password;
		const probe = new Client({
			connectionString: restricted.toString(),
			connectionTimeoutMillis: 5000,
		});
		probe.on("error", () => {});
		await probe.connect();
		try {
			// Catalog/count preflight is permitted; the final settings projection is
			// not. This isolates the read failure from a missing settings singleton.
			expect(
				(await probe.query(`SELECT count(*)::int AS n FROM "${schema}".system_settings`)).rows,
			).toEqual([{ n: 1 }]);
			await expect(
				probe.query(`SELECT "apiPort" FROM "${schema}".system_settings`),
			).rejects.toMatchObject({ code: "42501" });
		} finally {
			await probe.end();
		}
		const before = await journal();
		const transport = await writerTransport(restricted.toString(), false);
		await expect(postgres.synchronizePostgresRuntimeSchema(transport.url)).rejects.toMatchObject({
			category: "startup-unavailable",
		});
		// Server tags establish a real journal write followed by rollback, not
		// an unrelated refusal before the final settings read was attempted.
		expect(transport.commandCounts()).toEqual({ updates: 1, commits: 0, rollbacks: 1 });
		expect(await journal()).toEqual(before);
		expect(await receipts()).toEqual([]);
	});
	it("refuses an existing empty runtime journal without filling in recovery evidence", async () => {
		await fullTarget();
		await database.query('DELETE FROM "RestoreRuntimeControl"');
		await refuse();
		expect(await journal()).toEqual([]);
		expect(await receipts()).toEqual([]);
	});
	it("refuses a receipt orphan without creating a missing runtime journal", async () => {
		await fullTarget();
		await database.query('DROP TABLE "RestoreRuntimeControl"');
		await refuse();
		expect(await countTables()).toBe(101);
		expect(await receipts()).toEqual([]);
	});
	it("refuses a wrong known schema before the first unrelated table is created", async () => {
		await database.query('CREATE TABLE "User"(id INTEGER NOT NULL PRIMARY KEY)');
		await refuse();
		expect(await countTables()).toBe(1);
	});
	it("keeps database-wide owner exclusion across different schema aliases", async () => {
		const other = await connection();
		await other.query("SELECT pg_advisory_lock($1,1)", [namespaceKey]);
		await other.query("SET search_path TO public");
		try {
			await refuse();
			expect(await countTables()).toBe(0);
		} finally {
			await other.query("SELECT pg_advisory_unlock($1,1)", [namespaceKey]);
		}
	});
	it("refuses an active operation holder without starting schema DDL", async () => {
		const other = await connection();
		await other.query("BEGIN");
		await other.query("SELECT pg_advisory_xact_lock_shared($1,2)", [namespaceKey]);
		await refuse();
		expect(await countTables()).toBe(0);
	});
	it("rolls back earlier schema DDL when a real unique-index creation fails", async () => {
		await fullTarget();
		await database.query('DROP TABLE "ArrSchemaMigrationReceipt"; DROP INDEX "User_username_key"');
		await database.query(`INSERT INTO "User"(id,username,"updatedAt") VALUES
			('first','duplicate',CURRENT_TIMESTAMP),('second','duplicate',CURRENT_TIMESTAMP)`);
		const before = await journal();
		await refuse();
		expect(await countTables()).toBe(101);
		expect(await journal()).toEqual(before);
		expect((await database.query('SELECT id FROM "User" ORDER BY id')).rows).toEqual([
			{ id: "first" },
			{ id: "second" },
		]);
	});
	it("conserves populated credentials, sessions and custom objects during a real additive upgrade", async () => {
		await fullTarget();
		await database.query(`ALTER TABLE "User" DROP COLUMN "failedLoginAttempts";
			ALTER TABLE "User" ADD COLUMN "fixtureExtra" TEXT;
			CREATE INDEX "fixture_user_extra" ON "User"("fixtureExtra");
			CREATE TABLE "fixtureAudit"(id TEXT NOT NULL PRIMARY KEY);
			CREATE FUNCTION fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO "fixtureAudit" VALUES('synthetic-audit'); RETURN NEW; END$$;
			CREATE TRIGGER fixture_audit_trigger AFTER UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION fixture_audit();
			CREATE VIEW fixture_user_view AS SELECT id,"fixtureExtra" FROM "User";
			INSERT INTO "User"(id,username,"hashedPassword","encryptedTmdbApiKey","tmdbEncryptionIv","fixtureExtra","updatedAt")
			VALUES('synthetic-user','synthetic-user','opaque-hash','opaque-cipher','opaque-iv','opaque-extra',CURRENT_TIMESTAMP);
			INSERT INTO sessions(id,"userId","expiresAt") VALUES('synthetic-session','synthetic-user','2027-01-01')`);
		const before = (
			await database.query(
				`SELECT id,username,"hashedPassword","encryptedTmdbApiKey","tmdbEncryptionIv","fixtureExtra" FROM "User"`,
			)
		).rows;
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		expect(
			(
				await database.query(
					`SELECT id,username,"hashedPassword","encryptedTmdbApiKey","tmdbEncryptionIv","fixtureExtra" FROM "User"`,
				)
			).rows,
		).toEqual(before);
		expect((await database.query('SELECT "failedLoginAttempts" FROM "User"')).rows).toEqual([
			{ failedLoginAttempts: 0 },
		]);
		expect((await database.query('SELECT id,"userId" FROM sessions')).rows).toEqual([
			{ id: "synthetic-session", userId: "synthetic-user" },
		]);
		expect((await database.query("SELECT * FROM fixture_user_view")).rows).toEqual([
			{ id: "synthetic-user", fixtureExtra: "opaque-extra" },
		]);
		expect((await database.query('SELECT * FROM "fixtureAudit"')).rows).toEqual([]);
		await database.query('UPDATE "User" SET "fixtureExtra"=\'updated-extra\'');
		expect((await database.query('SELECT * FROM "fixtureAudit"')).rows).toEqual([
			{ id: "synthetic-audit" },
		]);
		expect(
			(
				await database.query(
					"SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='fixture_user_extra'",
					[schema],
				)
			).rows,
		).toHaveLength(1);
	});
	it("refuses unknown runtime phases without changing the prior journal", async () => {
		await fullTarget();
		await database.query(`UPDATE "RestoreRuntimeControl" SET phase='unrecognized'`);
		const before = await journal();
		await refuse();
		expect(await journal()).toEqual(before);
		expect(await receipts()).toEqual([]);
	});
	it("refuses extra protocol columns rather than silently certifying an unknown journal contract", async () => {
		await fullTarget();
		await database.query('ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "unknownProtocol" TEXT');
		await refuse();
		expect(await receipts()).toEqual([]);
	});
	it("refuses a malformed prior receipt without inventing a replacement completion", async () => {
		await fullTarget();
		await database.query(
			`INSERT INTO "ArrSchemaMigrationReceipt" VALUES($1,1,1,'sqlite',$2,$2,CURRENT_TIMESTAMP)`,
			[randomUUID(), "a".repeat(64)],
		);
		const before = await receipts();
		await refuse();
		expect(await receipts()).toEqual(before);
		expect((await journal())[0].phase).toBe("idle");
	});
	it("uses the actual blocked DDL backend for both locks, and joins its terminated transaction before rejecting", async () => {
		const locker = await blockIndex();
		const outcome = synchronize().then(
			() => ({ category: "unexpected-success" }),
			(error: unknown) => error,
		);
		const pid = await blockedWriter();
		expect(
			(
				await database.query(
					`SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid AND objid IN(1,2) AND objsubid=2 AND granted AND mode='ExclusiveLock'`,
					[pid, namespaceKey],
				)
			).rows,
		).toEqual([{ n: 2 }]);
		await refuse();
		expect(
			(await database.query("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows,
		).toEqual([{ terminated: true }]);
		expect(await outcome).toMatchObject({ category: "startup-unavailable" });
		expect(
			(await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows,
		).toEqual([]);
		expect(await receipts()).toEqual([]);
		expect((await journal())[0].phase).toBe("idle");
		await locker.query("ROLLBACK");
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
	});
	it.each(["SIGTERM", "SIGKILL"] as const)(
		"does not admit a contender after actor %s while its blocked writing backend survives",
		async (signal) => {
			const locker = await blockIndex();
			const { actor, closed } = spawnActor();
			const pid = await blockedWriter();
			expect(actor.kill(signal)).toBe(true);
			expect(await closed).toMatchObject({ signal });
			expect(
				(await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows,
			).toHaveLength(1);
			await refuse();
			// Authority is still held by the observed native backend, not the dead
			// actor. Release our DDL blocker only after the contender is refused;
			// then observe actual backend exit instead of spending the test deadline
			// waiting for the server's unrelated lock timeout.
			await locker.query("ROLLBACK");
			await waitFor(async () =>
				(await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows
					.length === 0
					? true
					: null,
			);
			expect(await receipts()).toEqual([]);
			expect((await journal())[0].phase).toBe("idle");
			expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		},
	);
	it("reports unknown COMMIT acknowledgement while preserving the actual committed receipt for the next owner", async () => {
		const transport = await writerTransport();
		await expect(postgres.synchronizePostgresRuntimeSchema(transport.url)).rejects.toMatchObject({
			category: "commit-unknown",
		});
		expect(transport.dropped()).toBe(1);
		expect(await countTables()).toBe(102);
		const before = await receipts();
		expect(before).toHaveLength(1);
		const record = (await journal())[0];
		expect(record.phase).toBe("starting");
		expect(
			(
				await database.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [
					record.ownerBackendPid,
				])
			).rows,
		).toEqual([]);
		expect(await synchronize()).toEqual({ apiPort: null, webPort: null, listenAddress: null });
		const after = await receipts();
		expect(after).toHaveLength(2);
		expect(after).toContainEqual(before[0]);
		expect(after.find((row) => row.id !== before[0].id)!.planDigest).not.toBe(before[0].planDigest);
	});
});
