import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool, type PoolClient } from "pg";
import {
	getRestoreRuntimeClientContext,
	getRestoreRuntimeReplacementClientContext,
	type RestoreReplacementScope,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
} from "./restore-runtime-admission.js";
import {
	assertPostgresRuntimeNamespace,
	parsePostgresRuntimeUrl,
	selectPostgresRuntimeNamespace,
} from "./restore-runtime-postgres-namespace.js";

type Driver = Awaited<ReturnType<PrismaPg["connect"]>>;
type Transaction = Awaited<ReturnType<Driver["startTransaction"]>>;
type Query = Parameters<Driver["queryRaw"]>[0];
type Context =
	| ReturnType<typeof getRestoreRuntimeClientContext>
	| ReturnType<typeof getRestoreRuntimeReplacementClientContext>;
type Loan = {
	assert(): void;
	cleanup?: object;
	failedCleanup?: Error;
	release(error?: Error | boolean): void;
};
type Session = {
	client: Client;
	raw: Client["query"];
	end: Promise<void>;
	loan?: Loan;
	transportFailed?: boolean;
};
type TransactionOpening = {
	isolationSql?: string;
	phase: "initial" | "begun" | "complete";
};
const transactionOpening = new AsyncLocalStorage<TransactionOpening>();
const transactionCleanup = new AsyncLocalStorage<object>();
const rollback: Query = { sql: "ROLLBACK", args: [], argTypes: [] };
const isRollback = (sql: string) => /^\s*ROLLBACK\s*;?\s*$/i.test(sql);
const isCommit = (sql: string) => /^\s*COMMIT\s*;?\s*$/i.test(sql);

async function assertSession(context: Context, session: Session, ticket: boolean, sql?: string) {
	if (session.transportFailed) throw new RestoreRuntimeAdmissionError();
	const replacement = "restoreId" in context ? context : undefined;
	if (ticket) {
		context.assertTicket();
		session.loan?.assert();
	}
	await context.assertCurrentPostgresRecord();
	try {
		if (!context.postgresNamespace) throw new RestoreRuntimeAdmissionError();
		await assertPostgresRuntimeNamespace({ query: session.raw }, context.postgresNamespace);
	} catch {
		context.unavailable();
		throw new RestoreRuntimeAdmissionError();
	}
	if (replacement) {
		const record =
			await session.raw(`SELECT id, "protocolVersion", phase, "runtimeEpoch", "ownerBackendPid",
			"activeRestoreId", "lastCommittedRestoreId", to_char("lastCommittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCommittedAt",
			"destinationInstallationId" FROM "RestoreRuntimeControl" LIMIT 2`);
		if (record.rows.length !== 1) {
			context.unavailable();
			throw new RestoreRuntimeAdmissionError();
		}
		replacement.validateStatementRecord(record.rows[0], sql);
	}
	const result = await session.raw(
		`SELECT
		EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=$1 AND classid=1095914052::oid AND objid=1::oid AND objsubid=2 AND granted AND mode='ExclusiveLock') AS owned,
		EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=1095914052::oid AND objid=2::oid AND objsubid=2 AND granted AND mode='${replacement ? "ExclusiveLock" : "ShareLock"}') AS participating`,
		[context.ownerBackendPid],
	);
	try {
		if (
			result.rows.length !== 1 ||
			result.rows[0]?.owned !== true ||
			result.rows[0]?.participating !== true
		)
			throw new RestoreRuntimeAdmissionError();
	} catch {
		context.unavailable();
		throw new RestoreRuntimeAdmissionError();
	}
	if (ticket) {
		context.assertTicket();
		session.loan?.assert();
	}
}

