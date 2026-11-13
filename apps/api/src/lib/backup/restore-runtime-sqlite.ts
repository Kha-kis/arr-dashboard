import { lstatSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	resolveSqliteRestoreStorage,
	type SqliteRestoreStorage,
} from "./restore-runtime-sqlite-storage.js";

export class SqliteRestoreRuntimeOwnershipError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("SQLite Restore runtime ownership is unavailable");
		this.name = "SqliteRestoreRuntimeOwnershipError";
	}
}
export type SqliteRestoreRuntimeOwnership = Readonly<{
	assertOwned(): Promise<void>;
	tryAcquireExclusive(): Promise<boolean>;
	releaseExclusive(): Promise<void>;
	close(): Promise<void>;
}>;
export type SqliteRestoreOperationLock = Readonly<{
	assertHeld(): Promise<void>;
	close(): Promise<void>;
}>;
type CoordinationMetadata = { paths: string[]; stamps: { device: bigint; inode: bigint }[] };

function inspectCoordination(storage: SqliteRestoreStorage): CoordinationMetadata {
	storage.assertUnchanged();
	const uid = process.geteuid?.();
	if (uid === undefined) throw new SqliteRestoreRuntimeOwnershipError();
	const device = lstatSync(storage.directoryPath, { bigint: true }).dev;
	const paths = [
		storage.coordinationDirectoryPath,
		join(storage.coordinationDirectoryPath, "owner.sqlite3"),
		join(storage.coordinationDirectoryPath, "operations.sqlite3"),
	];
	const stamps = paths.map((path, index) => {
		const stat = lstatSync(path, { bigint: true });
		if (
			(index === 0 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
			stat.dev !== device ||
			stat.uid !== BigInt(uid) ||
			(stat.mode & 0o077n) !== 0n
		) {
			throw new SqliteRestoreRuntimeOwnershipError();
		}
		return { device: stat.dev, inode: stat.ino };
	});
	return { paths, stamps };
}

function assertCoordination(storage: SqliteRestoreStorage, expected: CoordinationMetadata): void {
	const current = inspectCoordination(storage);
	if (
		current.stamps.some(
			(stat, index) =>
				stat.device !== expected.stamps[index]!.device ||
				stat.inode !== expected.stamps[index]!.inode,
		)
	) {
		throw new SqliteRestoreRuntimeOwnershipError();
	}
}

function assertProtocol(
	db: Database.Database,
	table: "RestoreOwnerCoordination" | "RestoreOperationCoordination",
): void {
	if (!db.open || db.pragma("journal_mode", { simple: true }) !== "delete") {
		throw new SqliteRestoreRuntimeOwnershipError();
	}
	const rows = db.prepare(`SELECT id, protocolVersion FROM ${table} LIMIT 2`).all() as {
		id: unknown;
		protocolVersion: unknown;
	}[];
	if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.protocolVersion !== 1) {
		throw new SqliteRestoreRuntimeOwnershipError();
	}
}

function closeDatabase(db: Database.Database | undefined): boolean {
	try {
		if (db?.open) db.close();
		return true;
	} catch {
		return false;
	}
}

