import { setTimeout as delay } from "node:timers/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { SQLITE_TIMESTAMP_FORMAT } from "./sqlite-datetime.js";

type SqliteDriver = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;
type SqliteTransaction = Awaited<ReturnType<SqliteDriver["startTransaction"]>>;
type SqlQuery = Parameters<SqliteDriver["executeRaw"]>[0];

const ROLLBACK_QUERY: SqlQuery = { sql: "ROLLBACK", args: [], argTypes: [] };

/** Internal per-invocation admission; raw guard queries deliberately have no fence. */
export type SqliteStatementFence = Readonly<{
	revalidate(): Promise<void>;
	assert(): void;
	/** Recognizes only this transaction's opaque closed-lifetime rejection. */
	isClosedTransactionError?: (error: unknown) => boolean;
	/** Internal admission work may refuse earlier, never extend ordinary retries. */
	busyRetryMs?: number;
}>;
type StatementFences = WeakMap<SqlQuery, SqliteStatementFence>;
type TransactionLifetime = { current(): boolean; end(): void };

function retryStatements<T extends Pick<SqliteDriver, "queryRaw" | "executeRaw">>(
	driver: T,
	fences: StatementFences | undefined,
	assertAvailable: () => void,
): T {
	if (!fences) return driver;
	return new Proxy(driver, {
		get(target, property, receiver) {
			if (property === "queryRaw" || property === "executeRaw")
				return async (query: SqlQuery) => {
					const fence = fences.get(query);
					// No recursive waits for journal/identity evidence or cleanup SQL.
					if (!fence) return target[property](query);
					const busyRetryMs = fence.busyRetryMs ?? 5000;
					if (!Number.isSafeInteger(busyRetryMs) || busyRetryMs < 0 || busyRetryMs > 5000)
						throw new Error("Invalid internal SQLite busy retry budget");
					const deadline = performance.now() + busyRetryMs;
					let firstBusy: unknown;
					for (;;) {
						if (firstBusy) {
							const remaining = deadline - performance.now();
							if (remaining <= 0) throw firstBusy;
							await delay(Math.min(5, remaining));
							if (performance.now() >= deadline) throw firstBusy;
							assertAvailable();
							try {
								await fence.revalidate();
							} catch (error) {
								if (fence.isClosedTransactionError?.(error)) throw firstBusy;
								throw error;
							}
							if (performance.now() >= deadline) throw firstBusy;
						}
						assertAvailable();
						// The installed adapter enters its native call synchronously.
						// Nothing may await between this fence and the actual attempt.
						try {
							fence.assert();
						} catch (error) {
							if (firstBusy && fence.isClosedTransactionError?.(error)) throw firstBusy;
							throw error;
						}
						try {
							return await target[property](query);
						} catch (error) {
							if (
								!(error instanceof Error) ||
								error.name !== "DriverAdapterError" ||
								typeof error.cause !== "object" ||
								error.cause === null ||
								!("originalCode" in error.cause) ||
								error.cause.originalCode !== "SQLITE_BUSY"
							)
								throw error;
							firstBusy ??= error;
						}
					}
				};
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Keep the SQLite driver usable when Prisma's explicit COMMIT fails after a
 * write transaction has acquired a SQLite lock. Prisma calls executeRaw for
 * COMMIT and calls transaction.commit only after that succeeds, so the
 * adapter must unwind both the SQLite transaction and its mutex on failure.
 */
export function createRecoverableSqliteAdapter(
	config: ConstructorParameters<typeof PrismaBetterSqlite3>[0],
	options?: ConstructorParameters<typeof PrismaBetterSqlite3>[1],
	onUnavailable?: () => void,
	statementFences?: StatementFences,
): PrismaBetterSqlite3 {
	return new RecoverablePrismaBetterSqlite3(config, options, onUnavailable, statementFences);
}

class RecoverablePrismaBetterSqlite3 extends PrismaBetterSqlite3 {
	constructor(
		config: ConstructorParameters<typeof PrismaBetterSqlite3>[0],
		options?: ConstructorParameters<typeof PrismaBetterSqlite3>[1],
		private readonly onUnavailable?: () => void,
		private readonly statementFences?: StatementFences,
	) {
		super(config, {
			...options,
			timestampFormat: options?.timestampFormat ?? SQLITE_TIMESTAMP_FORMAT,
		});
	}

	public override async connect(): Promise<SqliteDriver> {
		return wrapDriver(await super.connect(), this.onUnavailable, this.statementFences);
	}

	public override async connectToShadowDb(): Promise<SqliteDriver> {
		return wrapDriver(await super.connectToShadowDb(), this.onUnavailable, this.statementFences);
	}
}

function wrapDriver(
	driver: SqliteDriver,
	onUnavailable?: () => void,
	fences?: StatementFences,
): SqliteDriver {
	let poisoned = false;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let unavailableSignaled = false;
	let currentTransaction: object | undefined;
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
			try {
				onUnavailable?.();
			} catch {
				/* Notification cannot unpoison the driver. */
			}
		}
		try {
			await dispose();
		} catch {
			// Preserve the original transaction error. A failed close cannot make
			// an unsafe driver usable again.
		}
	};

	const statements = retryStatements(driver, fences, assertAvailable);
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
						const identity = {};
						if (fences) currentTransaction = identity;
						return wrapTransaction(
							retryStatements(transaction, fences, assertAvailable),
							assertAvailable,
							poisonAndDispose,
							fences
								? {
										current: () => currentTransaction === identity,
										end: () => {
											if (currentTransaction === identity) currentTransaction = undefined;
										},
									}
								: undefined,
						);
					} catch (error) {
						// The upstream BEGIN path cannot confirm mutex release on failure.
						// Ordinary yielding clients refuse reuse rather than retaining a waiter.
						if (fences) await poisonAndDispose();
						throw error;
					} finally {
						pendingAcquisitionRejectors.delete(rejectAcquisition);
					}
				};
			}
			if (property === "queryRaw") {
				return async (query: Parameters<SqliteDriver["queryRaw"]>[0]) => {
					assertAvailable();
					return statements.queryRaw(query);
				};
			}
			if (property === "executeRaw") {
				return async (query: SqlQuery) => {
					assertAvailable();
					return statements.executeRaw(query);
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
	lifetime?: TransactionLifetime,
): SqliteTransaction {
	const recoverCommitFailure = async (commitError: unknown): Promise<never> => {
		// A concurrent timeout may already have rolled this transaction back and
		// released its mutex. Never clean up a later user's native transaction.
		if (lifetime && !lifetime.current()) throw commitError;
		lifetime?.end();
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
						if (/^\s*ROLLBACK\s*;?\s*$/i.test(query.sql)) lifetime?.end();
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
					lifetime?.end();
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
					lifetime?.end();
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