function guardedQuery(
	context: Context,
	session: Session,
	pending: Set<Promise<unknown>>,
	args: unknown[],
) {
	const callback =
		typeof args.at(-1) === "function" ? (args.at(-1) as (...values: unknown[]) => void) : undefined;
	const input = callback ? args.slice(0, -1) : args;
	const text =
		typeof input[0] === "string"
			? input[0]
			: input[0] && typeof input[0] === "object"
				? Reflect.get(input[0], "text")
				: undefined;
	const reenter = AsyncLocalStorage.snapshot();
	const loan = session.loan;
	const operation = (async () => {
		if (
			!loan ||
			typeof text !== "string" ||
			(input[0] !== null &&
				typeof input[0] === "object" &&
				typeof Reflect.get(input[0], "submit") === "function") ||
			input.length > 2 ||
			(input[1] !== undefined && !Array.isArray(input[1]))
		)
			throw new RestoreRuntimeAdmissionError();
		const cleanup =
			loan.cleanup !== undefined &&
			transactionCleanup.getStore() === loan.cleanup &&
			isRollback(text);
		const opening = transactionOpening.getStore();
		const nativeOpening = opening !== undefined && loan.cleanup === opening;
		const values =
			input[0] !== null && typeof input[0] === "object"
				? Reflect.get(input[0], "values")
				: undefined;
		const argumentFree =
			(input[1] === undefined || (Array.isArray(input[1]) && input[1].length === 0)) &&
			(values === undefined || (Array.isArray(values) && values.length === 0));
		const initializingIsolation =
			nativeOpening && argumentFree && opening.phase === "begun" && opening.isolationSql === text;
		if (!cleanup) {
			loan.assert();
			// PostgreSQL requires isolation selection before any transaction
			// query. Only this private adapter initialization step may defer the
			// session SELECTs; validate them immediately after SET, before return.
			if (initializingIsolation) await context.assertOwned();
			else await assertSession(context, session, true, text);
			loan.assert();
		}
		if (session.loan !== loan) throw new RestoreRuntimeAdmissionError();
		try {
			const result = await Reflect.apply(session.raw, session.client, input);
			if (nativeOpening) {
				if (argumentFree && text === "BEGIN" && opening.phase === "initial")
					opening.phase = "begun";
				else opening.phase = "complete";
			}
			if (initializingIsolation) await assertSession(context, session, true);
			return result;
		} catch (error) {
			if (cleanup) loan.failedCleanup = new RestoreRuntimeAdmissionError();
			throw error;
		}
	})();
	pending.add(operation);
	void operation.then(
		() => pending.delete(operation),
		() => pending.delete(operation),
	);
	if (!callback) return operation;
	void operation.then(
		(result) => {
			queueMicrotask(() => reenter(callback, undefined, result));
		},
		(error) => {
			queueMicrotask(() => reenter(callback, error));
		},
	);
}

