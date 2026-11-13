import { fork, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireSqliteRestoreOperationLock,
	acquireSqliteRestoreRuntimeOwnership,
	SqliteRestoreRuntimeOwnershipError,
	type SqliteRestoreOperationLock,
	type SqliteRestoreRuntimeOwnership,
} from "../restore-runtime-sqlite.js";

type Message = { kind: string; value?: boolean };
type Actor = {
	child: ChildProcess | Worker;
	read(): Promise<Message>;
	command(value: string): Promise<Message>;
	exit: Promise<void>;
};

describe("SQLite Restore native provider-held transport", () => {
	let directory: string;
	let databasePath: string;
	let databaseUrl: string;
	let coordinator: string;
	const handles: (SqliteRestoreRuntimeOwnership | SqliteRestoreOperationLock)[] = [];
	const actors: Actor[] = [];

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-sqlite-native-"));
		databasePath = join(directory, "main.db");
		databaseUrl = `file:${databasePath}`;
		const main = new Database(databasePath);
		main.pragma("journal_mode = WAL");
		main.exec("CREATE TABLE Marker (value INTEGER); INSERT INTO Marker VALUES (7)");
		main.close();
		chmodSync(databasePath, 0o600);
		coordinator = `${databasePath}.arr-restore-runtime`;
		mkdirSync(coordinator, { mode: 0o700 });
		for (const [file, table] of [
			["owner.sqlite3", "RestoreOwnerCoordination"],
			["operations.sqlite3", "RestoreOperationCoordination"],
		]) {
			const path = join(coordinator, file!);
			const db = new Database(path);
			db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL);
                INSERT INTO ${table} VALUES (1, 1)`);
			db.close();
			chmodSync(path, 0o600);
		}
	});

	afterEach(async () => {
		for (const actor of actors.splice(0)) {
			if (actor.child instanceof Worker) await actor.child.terminate();
			else if (actor.child.exitCode === null && actor.child.signalCode === null) {
				actor.child.kill("SIGKILL");
			}
			await actor.exit;
		}
		for (const handle of handles.splice(0)) await handle.close();
		rmSync(directory, { recursive: true, force: true });
	});

	const owner = async (onUnavailable?: () => void) => {
		const handle = await acquireSqliteRestoreRuntimeOwnership(databaseUrl, onUnavailable);
		handles.push(handle);
		return handle;
	};
	const participant = async () => {
		const handle = await acquireSqliteRestoreOperationLock(databaseUrl);
		handles.push(handle);
		return handle;
	};
	const actor = (mode: "owner" | "participant", worker = false): Actor => {
		const file = process.env.SQLITE_RESTORE_ACTOR_FILE;
		if (!file || !existsSync(file)) throw new Error("Compiled native actor is required");
		const child = worker
			? new Worker(file, { workerData: { databaseUrl, mode } })
			: fork(file, [databaseUrl, mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		const queue: Message[] = [];
		let waiter: ((message: Message) => void) | undefined;
		const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.on("error", () => {
			const message = { kind: "actor-error" };
			if (waiter) {
				const deliver = waiter;
				waiter = undefined;
				deliver(message);
			} else queue.push(message);
		});
		child.on("message", (message: Message) => {
			if (waiter) {
				const deliver = waiter;
				waiter = undefined;
				deliver(message);
			} else queue.push(message);
		});
		const read = (): Promise<Message> => {
			const next = queue.shift();
			if (next) return Promise.resolve(next);
			return new Promise((resolve) => {
				waiter = resolve;
			});
		};
		const instance = {
			child,
			read,
			exit,
			command(value: string) {
				if (child instanceof Worker) child.postMessage(value);
				else child.send(value);
				return read();
			},
		};
		actors.push(instance);
		return instance;
	};

	it("admits one frozen owner and refuses a second without dropping the first lock", async () => {
		const first = await owner();
		expect(Object.isFrozen(first)).toBe(true);
		await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		await first.assertOwned();
		const independent = actor("owner");
		expect(await independent.read()).toEqual({ kind: "unavailable" });
		await independent.exit;
		expect(await first.tryAcquireExclusive()).toBe(true);
	});

	it("keeps ordinary main WAL writes usable while owner and participant locks are held", async () => {
		await owner();
		await participant();
		const main = new Database(databasePath, { timeout: 0 });
		try {
			main.exec("UPDATE Marker SET value = 8");
			expect(main.prepare("SELECT value FROM Marker").pluck().get()).toBe(8);
		} finally {
			main.close();
		}
	});

	it("refuses exclusive until every independent participating actor releases", async () => {
		const first = await owner();
		const local = await participant();
		const independent = actor("participant");
		expect(await independent.read()).toEqual({ kind: "ready" });
		expect(await first.tryAcquireExclusive()).toBe(false);
		await local.close();
		expect(await first.tryAcquireExclusive()).toBe(false);
		expect(await independent.command("close")).toEqual({ kind: "closed" });
		await independent.exit;
		expect(await first.tryAcquireExclusive()).toBe(true);
	});

	it("retains exclusion on repeated and concurrent calls without recursive lock counts", async () => {
		const first = await owner();
		expect(await Promise.all([first.tryAcquireExclusive(), first.tryAcquireExclusive()])).toEqual([
			true,
			true,
		]);
		await expect(participant()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		await Promise.all([first.releaseExclusive(), first.releaseExclusive()]);
		const operation = await participant();
		await operation.assertHeld();
		expect(await first.tryAcquireExclusive()).toBe(false);
	});

	it("allows a fresh owner only after intentional close and rejects the old handle", async () => {
		let notifications = 0;
		const first = await owner(() => notifications++);
		expect(await first.tryAcquireExclusive()).toBe(true);
		await Promise.all([first.close(), first.close()]);
		expect(notifications).toBe(0);
		await expect(first.assertOwned()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		await expect(first.tryAcquireExclusive()).rejects.toBeInstanceOf(
			SqliteRestoreRuntimeOwnershipError,
		);
		const fresh = await owner();
		expect(await fresh.tryAcquireExclusive()).toBe(true);
	});

	it("closes participant idempotently and refuses further use", async () => {
		const first = await owner();
		const operation = await participant();
		await Promise.all([operation.close(), operation.close()]);
		await expect(operation.assertHeld()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		expect(await first.tryAcquireExclusive()).toBe(true);
	});

	it("fails closed on missing coordinator rather than creating a new lock namespace", async () => {
		rmSync(coordinator, { recursive: true });
		await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		await expect(participant()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		expect(existsSync(coordinator)).toBe(false);
	});

	it.each(["owner.sqlite3", "operations.sqlite3"])(
		"refuses a missing %s without recreation",
		async (file) => {
			unlinkSync(join(coordinator, file));
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
			await expect(participant()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
			expect(existsSync(join(coordinator, file))).toBe(false);
		},
	);

	it.each(["owner.sqlite3", "operations.sqlite3"])(
		"refuses a hard-linked coordination file %s",
		async (file) => {
			linkSync(join(coordinator, file), join(directory, "alias.sqlite3"));
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		},
	);

	it("refuses a symlinked coordination directory", async () => {
		const other = join(directory, "moved");
		renameSync(coordinator, other);
		symlinkSync(other, coordinator, "dir");
		await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
	});

	it.each(["owner.sqlite3", "operations.sqlite3"])(
		"refuses symlinked coordination file %s",
		async (file) => {
			const source = join(coordinator, file);
			const other = join(directory, "moved.sqlite3");
			renameSync(source, other);
			symlinkSync(other, source);
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		},
	);

	it.each(["directory", "owner.sqlite3", "operations.sqlite3"])(
		"refuses private coordination with unsafe %s access",
		async (target) => {
			chmodSync(target === "directory" ? coordinator : join(coordinator, target), 0o777);
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		},
	);

	it.each(["owner.sqlite3", "operations.sqlite3"])(
		"refuses unsupported protocol rows in %s",
		async (file) => {
			const db = new Database(join(coordinator, file));
			const table =
				file === "owner.sqlite3" ? "RestoreOwnerCoordination" : "RestoreOperationCoordination";
			db.exec(`UPDATE ${table} SET protocolVersion = 2`);
			db.close();
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		},
	);

	it("refuses extra singleton rows", async () => {
		const db = new Database(join(coordinator, "owner.sqlite3"));
		db.exec("INSERT INTO RestoreOwnerCoordination VALUES (2, 1)");
		db.close();
		await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
	});

	it.each(["owner.sqlite3", "operations.sqlite3"])(
		"refuses an unexpected WAL coordinator %s without changing it",
		async (file) => {
			const path = join(coordinator, file);
			const db = new Database(path);
			db.pragma("journal_mode = WAL");
			db.close();
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
			const verify = new Database(path);
			expect(verify.pragma("journal_mode", { simple: true })).toBe("wal");
			verify.close();
		},
	);

	it("permanently latches loss and contains a throwing callback exactly once", async () => {
		let notifications = 0;
		const first = await owner(() => {
			notifications++;
			throw new Error("private callback detail");
		});
		const path = join(coordinator, "owner.sqlite3");
		renameSync(path, join(coordinator, "old-owner.sqlite3"));
		await expect(first.assertOwned()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		renameSync(join(coordinator, "old-owner.sqlite3"), path);
		await expect(first.assertOwned()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		await expect(first.releaseExclusive()).rejects.toBeInstanceOf(
			SqliteRestoreRuntimeOwnershipError,
		);
		await first.close();
		expect(notifications).toBe(1);
	});

	it("refuses participant use after observed coordinator replacement", async () => {
		const operation = await participant();
		const path = join(coordinator, "operations.sqlite3");
		renameSync(path, join(coordinator, "old-operations.sqlite3"));
		await expect(operation.assertHeld()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
	});

	it("does not expose dependency paths or causes", async () => {
		unlinkSync(join(coordinator, "owner.sqlite3"));
		let captured: unknown;
		try {
			await owner();
		} catch (error) {
			captured = error;
		}
		expect(captured).toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		const error = captured as SqliteRestoreRuntimeOwnershipError;
		expect(error.statusCode).toBe(503);
		expect(error.cause).toBeUndefined();
		expect(`${error.message}${JSON.stringify(error)}`).not.toContain(directory);
	});

	it("does not permit takeover while the real owner process is physically suspended", async () => {
		const first = actor("owner");
		expect(await first.read()).toEqual({ kind: "ready" });
		const child = first.child as ChildProcess;
		child.kill("SIGSTOP");
		try {
			let stopped = false;
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				const state = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]?.[0];
				if (state === "T") {
					stopped = true;
					break;
				}
				await delay(10);
			}
			expect(stopped).toBe(true);
			await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		} finally {
			child.kill("SIGCONT");
		}
		expect(await first.command("assert")).toEqual({ kind: "assert", value: true });
		expect(await first.command("close")).toEqual({ kind: "closed" });
		await first.exit;
		await (await owner()).assertOwned();
	});

	it("retains surviving participation after owner death before a new owner can cut over", async () => {
		const first = actor("owner");
		expect(await first.read()).toEqual({ kind: "ready" });
		const retained = await participant();
		(first.child as ChildProcess).kill("SIGKILL");
		await first.exit;
		const fresh = await owner();
		expect(await fresh.tryAcquireExclusive()).toBe(false);
		await retained.assertHeld();
		await retained.close();
		expect(await fresh.tryAcquireExclusive()).toBe(true);
	});

	it("joins real Worker participation without Worker closure dropping main-owner locks", async () => {
		const first = await owner();
		const worker = actor("participant", true);
		expect(await worker.read()).toEqual({ kind: "ready" });
		expect(await first.tryAcquireExclusive()).toBe(false);
		expect(await worker.command("close")).toEqual({ kind: "closed" });
		await worker.exit;
		await first.assertOwned();
		const competingWorker = actor("owner", true);
		expect(await competingWorker.read()).toEqual({ kind: "unavailable" });
		await competingWorker.exit;
		const independent = actor("owner");
		expect(await independent.read()).toEqual({ kind: "unavailable" });
		await independent.exit;
		expect(await first.tryAcquireExclusive()).toBe(true);
	});

	it("keeps a Worker-owned lock after a losing main-thread competitor closes", async () => {
		const worker = actor("owner", true);
		expect(await worker.read()).toEqual({ kind: "ready" });
		await expect(owner()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		const independent = actor("owner");
		expect(await independent.read()).toEqual({ kind: "unavailable" });
		await independent.exit;
		expect(await worker.command("exclusive")).toEqual({ kind: "exclusive", value: true });
		expect(await worker.command("close")).toEqual({ kind: "closed" });
		await worker.exit;
		await (await owner()).assertOwned();
	});

	it("releases both real provider locks after a process dies while exclusive", async () => {
		const first = actor("owner");
		expect(await first.read()).toEqual({ kind: "ready" });
		expect(await first.command("exclusive")).toEqual({ kind: "exclusive", value: true });
		await expect(participant()).rejects.toBeInstanceOf(SqliteRestoreRuntimeOwnershipError);
		(first.child as ChildProcess).kill("SIGKILL");
		await first.exit;
		const fresh = await owner();
		expect(await fresh.tryAcquireExclusive()).toBe(true);
	});
});
