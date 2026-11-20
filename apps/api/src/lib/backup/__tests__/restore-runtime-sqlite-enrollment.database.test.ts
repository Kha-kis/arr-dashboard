import { fork, type ChildProcess, execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	enrollSqliteRestoreRuntimeStorage,
	SqliteRestoreRuntimeEnrollmentError,
	type SqliteRestoreRuntimeEnrollment,
} from "../restore-runtime-sqlite-enrollment.js";
import { resolveSqliteRestoreStorage } from "../restore-runtime-sqlite-storage.js";
import {
	acquireSqliteRestoreOperationLock,
	acquireSqliteRestoreRuntimeOwnership,
} from "../restore-runtime-sqlite.js";

describe("SQLite Restore destination-owned cold storage enrollment", () => {
	let directory: string;
	let databasePath: string;
	let databaseUrl: string;
	let main: Database.Database;
	let coordinator: string;
	const held: SqliteRestoreRuntimeEnrollment[] = [];
	const actors: { child: ChildProcess; exit: Promise<void> }[] = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-enrollment-"));
		databasePath = join(directory, "main.db");
		databaseUrl = `file:${databasePath}`;
		coordinator = `${databasePath}.arr-restore-runtime`;
		main = new Database(databasePath);
		main.pragma("journal_mode = WAL");
		main.exec(`CREATE TABLE Marker(value INTEGER); INSERT INTO Marker VALUES(7);
			CREATE TABLE RestoreRuntimeControl (id INTEGER PRIMARY KEY, protocolVersion INTEGER, phase TEXT);
			CREATE TABLE SqliteRestoreStorageBinding (
				id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL,
				databaseDevice TEXT NOT NULL, databaseInode TEXT NOT NULL,
				directoryDevice TEXT NOT NULL, directoryInode TEXT NOT NULL,
				coordinationDevice TEXT NOT NULL, coordinationInode TEXT NOT NULL,
				ownerDevice TEXT NOT NULL, ownerInode TEXT NOT NULL,
				operationsDevice TEXT NOT NULL, operationsInode TEXT NOT NULL
			)`);
		chmodSync(databasePath, 0o600);
	});
	const enroll = async (url = databaseUrl) => {
		const result = await enrollSqliteRestoreRuntimeStorage(url);
		held.push(result);
		return result;
	};
	const binding = () => main.prepare("SELECT * FROM SqliteRestoreStorageBinding").all();
	const refuse = async (pending: Promise<unknown>) => {
		try {
			await pending;
			expect.fail("Unavailable enrollment must not return authority");
		} catch (error) {
			expect(error).toBeInstanceOf(SqliteRestoreRuntimeEnrollmentError);
			expect(error).toMatchObject({ statusCode: 503 });
			expect(error).not.toHaveProperty("cause");
			expect(String(error)).not.toContain(directory);
		}
	};
	afterEach(async () => {
		for (const actor of actors.splice(0)) {
			if (actor.child.exitCode === null && actor.child.signalCode === null)
				actor.child.kill("SIGKILL");
			await actor.exit;
		}
		for (const result of held.splice(0)) await result.ownership.close();
		main.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const actor = (mode = "owner", url = databaseUrl) => {
		const file = process.env.SQLITE_RESTORE_ENROLLMENT_ACTOR_FILE;
		if (!file || !existsSync(file)) throw new Error("Compiled enrollment actor is required");
		const child = fork(file, [url, mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const ready = new Promise<string>((resolve) => {
			child.once("message", (message: { kind: string }) => resolve(message.kind));
			child.once("error", () => resolve("actor-error"));
		});
		actors.push({ child, exit });
		return { child, exit, ready };
	};

	it("persists the original physical identities and returns a retained exclusive owner", async () => {
		const result = await enroll();
		expect(Object.isFrozen(result)).toBe(true);
		expect(result.storage.databasePath).toBe(databasePath);
		const paths = [
			databasePath,
			directory,
			coordinator,
			join(coordinator, "owner.sqlite3"),
			join(coordinator, "operations.sqlite3"),
		];
		const [database, parent, coordination, owner, operations] = paths.map((path) =>
			lstatSync(path, { bigint: true }),
		);
		expect(binding()).toEqual([
			{
				id: 1,
				protocolVersion: 1,
				databaseDevice: String(database!.dev),
				databaseInode: String(database!.ino),
				directoryDevice: String(parent!.dev),
				directoryInode: String(parent!.ino),
				coordinationDevice: String(coordination!.dev),
				coordinationInode: String(coordination!.ino),
				ownerDevice: String(owner!.dev),
				ownerInode: String(owner!.ino),
				operationsDevice: String(operations!.dev),
				operationsInode: String(operations!.ino),
			},
		]);
		expect(Number(coordination!.mode & 0o777n)).toBe(0o700);
		for (const stat of [owner!, operations!]) expect(Number(stat.mode & 0o777n)).toBe(0o600);
		await result.ownership.assertOwned();
		expect(await result.ownership.tryAcquireExclusive()).toBe(true);
		await expect(acquireSqliteRestoreOperationLock(databaseUrl)).rejects.toBeDefined();
		expect(main.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
		expect(main.prepare("SELECT * FROM RestoreRuntimeControl").all()).toEqual([]);
	});

	it("reuses an immutable binding after deliberate close without changing data or journal", async () => {
		const first = await enroll();
		const original = binding();
		await first.ownership.close();
		main.exec("INSERT INTO RestoreRuntimeControl VALUES(1,1,'restart-required')");
		const next = await enroll();
		await next.ownership.assertOwned();
		expect(binding()).toEqual(original);
		expect(main.prepare("SELECT * FROM RestoreRuntimeControl").all()).toEqual([
			{ id: 1, protocolVersion: 1, phase: "restart-required" },
		]);
	});

	it("uses one binding for a symlink alias rather than provisioning another namespace", async () => {
		const first = await enroll();
		await first.ownership.close();
		const alias = join(directory, "alias.db");
		symlinkSync(databasePath, alias);
		const next = await enroll(`file:${alias}`);
		expect(next.storage.databasePath).toBe(databasePath);
		expect(binding()).toHaveLength(1);
		expect(existsSync(`${alias}.arr-restore-runtime`)).toBe(false);
	});

	it("a losing concurrent initializer cannot change the successful binding or erase its lock", async () => {
		const results = await Promise.allSettled([enroll(), enroll()]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect(binding()).toHaveLength(1);
		await held[0]!.ownership.assertOwned();
		await expect(acquireSqliteRestoreRuntimeOwnership(databaseUrl)).rejects.toBeDefined();
	});

	it("retains a live participant's lock when a later cold enrollment cannot acquire exclusion", async () => {
		const first = await enroll();
		await first.ownership.releaseExclusive();
		const participant = await acquireSqliteRestoreOperationLock(databaseUrl);
		try {
			await first.ownership.close();
			const original = binding();
			await refuse(enroll());
			await participant.assertHeld();
			expect(binding()).toEqual(original);
		} finally {
			await participant.close();
		}
		await (await enroll()).ownership.assertOwned();
	});

	it.each(["directory", "owner", "operations"])(
		"refuses missing prior %s without reconstruction",
		async (kind) => {
			const first = await enroll();
			await first.ownership.close();
			const path = kind === "directory" ? coordinator : join(coordinator, `${kind}.sqlite3`);
			renameSync(path, `${path}.retained`);
			const original = binding();
			await refuse(enroll());
			expect(existsSync(path)).toBe(false);
			expect(binding()).toEqual(original);
		},
	);

	it("refuses a same-schema replacement coordinator inode rather than overwriting its anchor", async () => {
		const first = await enroll();
		await first.ownership.close();
		const path = join(coordinator, "owner.sqlite3");
		renameSync(path, `${path}.retained`);
		const replacement = new Database(path);
		replacement.exec(
			"CREATE TABLE RestoreOwnerCoordination(id INTEGER PRIMARY KEY, protocolVersion INTEGER); INSERT INTO RestoreOwnerCoordination VALUES(1,1)",
		);
		replacement.close();
		chmodSync(path, 0o600);
		const original = binding();
		await refuse(enroll());
		expect(binding()).toEqual(original);
	});

	it("retains and refuses an interrupted unanchored initialization directory", async () => {
		mkdirSync(coordinator, { mode: 0o700 });
		const interrupted = new Database(join(coordinator, "owner.sqlite3"));
		interrupted.exec("CREATE TABLE Interrupted(value INTEGER); INSERT INTO Interrupted VALUES(9)");
		interrupted.close();
		await refuse(enroll());
		expect(binding()).toEqual([]);
		expect(existsSync(join(coordinator, "operations.sqlite3"))).toBe(false);
		const retained = new Database(join(coordinator, "owner.sqlite3"), { readonly: true });
		try {
			expect(retained.prepare("SELECT * FROM Interrupted").all()).toEqual([{ value: 9 }]);
		} finally {
			retained.close();
		}
	});

	it("refuses a journal with evidence but no anchor without creating sidecars", async () => {
		main.exec("INSERT INTO RestoreRuntimeControl VALUES(1,1,'idle')");
		await refuse(enroll());
		expect(binding()).toEqual([]);
		expect(existsSync(coordinator)).toBe(false);
	});

	it.each(["version", "extra-row", "identity"])(
		"refuses malformed existing anchor %s without repairs",
		async (kind) => {
			const first = await enroll();
			await first.ownership.close();
			if (kind === "version") main.exec("UPDATE SqliteRestoreStorageBinding SET protocolVersion=2");
			if (kind === "identity") main.exec("UPDATE SqliteRestoreStorageBinding SET ownerInode='0'");
			if (kind === "extra-row")
				main.exec(
					"INSERT INTO SqliteRestoreStorageBinding SELECT 2, protocolVersion, databaseDevice,databaseInode,directoryDevice,directoryInode,coordinationDevice,coordinationInode,ownerDevice,ownerInode,operationsDevice,operationsInode FROM SqliteRestoreStorageBinding",
				);
			const original = binding();
			await refuse(enroll());
			expect(binding()).toEqual(original);
		},
	);

	it("rolls back an anchor insertion failure but retains new coordination for fail-closed retry", async () => {
		main.exec(
			"CREATE TRIGGER RejectAnchor BEFORE INSERT ON SqliteRestoreStorageBinding BEGIN SELECT RAISE(ABORT,'private fixture error'); END",
		);
		await refuse(enroll());
		expect(binding()).toEqual([]);
		expect(existsSync(join(coordinator, "owner.sqlite3"))).toBe(true);
		expect(existsSync(join(coordinator, "operations.sqlite3"))).toBe(true);
		main.exec("DROP TRIGGER RejectAnchor");
		await refuse(enroll());
		expect(binding()).toEqual([]);
	});

	it("refuses an unavailable binding schema before any coordination creation", async () => {
		main.exec("DROP TABLE SqliteRestoreStorageBinding");
		await refuse(enroll());
		expect(existsSync(coordinator)).toBe(false);
	});

	it("an independent losing process cannot replace or release the live destination owner", async () => {
		const first = actor();
		expect(await first.ready).toBe("owned");
		const original = binding();
		const alias = join(directory, "process-alias.db");
		symlinkSync(databasePath, alias);
		const second = actor("owner", `file:${alias}`);
		expect(await second.ready).toBe("unavailable");
		await second.exit;
		expect(binding()).toEqual(original);
		await refuse(enroll());
		await expect(acquireSqliteRestoreRuntimeOwnership(databaseUrl)).rejects.toBeDefined();
	});

	it("native process death after a committed anchor permits one new cold owner without rebinding", async () => {
		const first = actor();
		expect(await first.ready).toBe("owned");
		const original = binding();
		first.child.kill("SIGKILL");
		await first.exit;
		const next = await enroll();
		await next.ownership.assertOwned();
		expect(binding()).toEqual(original);
	});

	it("native process death before anchor commit leaves a refused orphan, not reconstructed coordination", async () => {
		const interrupted = actor("interrupt");
		await interrupted.exit;
		expect(interrupted.child.signalCode).toBe("SIGKILL");
		expect(binding()).toEqual([]);
		expect(existsSync(join(coordinator, "owner.sqlite3"))).toBe(true);
		expect(existsSync(join(coordinator, "operations.sqlite3"))).toBe(true);
		await refuse(enroll());
		expect(binding()).toEqual([]);
	});

	it("refuses a copied main database with retained anchor but a different main inode", async () => {
		const first = await enroll();
		await first.ownership.close();
		const original = binding();
		const replacement = join(directory, "replacement.db");
		await main.backup(replacement);
		main.close();
		renameSync(databasePath, `${databasePath}.retained`);
		renameSync(replacement, databasePath);
		main = new Database(databasePath);
		await refuse(enroll());
		expect(binding()).toEqual(original);
	});

	it("never adopts complete sidecars after the destination anchor was removed", async () => {
		const first = await enroll();
		await first.ownership.close();
		main.exec("DELETE FROM SqliteRestoreStorageBinding");
		await refuse(enroll());
		expect(binding()).toEqual([]);
		expect(existsSync(join(coordinator, "operations.sqlite3"))).toBe(true);
	});

	it("an additive production-schema upgrade preserves populated rows and does not enroll implicitly", async () => {
		const apiDir = join(import.meta.dirname, "../../../..");
		const production = readFileSync(join(apiDir, "prisma/schema.prisma"), "utf8").replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		);
		const oldSchema = join(directory, "old.prisma");
		const currentSchema = join(directory, "current.prisma");
		const config = join(directory, "safe.config.ts");
		writeFileSync(
			oldSchema,
			production.replace(/^model SqliteRestoreStorageBinding \{[\s\S]*?^\}\n?/m, ""),
			{ mode: 0o600 },
		);
		writeFileSync(currentSchema, production, { mode: 0o600 });
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		const url = `file:${join(directory, "upgrade.db")}`;
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ"].flatMap((name) =>
				process.env[name] ? [[name, process.env[name]]] : [],
			),
		);
		const push = (schema: string) =>
			promisify(execFile)(
				process.execPath,
				[
					join(apiDir, "node_modules/prisma/build/index.js"),
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
		await push(oldSchema);
		const seed = new Database(join(directory, "upgrade.db"));
		let beforeUser: unknown[];
		let beforeSession: unknown[];
		try {
			seed.exec(`INSERT INTO User (id, username, createdAt, updatedAt) VALUES ('preserved-owner','fixture-owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
				INSERT INTO sessions (id,userId,expiresAt) VALUES ('preserved-session','preserved-owner','2030-01-01T00:00:00.000Z')`);
			beforeUser = seed.prepare("SELECT * FROM User").all();
			beforeSession = seed.prepare("SELECT * FROM sessions").all();
		} finally {
			seed.close();
		}
		await push(currentSchema);
		const upgrade = new Database(join(directory, "upgrade.db"));
		try {
			expect(upgrade.prepare("SELECT * FROM User").all()).toEqual(beforeUser);
			expect(upgrade.prepare("SELECT * FROM sessions").all()).toEqual(beforeSession);
			expect(upgrade.prepare("SELECT * FROM SqliteRestoreStorageBinding").all()).toEqual([]);
			expect(upgrade.prepare("SELECT * FROM RestoreRuntimeControl").all()).toEqual([]);
			expect(existsSync(`${join(directory, "upgrade.db")}.arr-restore-runtime`)).toBe(false);
			const runtime = await enrollSqliteRestoreRuntimeStorage(url, {
				runtimeEpoch: "44444444-4444-4444-8444-444444444444",
			});
			held.push(runtime);
			expect(upgrade.prepare("SELECT * FROM RestoreRuntimeControl").all()).toEqual([
				{
					id: 1,
					protocolVersion: 1,
					phase: "starting",
					runtimeEpoch: "44444444-4444-4444-8444-444444444444",
					ownerBackendPid: null,
					activeRestoreId: null,
					lastCommittedRestoreId: null,
					lastCommittedAt: null,
					destinationInstallationId: null,
				},
			]);
			expect(upgrade.prepare("SELECT * FROM SqliteRestoreStorageBinding").all()).toHaveLength(1);
			expect(upgrade.prepare("SELECT * FROM User").all()).toEqual(beforeUser);
			expect(upgrade.prepare("SELECT * FROM sessions").all()).toEqual(beforeSession);
		} finally {
			upgrade.close();
		}
	}, 120000);

	it("refuses canonical symlink targets that the driver would trim to a different existing file", () => {
		const trimmedTarget = join(directory, "target.db");
		const actualTarget = `${trimmedTarget} `;
		main.close();
		renameSync(databasePath, actualTarget);
		const decoy = new Database(trimmedTarget);
		decoy.exec("CREATE TABLE Marker(value INTEGER); INSERT INTO Marker VALUES(99)");
		decoy.close();
		const alias = join(directory, "alias.db");
		symlinkSync(actualTarget, alias);
		const actual = new Database(alias, { readonly: true });
		try {
			expect(actual.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
		} finally {
			actual.close();
		}
		expect(() => resolveSqliteRestoreStorage(`file:${alias}`)).toThrow();
	});
});