function createGeneration(context: Context) {
	const replacement = "restoreId" in context;
	const configured = parsePostgresRuntimeUrl(context.databaseUrl, { actorBounds: false });
	const sessions = new Map<object, Session>();
	const pending = new Set<Promise<unknown>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	class NativeClient extends Client {
		constructor(config?: ConstructorParameters<typeof Client>[0]) {
			super(config);
			let resolve!: () => void;
			let reject!: (error: Error) => void;
			const end = new Promise<void>((done, failed) => {
				resolve = done;
				reject = failed;
			});
			// A failed end can precede the owner's close call. Retain the rejected
			// physical-close receipt without an unhandled rejection or early release.
			void end.catch(() => {});
			const session: Session = { client: this, raw: this.query.bind(this), end };
			sessions.set(this, session);
			this.once("end", () => {
				sessions.delete(this);
				resolve();
				if (replacement && !closing) context.unavailable();
			});
			// pg-pool removes its idle listener while a client is checked out.
			// Keep transport failure handled between SQL calls, fence this physical
			// session, and retire its loan without replaying accepted work.
			this.on("error", () => {
				session.transportFailed = true;
				if (session.loan) session.loan.failedCleanup = new RestoreRuntimeAdmissionError();
				if (replacement) context.unavailable();
			});
			const originalEnd = this.end.bind(this);
			const failedEnd = () => {
				context.unavailable();
				reject(new RestoreRuntimeAdmissionError());
			};
			this.end = ((callback?: (error?: Error) => void) => {
				try {
					if (callback)
						return originalEnd((error?: Error) => {
							if (error) failedEnd();
							callback(error ? new RestoreRuntimeAdmissionError() : undefined);
						});
					return originalEnd().catch(() => {
						failedEnd();
						throw new RestoreRuntimeAdmissionError();
					});
				} catch {
					failedEnd();
					throw new RestoreRuntimeAdmissionError();
				}
			}) as Client["end"];
		}
	}
	const pool = new Pool({
		connectionString: configured.connectionString,
		Client: NativeClient,
		connectionTimeoutMillis: 5000,
		...(replacement ? { max: 1 } : {}),
		onConnect: async (client) => {
			const session = sessions.get(client);
			if (!session || closing) throw new RestoreRuntimeAdmissionError();
			await context.assertOwned();
			try {
				if (!context.postgresNamespace) throw new RestoreRuntimeAdmissionError();
				await selectPostgresRuntimeNamespace(
					{ query: session.raw },
					configured.schema,
					context.postgresNamespace,
				);
			} catch {
				context.unavailable();
				throw new RestoreRuntimeAdmissionError();
			}
			const lock = await session.raw(
				`SELECT ${replacement ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared"}(1095914052,2) AS acquired`,
			);
			if (lock.rows[0]?.acquired !== true) throw new RestoreRuntimeAdmissionError();
			await assertSession(context, session, false);
			client.query = ((...args: unknown[]) =>
				guardedQuery(context, session, pending, args)) as Client["query"];
		},
	});
	// Idle transport failure is retired by pg-pool. A replacement must rejoin
	// the same owner/epoch; it does not itself authorize a replacement runtime.
	pool.on("error", () => {
		if (replacement) context.unavailable();
	});
	const originalConnect = pool.connect.bind(pool);
	const originalEnd = pool.end.bind(pool);
	const checkout = (
		callback?: (
			error: Error | undefined,
			client?: PoolClient,
			release?: (error?: Error | boolean) => void,
		) => void,
	) => {
		const reenter = AsyncLocalStorage.snapshot();
		const capability = transactionOpening.getStore();
		const operation = new Promise<PoolClient>((resolve, reject) => {
			let assert: () => void;
			try {
				if (closing) throw new RestoreRuntimeAdmissionError();
				assert = context.captureTicket();
			} catch (error) {
				reject(error);
				return;
			}
			originalConnect((error, client) =>
				reenter(async () => {
					if (error || !client) {
						reject(error ?? new RestoreRuntimeAdmissionError());
						return;
					}
					const session = sessions.get(client);
					const release = client.release.bind(client);
					if (!session) {
						release(new RestoreRuntimeAdmissionError());
						reject(new RestoreRuntimeAdmissionError());
						return;
					}
					const loan: Loan = { assert, cleanup: capability, release };
					session.loan = loan;
					client.release = (error) => {
						if (session.loan !== loan) throw new RestoreRuntimeAdmissionError();
						session.loan = undefined;
						release(error ?? loan.failedCleanup);
					};
					try {
						if (closing) throw new RestoreRuntimeAdmissionError();
						assert();
						await assertSession(context, session, true);
						assert();
						resolve(client);
					} catch (failure) {
						client.release(new RestoreRuntimeAdmissionError());
						reject(failure);
					}
				}),
			);
		});
		pending.add(operation);
		void operation.then(
			() => pending.delete(operation),
			() => pending.delete(operation),
		);
		if (!callback) return operation;
		void operation.then(
			(client) => {
				queueMicrotask(() => reenter(callback, undefined, client, client.release));
			},
			(error) => {
				queueMicrotask(() => reenter(callback, error));
			},
		);
	};
	pool.connect = checkout as Pool["connect"];
	const close = () => {
		if (!closePromise) {
			closing = true;
			closePromise = Promise.resolve()
				.then(async () => {
					await Promise.allSettled([...pending]);
					const physical = [...sessions.values()].map((session) => session.end);
					const ending = originalEnd();
					for (const session of sessions.values())
						if (session.loan)
							(session.client as unknown as PoolClient).release(new RestoreRuntimeAdmissionError());
					await ending;
					await Promise.all(physical);
				})
				.catch(() => {
					context.unavailable();
					throw new RestoreRuntimeAdmissionError();
				});
		}
		return closePromise;
	};
	// Keep both public forms; every end caller joins physical sessions, not just
	// pg-pool's early _clients removal. The native end function above avoids recursion.
	pool.end = ((callback?: (error?: Error) => void) => {
		const ending = close();
		if (!callback) return ending;
		void ending.then(
			() => callback(),
			() => callback(new RestoreRuntimeAdmissionError()),
		);
	}) as Pool["end"];
	return { pool, close };
}

/** Native ordinary factory; only a branded runtime can create its pools. */
export function createRuntimePostgresAdapter(runtime: RestoreRuntime): Readonly<{
	provider: "postgres";
	adapterName: string;
	connect(): Promise<Driver>;
	connectToShadowDb(): Promise<Driver>;
	close(): Promise<void>;
}> {
	const context = getRestoreRuntimeClientContext(runtime);
	return createGuardedPostgresAdapter(context);
}

