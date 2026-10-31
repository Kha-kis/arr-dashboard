import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statfsSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecoverableSqliteAdapter } from "../../sqlite-adapter.js";
import {
	isEligibleSqliteRestoreMount,
	resolveSqliteRestoreStorage,
	SqliteRestoreStorageUnavailableError,
} from "../restore-runtime-sqlite-storage.js";

const ROOT_MOUNT = "18 0 0:27 / / rw,relatime - overlay overlay rw\n";
const LOCAL_TYPE = 0x794c7630n;

describe("SQLite Restore trusted mount eligibility", () => {
	it.each([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, LOCAL_TYPE])(
		"accepts eligible local filesystem type %s without granting ownership",
		(type) => {
			expect(isEligibleSqliteRestoreMount("/config/main.db", ROOT_MOUNT, type, "linux")).toBe(true);
		},
	);

	it("accepts a local Linux ZFS directory volume without granting ownership", () => {
		const mount = `${ROOT_MOUNT}19 18 0:43 /home/config /config rw - zfs fixture/home rw\n`;
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, 0x2fc12fc1n, "linux")).toBe(true);
	});

	it("still refuses a file-only bind mount on local Linux ZFS", () => {
		const mount = `${ROOT_MOUNT}19 18 0:43 /home/config/main.db /config/main.db rw - zfs fixture/home rw\n`;
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, 0x2fc12fc1n, "linux")).toBe(
			false,
		);
	});

	it.each(["win32", "darwin", "freebsd"])("refuses ZFS on unproved platform %s", (platform) => {
		expect(isEligibleSqliteRestoreMount("/config/main.db", ROOT_MOUNT, 0x2fc12fc1n, platform)).toBe(
			false,
		);
	});

	it.each([0x6969n, 0x517bn, 0xff534d42n, 0xfe534d42n, 0n, -1n])(
		"refuses network or unknown filesystem type %s",
		(type) => {
			expect(isEligibleSqliteRestoreMount("/config/main.db", ROOT_MOUNT, type, "linux")).toBe(
				false,
			);
		},
	);

	it.each(["win32", "darwin", "freebsd", ""])("refuses unproved platform %s", (platform) => {
		expect(isEligibleSqliteRestoreMount("/config/main.db", ROOT_MOUNT, LOCAL_TYPE, platform)).toBe(
			false,
		);
	});

	it("refuses a file-only bind mount even on an otherwise eligible local device", () => {
		const mount = `${ROOT_MOUNT}19 18 0:27 /data/main.db /config/main.db rw - overlay overlay rw\n`;
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, LOCAL_TYPE, "linux")).toBe(false);
	});

	it("accepts a directory-volume mount rather than rejecting its descendants", () => {
		const mount = `${ROOT_MOUNT}19 18 0:27 /data /config rw - overlay overlay rw\n`;
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, LOCAL_TYPE, "linux")).toBe(true);
	});

	it("does not let an unrelated non-POSIX mount root disable local Linux storage", () => {
		const mount = `${ROOT_MOUNT}19 18 0:40 C:\\134 /mnt/windows rw - 9p drvfs rw\n`;
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, LOCAL_TYPE, "linux")).toBe(true);
	});

	it("refuses mount evidence with no containing destination mount", () => {
		const mount = "19 18 0:27 /data /elsewhere rw - overlay overlay rw\n";
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, LOCAL_TYPE, "linux")).toBe(false);
	});

	it.each([
		["/config dir/main.db", "/config\\040dir/main.db"],
		["/config\\dir/main.db", "/config\\134dir/main.db"],
	])("decodes Linux mount escapes once before refusing file mount %s", (path, escaped) => {
		const mount = `${ROOT_MOUNT}19 18 0:27 /data/main.db ${escaped} rw - overlay overlay rw\n`;
		expect(isEligibleSqliteRestoreMount(path, mount, LOCAL_TYPE, "linux")).toBe(false);
	});

	it.each([
		"",
		"not mount evidence",
		"18 0 0:27 / / rw",
		"18 0 device / / rw - overlay overlay rw",
		"18 0 0:27 relative / rw - overlay overlay rw",
		"18 0 0:27 / relative rw - overlay overlay rw",
		"18 0 0:27 / / rw - overlay",
		"18 0 0:27 / /bad\\999path rw - overlay overlay rw",
		`${ROOT_MOUNT}18 0 0:27 / /second rw - overlay overlay rw\n`,
		`${ROOT_MOUNT}\n`,
		"x".repeat(1024 * 1024 + 1),
		`${ROOT_MOUNT}${"19 18 0:27 / /extra rw - overlay overlay rw\n".repeat(10000)}`,
	])("refuses malformed, duplicate or oversized trusted mount evidence case %#", (mount) => {
		expect(isEligibleSqliteRestoreMount("/config/main.db", mount, LOCAL_TYPE, "linux")).toBe(false);
	});

	it("rejects a noncanonical classifier destination", () => {
		expect(isEligibleSqliteRestoreMount("relative.db", ROOT_MOUNT, LOCAL_TYPE, "linux")).toBe(
			false,
		);
		expect(
			isEligibleSqliteRestoreMount("/config/../main.db", ROOT_MOUNT, LOCAL_TYPE, "linux"),
		).toBe(false);
	});
});