/** Provider exclusion only. Provisioning and application admission are separate gates. */
export async function acquireSqliteRestoreRuntimeOwnership(
	databaseUrl: string,
	onUnavailable?: () => void,
): Promise<SqliteRestoreRuntimeOwnership> {
	let owner: Database.Database | undefined;
	let operations: Database.Database | undefined;
	try {
		const storage = resolveSqliteRestoreStorage(databaseUrl);
		const metadata = inspectCoordination(storage);
		owner = new Database(metadata.paths[1]!, { timeout: 0, fileMustExist: true });
		assertProtocol(owner, "RestoreOwnerCoordination");
		owner.exec("BEGIN IMMEDIATE");
		operations = new Database(metadata.paths[2]!, { timeout: 0, fileMustExist: true });
		assertProtocol(operations, "RestoreOperationCoordination");
		assertCoordination(storage, metadata);
		const ownerDb = owner;
		const operationsDb = operations;
		let available = true;
		let exclusive = false;
		let closePromise: Promise<void> | undefined;
		let notified = false;
		const closeHandles = () => {
			const operationsClosed = closeDatabase(operationsDb);
			const ownerClosed = closeDatabase(ownerDb);
			return operationsClosed && ownerClosed;
		};
		const lose = () => {
			available = false;
			// Fencing cannot release publication exclusion before its native actors close.
			if (!exclusive) closeHandles();
			if (!notified) {
				notified = true;
				try {
					onUnavailable?.();
				} catch {
					// Subscriber failure cannot revive or leak provider authority.
				}
			}
		};
		const run = <T>(operation: () => T): T => {
			try {
				if (!available) throw new SqliteRestoreRuntimeOwnershipError();
				assertCoordination(storage, metadata);
				if (!ownerDb.inTransaction || operationsDb.inTransaction !== exclusive) {
					throw new SqliteRestoreRuntimeOwnershipError();
				}
				assertProtocol(ownerDb, "RestoreOwnerCoordination");
				assertProtocol(operationsDb, "RestoreOperationCoordination");
				const result = operation();
				assertCoordination(storage, metadata);
				return result;
			} catch {
				if (available) lose();
				throw new SqliteRestoreRuntimeOwnershipError();
			}
		};
		return Object.freeze({
			async assertOwned(): Promise<void> {
				run(() => undefined);
			},
			async tryAcquireExclusive(): Promise<boolean> {
				return run(() => {
					if (exclusive) return true;
					try {
						operationsDb.exec("BEGIN EXCLUSIVE");
						exclusive = true;
						return true;
					} catch (error) {
						if (
							error instanceof Database.SqliteError &&
							error.code === "SQLITE_BUSY" &&
							!operationsDb.inTransaction
						) {
							return false;
						}
						throw error;
					}
				});
			},
			async releaseExclusive(): Promise<void> {
				run(() => {
					if (exclusive) {
						operationsDb.exec("ROLLBACK");
						exclusive = false;
					}
				});
			},
			close(): Promise<void> {
				if (!closePromise) {
					available = false;
					closePromise = closeHandles()
						? Promise.resolve()
						: Promise.reject(new SqliteRestoreRuntimeOwnershipError());
				}
				return closePromise;
			},
		});
	} catch {
		closeDatabase(operations);
		closeDatabase(owner);
		throw new SqliteRestoreRuntimeOwnershipError();
	}
}

/** A retained SHARED lock blocks cutover; it does not authorize application work. */
export async function acquireSqliteRestoreOperationLock(
	databaseUrl: string,
): Promise<SqliteRestoreOperationLock> {
	let db: Database.Database | undefined;
	try {
		const storage = resolveSqliteRestoreStorage(databaseUrl);
		const metadata = inspectCoordination(storage);
		db = new Database(metadata.paths[2]!, { timeout: 0, fileMustExist: true });
		assertProtocol(db, "RestoreOperationCoordination");
		db.exec("BEGIN");
		assertProtocol(db, "RestoreOperationCoordination");
		assertCoordination(storage, metadata);
		const operationsDb = db;
		let available = true;
		let closePromise: Promise<void> | undefined;
		return Object.freeze({
			async assertHeld(): Promise<void> {
				try {
					if (!available || !operationsDb.inTransaction) {
						throw new SqliteRestoreRuntimeOwnershipError();
					}
					assertCoordination(storage, metadata);
					assertProtocol(operationsDb, "RestoreOperationCoordination");
				} catch {
					available = false;
					closeDatabase(operationsDb);
					throw new SqliteRestoreRuntimeOwnershipError();
				}
			},
			close(): Promise<void> {
				if (!closePromise) {
					available = false;
					closePromise = closeDatabase(operationsDb)
						? Promise.resolve()
						: Promise.reject(new SqliteRestoreRuntimeOwnershipError());
				}
				return closePromise;
			},
		});
	} catch {
		closeDatabase(db);
		throw new SqliteRestoreRuntimeOwnershipError();
	}
}