/** Single-use actual publishing connection; ordinary reconnect policy never applies. */
export function createRuntimeReplacementPostgresAdapter(scope: RestoreReplacementScope) {
	const context = getRestoreRuntimeReplacementClientContext(scope);
	if (!/^postgres(ql)?:\/\//i.test(context.databaseUrl)) throw new RestoreRuntimeAdmissionError();
	context.claimWriter();
	return createGuardedPostgresAdapter(context);
}

function createGuardedPostgresAdapter(context: Context) {
	const replacement = "restoreId" in context;
	if (!/^postgres(ql)?:\/\//i.test(context.databaseUrl) || !context.postgresNamespace)
		throw new RestoreRuntimeAdmissionError();
	const namespace = context.postgresNamespace;
	const generations = new Set<ReturnType<typeof createGeneration>>();
	const pending = new Set<Promise<Driver>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let unregister!: () => void;
	let replacementConnected = false;
	const close = () => {
		if (!closePromise) {
			closing = true;
			closePromise = Promise.resolve()
				.then(async () => {
					await Promise.allSettled([...pending]);
					await Promise.all([...generations].map((generation) => generation.close()));
					unregister();
				})
				.catch(() => {
					context.unavailable();
					throw new RestoreRuntimeAdmissionError();
				});
		}
		return closePromise;
	};
	unregister = context.registerClose(close);
	const connect = () => {
		const opening = (async () => {
			if (closing) throw new RestoreRuntimeAdmissionError();
			if (replacement) {
				if (replacementConnected) throw new RestoreRuntimeAdmissionError();
				replacementConnected = true;
			}
			context.assertTicket();
			await context.assertOwned();
			context.assertTicket();
			if (closing) throw new RestoreRuntimeAdmissionError();
			const generation = createGeneration(context);
			generations.add(generation);
			const dispose = async () => {
				await generation.close();
				generations.delete(generation);
			};
			try {
				// Installed adapters bundle a different @types/pg version; this
				// cast bridges that duplication, never a runtime authority check.
				const source = new PrismaPg(
					generation.pool as unknown as ConstructorParameters<typeof PrismaPg>[0],
					// Prisma 7.9 wraps schemaName in SQL quotes without escaping its
					// interior quotes. Keep native identity raw; escape only that SQL
					// compiler boundary, covered by actual quoted-namespace CRUD.
					{ schema: namespace.name.replaceAll('"', '""') },
				);
				const actual = await source.connect();
				return new Proxy(actual, {
					get(target, property) {
						if (property === "dispose") return dispose;
						if (property === "executeScript")
							return async () => {
								throw new RestoreRuntimeAdmissionError();
							};
						if (property === "startTransaction")
							return async (isolation?: Parameters<Driver["startTransaction"]>[0]) => {
								const assert = context.captureTicket();
								const capability: TransactionOpening = {
									phase: "initial",
									isolationSql:
										isolation &&
										[
											"READ UNCOMMITTED",
											"READ COMMITTED",
											"REPEATABLE READ",
											"SERIALIZABLE",
										].includes(isolation)
											? `SET TRANSACTION ISOLATION LEVEL ${isolation}`
											: undefined,
								};
								const transaction = await transactionOpening.run(capability, () =>
									target.startTransaction(isolation),
								);
								return guardTransaction(transaction, assert, capability);
							};
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			} catch (error) {
				await dispose();
				throw error;
			}
		})();
		pending.add(opening);
		void opening.then(
			() => pending.delete(opening),
			() => pending.delete(opening),
		);
		return opening;
	};
	return Object.freeze({
		provider: "postgres",
		adapterName: "arr-runtime-postgres",
		connect,
		close,
		connectToShadowDb: async () => {
			throw new RestoreRuntimeAdmissionError();
		},
	});
}

function guardTransaction(
	transaction: Transaction,
	assert: () => void,
	capability: object,
): Transaction {
	let settled = false;
	let committed = false;
	const cleanup = async () => {
		if (settled) return;
		settled = true;
		try {
			await transactionCleanup.run(capability, () => transaction.executeRaw(rollback));
		} catch {
			/* The private cleanup loan marks this session for removal on release. */
		}
		await transaction.rollback();
	};
	return new Proxy(transaction, {
		get(target, property) {
			if (property === "rollback") return cleanup;
			if (property === "commit")
				return async () => {
					if (!committed || settled) throw new RestoreRuntimeAdmissionError();
					await target.commit();
					settled = true;
				};
			if (property === "executeRaw")
				return async (query: Query) => {
					if (isRollback(query.sql)) {
						await cleanup();
						return 0;
					}
					try {
						if (settled) throw new RestoreRuntimeAdmissionError();
						assert();
						const result = await target.executeRaw(query);
						if (isCommit(query.sql)) committed = true;
						return result;
					} catch (error) {
						if (isCommit(query.sql)) await cleanup();
						throw error;
					}
				};
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (settled) throw new RestoreRuntimeAdmissionError();
				assert();
				return Reflect.apply(value, target, args);
			};
		},
	});
}
