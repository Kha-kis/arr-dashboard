import { setTimeout as delay, setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { type Prisma, PrismaClient, type PrismaClientInstance } from "../prisma.js";
import { createRecoverableSqliteAdapter, type SqliteStatementFence } from "../sqlite-adapter.js";
import { hasSqliteTransactionWriteIntent } from "../sqlite-transaction-intent.js";
import {
	getRestoreRuntimeClientContext,
	getRestoreRuntimeReplacementClientContext,
	type RestoreReplacementScope,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
} from "./restore-runtime-admission.js";
import {
	createRuntimePostgresAdapter,
	createRuntimeReplacementPostgresAdapter,
} from "./restore-runtime-postgres-client.js";
import { acquireSqliteRestoreOperationLock } from "./restore-runtime-sqlite.js";
import { parseSqliteRestoreRuntimeRecord } from "./restore-runtime-sqlite-enrollment.js";

type Driver = Awaited<ReturnType<ReturnType<typeof createRecoverableSqliteAdapter>["connect"]>>;
type Transaction = Awaited<ReturnType<Driver["startTransaction"]>>;
type Query = Parameters<Driver["executeRaw"]>[0];
const ROLLBACK: Query = { sql: "ROLLBACK", args: [], argTypes: [] };
const SQLITE_WRITE_INTENT: Query = {
	sql: 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0',
	args: [],
	argTypes: [],
};
const JOURNAL_COLUMNS = [
	"id",
	"protocolVersion",
	"phase",
	"runtimeEpoch",
	"ownerBackendPid",
	"activeRestoreId",
	"lastCommittedRestoreId",
	"lastCommittedAt",
	"destinationInstallationId",
];
const BINDING_COLUMNS = [
	"id",
	"protocolVersion",
	"databaseDevice",
	"databaseInode",
	"directoryDevice",
	"directoryInode",
	"coordinationDevice",
	"coordinationInode",
	"ownerDevice",
	"ownerInode",
	"operationsDevice",
	"operationsInode",
];
const rollbackSql = (sql: string) => /^\s*ROLLBACK\s*;?\s*$/i.test(sql);
const commitSql = (sql: string) => /^\s*COMMIT\s*;?\s*$/i.test(sql);

type RuntimePrismaClient = Readonly<{
	prisma: PrismaClientInstance;
	close(): Promise<void>;
}>;
type RuntimeTransactionOptions = {
	maxWait?: number;
	timeout?: number;
	isolationLevel?: Prisma.TransactionIsolationLevel;
};
type SqliteClientRegistration = {
	closed: boolean;
	publication(): RuntimePrismaClient;
	readClient<T>(
		operation: (client: PrismaClientInstance) => Promise<T>,
		maxWait?: number,
	): Promise<T>;
};
const ordinarySqliteClients = new WeakMap<object, SqliteClientRegistration>();

/** Keep atomic cache publication off the ordinary HTTP connection. */
export async function withIsolatedRuntimePrismaTransaction<T>(
	prisma: Pick<PrismaClientInstance, "$transaction">,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
	options?: {
		maxWait?: number;
		timeout?: number;
		isolationLevel?: Prisma.TransactionIsolationLevel;
	},
): Promise<T> {
	const registration = ordinarySqliteClients.get(prisma);
	if (!registration) return prisma.$transaction(operation, options);
	if (registration.closed) throw new RestoreRuntimeAdmissionError();
	// The companion was registered before admission could close. An already
	// accepted collection may reach this publication while the runtime drains.
	return registration.publication().prisma.$transaction(operation, options);
}

/** Consistent reads must not borrow the HTTP or publication connection. */
export async function withIsolatedRuntimePrismaReadTransaction<T>(
	prisma: Pick<PrismaClientInstance, "$transaction">,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
	options?: RuntimeTransactionOptions,
): Promise<T> {
	const registration = ordinarySqliteClients.get(prisma);
	if (!registration) return prisma.$transaction(operation, options);
	if (registration.closed) throw new RestoreRuntimeAdmissionError();
	return registration.readClient(
		(client) => client.$transaction(operation, options),
		options?.maxWait,
	);
}

/**
 * Explicit cache-display reads use an exclusive guarded lane without adding a
 * snapshot. Repository transactions and outside-snapshot postchecks retain
 * their original semantics. Never use this callback for writes or provider I/O.
 */
export async function withIsolatedRuntimePrismaReadClient<T>(
	prisma: PrismaClientInstance,
	operation: (client: PrismaClientInstance) => Promise<T>,
): Promise<T> {
	const registration = ordinarySqliteClients.get(prisma);
	if (!registration) return operation(prisma);
	if (registration.closed) throw new RestoreRuntimeAdmissionError();
	return registration.readClient(operation);
}

function projection(result: Awaited<ReturnType<Driver["queryRaw"]>>, columns: string[]) {
	if (result.rows.length !== 1 || result.rows[0]?.length !== columns.length)
		throw new RestoreRuntimeAdmissionError();
	return Object.fromEntries(columns.map((column, i) => [column, result.rows[0]![i]]));
}

export function createRuntimePrismaClient(
	runtime: RestoreRuntime,
	options?: Readonly<{ sqliteTransactionIntent?: "write" }>,
): RuntimePrismaClient {
	const context = getRestoreRuntimeClientContext(runtime);
	const native = createGuardedPrismaClient(
		context,
		runtime,
		undefined,
		undefined,
		options?.sqliteTransactionIntent,
	);
	if (!context.databaseUrl.startsWith("file:")) return native;
	// Reserve its close lifetime before admission can close, not a second Prisma
	// object for every reader-only client. Accepted work can first publish during
	// drain because materialization uses this existing slot, never a new claim.
	let publication: RuntimePrismaClient | undefined;
	let publicationClosePromise: Promise<void> | undefined;
	// Cached-read fan-out is bounded independently from ordinary HTTP queries.
	// Reserve closure now; accepted work may first acquire a lane during drain.
	type ReadLane = { busy: boolean; client?: RuntimePrismaClient };
	type ReadWaiter = {
		resolve(lane: ReadLane): void;
		reject(error: RestoreRuntimeAdmissionError): void;
	};
	const readLanes: ReadLane[] = Array.from({ length: 4 }, () => ({ busy: false }));
	const readWaiters = new Set<ReadWaiter>();
	let readsClosePromise: Promise<void> | undefined;
	const acquireReadLane = (maxWait: number): Promise<ReadLane> => {
		if (registration.closed) return Promise.reject(new RestoreRuntimeAdmissionError());
		const lane = readLanes.find((candidate) => !candidate.busy);
		if (lane) {
			lane.busy = true;
			return Promise.resolve(lane);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				readWaiters.delete(waiter);
				reject(new RestoreRuntimeAdmissionError());
			}, maxWait);
			const waiter: ReadWaiter = {
				resolve: (next) => {
					clearTimeout(timer);
					resolve(next);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			readWaiters.add(waiter);
		});
	};
	const releaseReadLane = (lane: ReadLane) => {
		const next = readWaiters.values().next().value;
		if (next && !registration.closed) {
			readWaiters.delete(next);
			next.resolve(lane);
		} else lane.busy = false;
	};
	const registration: SqliteClientRegistration = {
		closed: false,
		publication: () => {
			if (registration.closed) throw new RestoreRuntimeAdmissionError();
			// Only close registration is already accounted for by the reserved slot;
			// the actual context's ticket, owner and native fences are unchanged.
			publication ??= createGuardedPrismaClient(
				{ ...context, registerClose: () => () => undefined },
				runtime,
				undefined,
				undefined,
				options?.sqliteTransactionIntent,
			);
			return publication;
		},
		readClient: async (operation, maxWait) => {
			const lane = await acquireReadLane(maxWait ?? 2_000);
			try {
				if (registration.closed) throw new RestoreRuntimeAdmissionError();
				lane.client ??= createGuardedPrismaClient(
					{ ...context, registerClose: () => () => undefined },
					runtime,
				);
				return await operation(lane.client.prisma);
			} finally {
				releaseReadLane(lane);
			}
		},
	};
	const closeReads = () => {
		registration.closed = true;
		for (const waiter of readWaiters) waiter.reject(new RestoreRuntimeAdmissionError());
		readWaiters.clear();
		readsClosePromise ??= Promise.resolve().then(async () => {
			const results = await Promise.allSettled(readLanes.map((lane) => lane.client?.close()));
			if (results.some((result) => result.status === "rejected"))
				throw new RestoreRuntimeAdmissionError();
			for (const lane of readLanes) lane.client = undefined;
			unregisterReads();
		});
		return readsClosePromise;
	};
	const unregisterReads = context.registerClose(closeReads);
	const closePublication = () => {
		registration.closed = true;
		publicationClosePromise ??= Promise.resolve().then(async () => {
			await publication?.close();
			// Failed physical close retains both this reference and its close slot.
			publication = undefined;
			unregisterPublication();
		});
		return publicationClosePromise;
	};
	const unregisterPublication = context.registerClose(closePublication);
	ordinarySqliteClients.set(native.prisma, registration);
	let closePromise: Promise<void> | undefined;
	return Object.freeze({
		prisma: native.prisma,
		close: () => {
			registration.closed = true;
			closePromise ??= Promise.resolve().then(async () => {
				const closed = await Promise.allSettled([native.close(), closePublication(), closeReads()]);
				if (closed.some((result) => result.status === "rejected"))
					throw new RestoreRuntimeAdmissionError();
			});
			return closePromise;
		},
	});
}

