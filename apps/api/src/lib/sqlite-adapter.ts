import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

type SqliteDriver = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;
type SqliteTransaction = Awaited<ReturnType<SqliteDriver["startTransaction"]>>;
type SqlQuery = Parameters<SqliteDriver["executeRaw"]>[0];

const ROLLBACK_QUERY: SqlQuery = { sql: "ROLLBACK", args: [], argTypes: [] };

/**
 * Keep the SQLite driver usable when Prisma's explicit COMMIT fails after a
 * write transaction has acquired a SQLite lock. Prisma calls executeRaw for
 * COMMIT and calls transaction.commit only after that succeeds, so the
 * adapter must unwind both the SQLite transaction and its mutex on failure.
 */
export function createRecoverableSqliteAdapter(
	config: ConstructorParameters<typeof PrismaBetterSqlite3>[0],
	options?: ConstructorParameters<typeof PrismaBetterSqlite3>[1],
): PrismaBetterSqlite3 {
	return new RecoverablePrismaBetterSqlite3(config, options);
}

class RecoverablePrismaBetterSqlite3 extends PrismaBetterSqlite3 {
	public override async connect(): Promise<SqliteDriver> {
		return wrapDriver(await super.connect());
	}

	public override async connectToShadowDb(): Promise<SqliteDriver> {
		return wrapDriver(await super.connectToShadowDb());
	}
}

function wrapDriver(driver: SqliteDriver): SqliteDriver {
	let poisoned = false;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let unavailableSignaled = false;
	const pendingAcquisitionRejectors = new Set<(error: Error) => void>();
	const unavailableError = new Error("SQLite driver is unavailable");

	const signalUnavailable = (): void => {
		if (unavailableSignaled) return;
		unavailableSignaled = true;
		for (const reject of pendingAcquisitionRejectors) reject(unavailableError);
		pendingAcquisitionRejectors.clear();
	};

	const assertAvailable = (): void => {
		if (poisoned || disposed) {
			throw unavailableError;
		}
	};

	const dispose = (): Promise<void> => {
		if (!disposePromise) {
			disposed = true;
			signalUnavailable();
			disposePromise = Promise.resolve().then(() => driver.dispose());
		}
		return disposePromise;
	};

	const poisonAndDispose = async (): Promise<void> => {
		if (!poisoned) {
			poisoned = true;
			signalUnavailable();
		}
		try {
			await dispose();
		} catch {
			// Preserve the original transaction error. A failed close cannot make
			// an unsafe driver usable again.
		}
	};

	return new Proxy(driver, {
		get(target, property, receiver) {
			if (property === "dispose") {
				return dispose;
			}
			if (property === "startTransaction") {
				return async (isolationLevel?: Parameters<SqliteDriver["startTransaction"]>[0]) => {
					assertAvailable();
					let rejectAcquisition!: (error: Error) => void;
					const unavailable = new Promise<never>((_, reject) => {
						rejectAcquisition = reject;
						pendingAcquisitionRejectors.add(reject);
					});
					try {
						const transaction = await Promise.race([
							target.startTransaction(isolationLevel),
							unavailable,
						]);
						assertAvailable();
						return wrapTransaction(transaction, assertAvailable, poisonAndDispose);
					} finally {
						pendingAcquisitionRejectors.delete(rejectAcquisition);
					}
				};
			}
			if (property === "queryRaw") {
				return async (query: Parameters<SqliteDriver["queryRaw"]>[0]) => {
					assertAvailable();
					return target.queryRaw(query);
				};
			}
			if (property === "executeRaw") {
				return async (query: SqlQuery) => {
					assertAvailable();
					return target.executeRaw(query);
				};
			}
			if (property === "executeScript") {
				return async (script: string) => {
					assertAvailable();
					return target.executeScript(script);
				};
			}

			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") {
				return value;
			}
			return (...args: unknown[]) => {
				assertAvailable();
				return value.apply(target, args);
			};
		},
	});
}

function wrapTransaction(
	transaction: SqliteTransaction,
	assertAvailable: () => void,
	poisonAndDispose: () => Promise<void>,
): SqliteTransaction {
	const recoverCommitFailure = async (commitError: unknown): Promise<never> => {
		try {
			await transaction.executeRaw(ROLLBACK_QUERY);
		} catch {
			await poisonAndDispose();
			throw commitError;
		}

		try {
			await transaction.rollback();
		} catch {
			await poisonAndDispose();
			throw commitError;
		}

		throw commitError;
	};

	return new Proxy(transaction, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property === "executeRaw") {
				return async (query: SqlQuery) => {
					assertAvailable();
					if (query.sql.trim().toUpperCase() !== "COMMIT") {
						return target.executeRaw(query);
					}
					try {
						return await target.executeRaw(query);
					} catch (commitError) {
						return recoverCommitFailure(commitError);
					}
				};
			}
			if (property === "commit") {
				return async () => {
					assertAvailable();
					try {
						return await target.commit();
					} catch (commitCleanupError) {
						await poisonAndDispose();
						throw commitCleanupError;
					}
				};
			}
			if (property === "rollback") {
				return async () => {
					assertAvailable();
					try {
						return await target.rollback();
					} catch (rollbackError) {
						await poisonAndDispose();
						throw rollbackError;
					}
				};
			}
			if (
				property === "queryRaw" ||
				property === "createSavepoint" ||
				property === "rollbackToSavepoint" ||
				property === "releaseSavepoint"
			) {
				return async (...args: unknown[]) => {
					assertAvailable();
					return value.apply(target, args);
				};
			}
			if (typeof value !== "function") {
				return value;
			}
			return (...args: unknown[]) => {
				assertAvailable();
				return value.apply(target, args);
			};
		},
	});
}
