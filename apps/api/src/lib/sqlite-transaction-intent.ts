import { AsyncLocalStorage } from "node:async_hooks";

const writeIntent = new AsyncLocalStorage<true>();

/** Reserve known write transactions before guarded reads pin a WAL snapshot. */
export function withSqliteTransactionWriteIntent<T>(action: () => Promise<T>): Promise<T> {
	return writeIntent.run(true, action);
}

/** The guarded SQLite adapter consumes intent only when starting a transaction. */
export function hasSqliteTransactionWriteIntent(): boolean {
	return writeIntent.getStore() === true;
}