describe("SQLite Restore actual filesystem identity", () => {
	let directory: string;
	let database: string;
	const content = "disposable filesystem-identity fixture, not SQL lock acceptance";

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-storage-"));
		database = join(directory, "main.db");
		writeFileSync(database, content, { mode: 0o600, flag: "wx" });
		// Do not skip unsupported evidence: this run must genuinely exercise
		// eligible Linux storage before claiming native filesystem acceptance.
		expect(process.platform).toBe("linux");
		expect(
			isEligibleSqliteRestoreMount(
				realpathSync(database),
				readFileSync("/proc/self/mountinfo", "utf8"),
				statfsSync(directory, { bigint: true }).type,
				process.platform,
			),
		).toBe(true);
	});

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("freezes the canonical namespace without changing or creating database files", () => {
		const storage = resolveSqliteRestoreStorage(`file:${database}`);
		expect(storage.databasePath).toBe(realpathSync(database));
		expect(storage.directoryPath).toBe(realpathSync(directory));
		expect(storage.coordinationDirectoryPath).toBe(`${realpathSync(database)}.arr-restore-runtime`);
		expect(Object.isFrozen(storage)).toBe(true);
		storage.assertUnchanged();
		expect(readFileSync(database, "utf8")).toBe(content);
		expect(existsSync(storage.coordinationDirectoryPath)).toBe(false);
	});

	it("does not cancel a real SQLite lock through metadata checks", () => {
		const lockedPath = join(directory, "locked.db");
		const owner = new Database(lockedPath, { timeout: 0 });
		owner.exec("CREATE TABLE Marker (value INTEGER); INSERT INTO Marker VALUES (7)");
		owner.exec("BEGIN IMMEDIATE");
		try {
			const storage = resolveSqliteRestoreStorage(lockedPath);
			for (let attempt = 0; attempt < 5; attempt++) storage.assertUnchanged();
			const require = createRequire(import.meta.url);
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=commonjs",
					"-e",
					`const Database=require(process.argv[1]);let db;let status='error';try{db=new Database(process.argv[2],{timeout:0,fileMustExist:true});try{db.exec('BEGIN IMMEDIATE');status='acquired';db.exec('ROLLBACK');}catch(error){if(error.code==='SQLITE_BUSY')status='busy';}}finally{if(db?.open)db.close();}process.stdout.write(status);`,
					require.resolve("better-sqlite3"),
					lockedPath,
				],
				{ encoding: "utf8", timeout: 5000 },
			);
			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
			expect(child.stdout).toBe("busy");
			expect(owner.prepare("SELECT value FROM Marker").pluck().get()).toBe(7);
		} finally {
			if (owner.inTransaction) owner.exec("ROLLBACK");
			owner.close();
		}
	});

	it("normalizes a main-file symlink to the same coordination namespace", () => {
		const alias = join(directory, "alias.db");
		symlinkSync(database, alias);
		const storage = resolveSqliteRestoreStorage(`file:${alias}`);
		expect(storage.coordinationDirectoryPath).toBe(`${realpathSync(database)}.arr-restore-runtime`);
		storage.assertUnchanged();
	});

	it("normalizes a parent-directory symlink to the same namespace", () => {
		const alias = join(directory, "alias-directory");
		symlinkSync(directory, alias, "dir");
		const storage = resolveSqliteRestoreStorage(`file:${join(alias, "main.db")}`);
		expect(storage.coordinationDirectoryPath).toBe(`${realpathSync(database)}.arr-restore-runtime`);
		storage.assertUnchanged();
	});

	it("matches raw absolute and relative adapter path interpretation", () => {
		expect(resolveSqliteRestoreStorage(database).databasePath).toBe(realpathSync(database));
		expect(resolveSqliteRestoreStorage(relative(process.cwd(), database)).databasePath).toBe(
			realpathSync(database),
		);
	});

	it("does not percent-decode a literal adapter filename", () => {
		const literal = join(directory, "literal%20name.db");
		writeFileSync(literal, content, { mode: 0o600, flag: "wx" });
		expect(resolveSqliteRestoreStorage(`file:${literal}`).databasePath).toBe(realpathSync(literal));
		expect(existsSync(join(directory, "literal name.db"))).toBe(false);
	});

	it.each([" ", "\u00a0"])(
		"matches actual adapter trimming despite a misleading trailing-whitespace inode case %#",
		async (whitespace) => {
			const actual = join(directory, "actual.db");
			const decoy = join(directory, "decoy.db");
			for (const [path, value] of [
				[actual, 11],
				[decoy, 99],
			] as const) {
				const db = new Database(path);
				db.exec(`CREATE TABLE Marker (value INTEGER); INSERT INTO Marker VALUES (${value})`);
				db.close();
			}
			const input = `${actual}${whitespace}`;
			renameSync(decoy, input);
			// The Prisma plugin removes the single file: prefix before handing
			// this literal path to the installed adapter/SQLite driver.
			const driver = await createRecoverableSqliteAdapter({
				url: input,
				fileMustExist: true,
			}).connect();
			try {
				const result = await driver.queryRaw({
					sql: "SELECT value FROM Marker",
					args: [],
					argTypes: [],
				});
				expect(Number(result.rows[0]?.[0])).toBe(11);
			} finally {
				await driver.dispose();
			}
			const storage = resolveSqliteRestoreStorage(`file:${input}`);
			expect(storage.databasePath).toBe(realpathSync(actual));
			expect(storage.coordinationDirectoryPath).toBe(`${realpathSync(actual)}.arr-restore-runtime`);
		},
	);

	it("matches actual adapter leading-space trimming rather than treating it as a relative file", async () => {
		const actual = join(directory, "actual.db");
		const db = new Database(actual);
		db.exec("CREATE TABLE Marker (value INTEGER); INSERT INTO Marker VALUES (11)");
		db.close();
		const input = ` ${actual}`;
		const driver = await createRecoverableSqliteAdapter({
			url: input,
			fileMustExist: true,
		}).connect();
		try {
			const result = await driver.queryRaw({
				sql: "SELECT value FROM Marker",
				args: [],
				argTypes: [],
			});
			expect(Number(result.rows[0]?.[0])).toBe(11);
		} finally {
			await driver.dispose();
		}
		expect(resolveSqliteRestoreStorage(`file:${input}`).databasePath).toBe(realpathSync(actual));
	});

	it.each([
		"",
		"file:",
		":memory:",
		"file::memory:",
		"file:file:main.db",
		"postgres://redacted",
		"postgresql://redacted",
		"file:bad\u0000path",
	])("refuses an ambiguous or nonpersistent destination case %#", (value) => {
		expect(() => resolveSqliteRestoreStorage(value)).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("refuses missing and non-file destinations without creating them", () => {
		const missing = join(directory, "missing.db");
		expect(() => resolveSqliteRestoreStorage(`file:${missing}`)).toThrow(
			SqliteRestoreStorageUnavailableError,
		);
		expect(existsSync(missing)).toBe(false);
		expect(() => resolveSqliteRestoreStorage(`file:${directory}`)).toThrow(
			SqliteRestoreStorageUnavailableError,
		);
	});

	it("refuses multiple hard-link namespaces for the same file", () => {
		const alias = join(directory, "hard-link.db");
		linkSync(database, alias);
		expect(() => resolveSqliteRestoreStorage(database)).toThrow(
			SqliteRestoreStorageUnavailableError,
		);
		expect(() => resolveSqliteRestoreStorage(alias)).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("permanently invalidates a replaced main file even after the old inode returns", () => {
		const storage = resolveSqliteRestoreStorage(database);
		const old = join(directory, "old.db");
		renameSync(database, old);
		writeFileSync(database, content, { mode: 0o600, flag: "wx" });
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
		unlinkSync(database);
		renameSync(old, database);
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("invalidates a main symlink retargeted to another file", () => {
		const alias = join(directory, "alias.db");
		const other = join(directory, "other.db");
		writeFileSync(other, content, { mode: 0o600, flag: "wx" });
		symlinkSync(database, alias);
		const storage = resolveSqliteRestoreStorage(alias);
		unlinkSync(alias);
		symlinkSync(other, alias);
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("invalidates a missing original alias even if the canonical target remains", () => {
		const alias = join(directory, "alias.db");
		symlinkSync(database, alias);
		const storage = resolveSqliteRestoreStorage(alias);
		unlinkSync(alias);
		expect(existsSync(database)).toBe(true);
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("invalidates a newly introduced hard link", () => {
		const storage = resolveSqliteRestoreStorage(database);
		linkSync(database, join(directory, "hard-link.db"));
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("invalidates parent replacement even when the original database inode is moved back", () => {
		const parent = join(directory, "data");
		mkdirSync(parent);
		const nested = join(parent, "main.db");
		writeFileSync(nested, content, { mode: 0o600, flag: "wx" });
		const storage = resolveSqliteRestoreStorage(nested);
		const old = join(directory, "old-parent");
		renameSync(parent, old);
		mkdirSync(parent);
		renameSync(join(old, "main.db"), nested);
		expect(() => storage.assertUnchanged()).toThrow(SqliteRestoreStorageUnavailableError);
	});

	it("never exposes private dependency path or error cause", () => {
		const marker = "private-test-path-do-not-return";
		let captured: unknown;
		try {
			resolveSqliteRestoreStorage(join(directory, marker));
		} catch (error) {
			captured = error;
		}
		expect(captured).toBeInstanceOf(SqliteRestoreStorageUnavailableError);
		const error = captured as SqliteRestoreStorageUnavailableError;
		expect(error.statusCode).toBe(503);
		expect(error.cause).toBeUndefined();
		expect(`${error.message}${JSON.stringify(error)}`).not.toContain(marker);
		expect(`${error.message}${JSON.stringify(error)}`).not.toContain(directory);
	});
});