/** Best-effort session access metadata must never synchronously wait on a writer. */
export function createRuntimeSessionMetadataPrismaClient(runtime: RestoreRuntime) {
	const context = getRestoreRuntimeClientContext(runtime);
	if (!context.databaseUrl.startsWith("file:")) throw new RestoreRuntimeAdmissionError();
	return createGuardedPrismaClient(context, runtime, undefined, 0);
}

/** Internal purpose-bound publisher; it never acquires an ordinary SHARED participant. */
export function createRuntimeReplacementPrismaClient(scope: RestoreReplacementScope) {
	const context = getRestoreRuntimeReplacementClientContext(scope);
	if (context.databaseUrl.startsWith("file:")) context.claimWriter();
	return createGuardedPrismaClient(context, undefined, scope);
}

function createGuardedPrismaClient(
	context:
		| ReturnType<typeof getRestoreRuntimeClientContext>
		| ReturnType<typeof getRestoreRuntimeReplacementClientContext>,
	runtime?: RestoreRuntime,
	scope?: RestoreReplacementScope,
	sqliteTimeout?: number,
	sqliteTransactionIntent?: "write",
): Readonly<{ prisma: PrismaClientInstance; close(): Promise<void> }> {
	const replacement = "restoreId" in context ? context : undefined;
	if (/^postgres(ql)?:\/\//i.test(context.databaseUrl)) {
		if (replacement ? !scope : !runtime) throw new RestoreRuntimeAdmissionError();
		const adapter = replacement
			? createRuntimeReplacementPostgresAdapter(scope!)
			: createRuntimePostgresAdapter(runtime!);
		let prisma!: PrismaClientInstance;
		let closePromise: Promise<void> | undefined;
		let unregister!: () => void;
		const close = () =>
			(closePromise ??= Promise.resolve()
				.then(async () => {
					await prisma.$disconnect();
					await adapter.close();
					unregister();
				})
				.catch(() => {
					context.unavailable("client-close-failed");
					throw new RestoreRuntimeAdmissionError();
				}));
		unregister = context.registerClose(close);
		try {
			prisma = new PrismaClient({ adapter });
		} catch {
			unregister();
			void adapter.close().catch(() => context.unavailable("client-close-failed"));
			throw new RestoreRuntimeAdmissionError();
		}
		return Object.freeze({ prisma, close });
	}
	const yielding = !replacement && sqliteTimeout === undefined;
	const statementFences = yielding ? new WeakMap<Query, SqliteStatementFence>() : undefined;
	const source = createRecoverableSqliteAdapter(
		{
			url: context.databaseUrl.slice(5),
			fileMustExist: true,
			...(yielding
				? { timeout: 0 }
				: sqliteTimeout === undefined
					? {}
					: { timeout: sqliteTimeout }),
		},
		undefined,
		() => context.unavailable("transaction-cleanup-failed"),
		statementFences,
	);
	const connections = new Set<() => Promise<void>>();
	const pending = new Set<Promise<Driver>>();
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let prisma!: PrismaClientInstance;
	let unregister!: () => void;
	let replacementConnected = false;
	const verifyPhysicalClose = yielding || Boolean(replacement) || sqliteTimeout === 0;
	const close = () =>
		(closePromise ??= Promise.resolve()
			.then(async () => {
				closing = true;
				await Promise.allSettled([...pending]);
				await prisma.$disconnect();
				await Promise.all([...connections].map((dispose) => dispose()));
				unregister();
			})
			.catch(() => {
				context.unavailable("client-close-failed");
				throw new RestoreRuntimeAdmissionError();
			}));
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
			const participation = replacement
				? undefined
				: await acquireSqliteRestoreOperationLock(context.databaseUrl);
			let driver: Driver | undefined;
			let native: Database.Database | undefined;
			let connectionAttempted = false;
			let transactionGeneration = 0;
			let disposePromise: Promise<void> | undefined;
			const dispose = () =>
				(disposePromise ??= Promise.resolve().then(async () => {
					// Database closure first; a failed close never drops its SHARED lock.
					await driver?.dispose();
					// The supported native adapter owns this exact handle. A resolving
					// dispose promise is not proof if it is still physically open.
					if (verifyPhysicalClose && connectionAttempted && (!native || native.open))
						throw new RestoreRuntimeAdmissionError();
					await participation?.close();
					connections.delete(dispose);
				}));
			connections.add(dispose);
			try {
				connectionAttempted = true;
				driver = await source.connect();
				if (verifyPhysicalClose) {
					const actualNative: unknown = Reflect.get(driver, "client");
					if (
						!(actualNative instanceof Database) ||
						!actualNative.open ||
						actualNative.name !== context.databaseUrl.slice(5)
					)
						throw new RestoreRuntimeAdmissionError();
					native = actualNative;
				}
				const actual = driver;
				let bindingRecord: Record<string, unknown> | undefined;
				const assertNative = (inTransaction: boolean, generation: number) => {
					if (!yielding) return;
					if (
						closing ||
						disposePromise ||
						!native?.open ||
						Reflect.get(actual, "client") !== native ||
						native.name !== context.databaseUrl.slice(5) ||
						native.inTransaction !== inTransaction ||
						transactionGeneration !== generation
					)
						throw new RestoreRuntimeAdmissionError();
					if (!bindingRecord) throw new RestoreRuntimeAdmissionError();
					context.validateSqliteBinding(bindingRecord);
				};
				const ownershipGuard = async (loan?: () => void) => {
					// Service pending I/O before proving authority, never after the final native fence.
					if (yielding) await setImmediate();
					context.assertTicket();
					loan?.();
					await context.assertOwned();
					// A normal disconnect can dispose this client while ownership proof
					// yields. Reject late work without mistaking local closure for actor loss.
					if (closing || disposePromise) throw new RestoreRuntimeAdmissionError();
					try {
						await participation?.assertHeld();
					} catch {
						context.unavailable("native-participation-unavailable");
						throw new RestoreRuntimeAdmissionError();
					}
					context.assertTicket();
					loan?.();
				};
				const guard = async (loan?: () => void, sql?: string) => {
					await ownershipGuard(loan);
					const journal = await actual.queryRaw({
						sql: `SELECT ${JOURNAL_COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`,
						args: [],
						argTypes: [],
					});
					try {
						const record = parseSqliteRestoreRuntimeRecord(projection(journal, JOURNAL_COLUMNS));
						if (replacement) replacement.validateStatementRecord(record, sql);
						else context.validateRecord(record);
					} catch {
						context.unavailable("client-invalid-journal");
						throw new RestoreRuntimeAdmissionError();
					}
					const binding = await actual.queryRaw({
						sql: `SELECT ${BINDING_COLUMNS.join(", ")} FROM SqliteRestoreStorageBinding LIMIT 2`,
						args: [],
						argTypes: [],
					});
					try {
						const record = projection(binding, BINDING_COLUMNS);
						context.validateSqliteBinding(record);
						bindingRecord = record;
					} catch {
						context.unavailable("storage-binding-invalid");
						throw new RestoreRuntimeAdmissionError();
					}
					context.assertTicket();
					loan?.();
				};
				const statement = async <T>(
					query: Query,
					invoke: (copied: Query) => Promise<T>,
					revalidate: () => Promise<void>,
					assert: () => void,
					inTransaction: boolean,
					generation: number,
					isClosedTransactionError?: (error: unknown) => boolean,
					busyRetryMs?: number,
				): Promise<T> => {
					if (!statementFences) {
						assert();
						return invoke(query);
					}
					const copied = { ...query, args: [...query.args], argTypes: [...query.argTypes] };
					const assertAttempt = () => {
						assert();
						assertNative(inTransaction, generation);
					};
					statementFences.set(copied, {
						revalidate: async () => {
							assertAttempt();
							await revalidate();
						},
						assert: assertAttempt,
						isClosedTransactionError,
						busyRetryMs,
					});
					try {
						assertAttempt();
						return await invoke(copied);
					} finally {
						statementFences.delete(copied);
					}
				};
				await guard();
				return new Proxy(actual, {
					get(target, property) {
						if (property === "dispose") return dispose;
						if (property === "startTransaction")
							return async (isolation?: Parameters<Driver["startTransaction"]>[0]) => {
								const writeIntent =
									sqliteTransactionIntent === "write" ||
									(!replacement && hasSqliteTransactionWriteIntent());
								const loan = context.captureTicket();
								await guard(loan);
								context.assertTicket();
								loan();
								const transaction = await target.startTransaction(isolation);
								const generation = ++transactionGeneration;
								const assertTransaction = () => {
									context.assertTicket();
									loan();
									assertNative(true, generation);
								};
								const admitted = guardTransaction(
									transaction,
									(sql) => guard(loan, sql),
									async () => {
										context.unavailable("transaction-cleanup-failed");
										await dispose();
									},
									assertTransaction,
									(query, invoke, revalidate, assert, isClosedTransactionError) =>
										statement(
											query,
											invoke,
											revalidate,
											assert,
											true,
											generation,
											isClosedTransactionError,
										),
								);
								try {
									if (writeIntent) {
										// Reserve the WAL writer before guard reads pin a snapshot.
										// No row matches: coordinator state and row triggers stay untouched.
										context.assertTicket();
										loan();
										await statement(
											SQLITE_WRITE_INTENT,
											(query) => transaction.executeRaw(query),
											async () => {
												// Recheck live owner/participation/stamps without pinning a
												// main-file snapshot before the no-row writer reservation.
												await ownershipGuard(loan);
												if (!bindingRecord) throw new RestoreRuntimeAdmissionError();
												context.validateSqliteBinding(bindingRecord);
											},
											assertTransaction,
											true,
											generation,
											undefined,
											// Settle before Prisma's default 2s start-admission deadline.
											1000,
										);
									}
									await guard(loan);
								} catch (error) {
									try {
										await admitted.rollback();
									} catch (cleanupError) {
										if (!writeIntent) throw cleanupError;
										// Rollback already fails closed and disposes on uncertain cleanup.
										// Preserve the opt-in admission or reservation failure.
									}
									throw error;
								}
								return admitted;
							};
						if (property === "queryRaw" || property === "executeRaw")
							return async (query: Query) => {
								const loan = context.captureTicket();
								let generation = transactionGeneration;
								if (yielding) {
									const deadline = performance.now() + 5000;
									for (;;) {
										context.assertTicket();
										loan();
										if (closing || disposePromise || !native?.open || performance.now() >= deadline)
											throw new RestoreRuntimeAdmissionError();
										if (native.inTransaction) {
											await ownershipGuard(loan);
											await delay(Math.min(5, Math.max(0, deadline - performance.now())));
											continue;
										}
										generation = transactionGeneration;
										await guard(loan, query.sql);
										if (performance.now() >= deadline) throw new RestoreRuntimeAdmissionError();
										// An unrelated BEGIN can race the awaited guard. Wait before
										// first SQL rather than borrowing its transaction or losing work.
										if (!native.inTransaction && generation === transactionGeneration) break;
									}
								} else await guard(loan, query.sql);
								// Await resumes in a later microtask. Fence again in the
								// same synchronous turn as the actual native statement.
								context.assertTicket();
								return statement<Awaited<ReturnType<Driver[typeof property]>>>(
									query,
									(copied) => target[property](copied),
									() => guard(loan, query.sql),
									() => {
										context.assertTicket();
										loan();
									},
									false,
									generation,
								);
							};
						if (property === "executeScript")
							return async () => {
								throw new RestoreRuntimeAdmissionError();
							};
						if (property === "getConnectionInfo") return target.getConnectionInfo?.bind(target);
						return Reflect.get(target, property, target);
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
	const adapter = {
		provider: source.provider,
		adapterName: source.adapterName,
		connect,
		connectToShadowDb: async (): Promise<Driver> => {
			throw new RestoreRuntimeAdmissionError();
		},
	} satisfies Pick<
		ReturnType<typeof createRecoverableSqliteAdapter>,
		"provider" | "adapterName" | "connect" | "connectToShadowDb"
	>;
	try {
		prisma = new PrismaClient({ adapter });
	} catch {
		unregister();
		throw new RestoreRuntimeAdmissionError();
	}
	return Object.freeze({ prisma, close });
}

function guardTransaction(
	transaction: Transaction,
	guard: (sql?: string) => Promise<void>,
	failedCleanup: () => Promise<void>,
	assertStatement: () => void,
	statement: <T>(
		query: Query,
		invoke: (copied: Query) => Promise<T>,
		revalidate: () => Promise<void>,
		assert: () => void,
		isClosedTransactionError?: (error: unknown) => boolean,
	) => Promise<T>,
): Transaction {
	let settled = false;
	let committing = false;
	let commitExecuted = false;
	const closedTransactionError = new RestoreRuntimeAdmissionError();
	const isClosedTransactionError = (error: unknown) => error === closedTransactionError;
	const assertOpen = () => {
		if (settled || committing) throw closedTransactionError;
	};
	const rollback = async () => {
		if (settled) return;
		settled = true;
		try {
			await transaction.executeRaw(ROLLBACK);
			await transaction.rollback();
		} catch (error) {
			try {
				await failedCleanup();
			} catch {
				/* Failed physical close retains participation. */
			}
			throw error;
		}
	};
	return new Proxy(transaction, {
		get(target, property) {
			if (property === "rollback") return rollback;
			if (property === "commit")
				return async () => {
					if (!commitExecuted || settled) throw new RestoreRuntimeAdmissionError();
					await target.commit();
					settled = true;
				};
			if (property === "executeRaw")
				return async (query: Query) => {
					if (rollbackSql(query.sql)) {
						await rollback();
						return 0;
					}
					let attempted = false;
					try {
						assertOpen();
						await guard(query.sql);
						// Ownership may remain valid after a concurrent timeout closes
						// this transaction. Never let a late statement run in autocommit.
						assertOpen();
						assertStatement();
						// Native COMMIT ends the transaction before adapter cleanup
						// resolves; fence pending SQL without claiming commit success.
						if (commitSql(query.sql)) committing = true;
						attempted = true;
						const result = await statement(
							query,
							(copied) => target.executeRaw(copied),
							() => guard(query.sql),
							() => {
								if (commitSql(query.sql)) {
									if (settled || !committing || commitExecuted)
										throw new RestoreRuntimeAdmissionError();
								} else assertOpen();
								assertStatement();
							},
							isClosedTransactionError,
						);
						if (commitSql(query.sql)) commitExecuted = true;
						return result;
					} catch (error) {
						if (commitSql(query.sql)) {
							// The inner recoverable adapter owns cleanup after a native
							// COMMIT failure. Only a pre-SQL fence needs our rollback.
							if (attempted) settled = true;
							else {
								try {
									await rollback();
								} catch {
									/* Failed physical close retains participation. */
								}
							}
						}
						throw error;
					}
				};
			if (property === "queryRaw")
				return async (query: Query) => {
					assertOpen();
					await guard(query.sql);
					assertOpen();
					assertStatement();
					return statement(
						query,
						(copied) => target.queryRaw(copied),
						() => guard(query.sql),
						() => {
							assertOpen();
							assertStatement();
						},
						isClosedTransactionError,
					);
				};
			if (
				property === "createSavepoint" ||
				property === "releaseSavepoint" ||
				property === "rollbackToSavepoint"
			) {
				const method = Reflect.get(target, property, target);
				if (typeof method !== "function") return undefined;
				return async (...args: unknown[]) => {
					assertOpen();
					await guard();
					assertOpen();
					assertStatement();
					return Reflect.apply(method, target, args);
				};
			}
			return Reflect.get(target, property, target);
		},
	});
}
