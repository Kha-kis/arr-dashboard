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
import {
	getRuntimeReadSource,
	type RuntimeReadSource,
} from "./restore-runtime-read-diagnostics.js";
import { withRuntimeReadPhases } from "./restore-runtime-read-phases.js";
import { measureRuntimeReadTiming, startRuntimeReadTiming } from "./restore-runtime-read-timing.js";
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
type RuntimeReadOptions = Readonly<{
	workload?: "bulk-cache";
	maxWait?: number;
	signal?: AbortSignal;
}>;
type SqliteClientRegistration = {
	closed: boolean;
	publicationTransaction<T>(
		operation: (tx: Prisma.TransactionClient) => Promise<T>,
		options?: RuntimeTransactionOptions,
	): Promise<T>;
	readClient<T>(
		operation: (client: PrismaClientInstance) => Promise<T>,
		maxWait?: number,
		workload?: "bulk-cache",
		signal?: AbortSignal,
	): Promise<T>;
};
const ordinarySqliteClients = new WeakMap<object, SqliteClientRegistration>();
const unenteredPublicationStartRefusals = new WeakSet<object>();

/** Exact unentered SQLite provenance, not a generic timeout/admission retry. */
export function isRetryableSqlitePublicationStartRefusal(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && unenteredPublicationStartRefusals.has(error)
	);
}

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
	return registration.publicationTransaction(operation, options);
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
 * Cancellation only refuses callback entry; entered work stays joined to settlement.
 */
export async function withIsolatedRuntimePrismaReadClient<T>(
	prisma: PrismaClientInstance,
	operation: (client: PrismaClientInstance) => Promise<T>,
	options?: RuntimeReadOptions,
): Promise<T> {
	options?.signal?.throwIfAborted();
	const registration = ordinarySqliteClients.get(prisma);
	if (!registration) return operation(prisma);
	if (registration.closed) throw new RestoreRuntimeAdmissionError();
	return registration.readClient(operation, options?.maxWait, options?.workload, options?.signal);
}

/** Admit catalog-wide ancillary reads without consuming every ordinary lane. */
export function withIsolatedRuntimePrismaBulkReadClient<T>(
	prisma: PrismaClientInstance,
	operation: (client: PrismaClientInstance) => Promise<T>,
	options?: Readonly<{ lease: "phase" }>,
): Promise<T> {
	const registration = ordinarySqliteClients.get(prisma);
	if (options?.lease === "phase" && registration) {
		if (registration.closed) return Promise.reject(new RestoreRuntimeAdmissionError());
		return withRuntimeReadPhases(
			(read) => registration.readClient(read, undefined, "bulk-cache"),
			operation,
		);
	}
	return withIsolatedRuntimePrismaReadClient(prisma, operation, { workload: "bulk-cache" });
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
	const publicationTransactions = new Set<Promise<void>>();
	const retainPublicationTransaction = () => {
		let finish!: () => void;
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		publicationTransactions.add(settled);
		return () => {
			publicationTransactions.delete(settled);
			finish();
		};
	};
	let publicationBusy = false;
	type PublicationWaiter = {
		resolve(): void;
		reject(error: RestoreRuntimeAdmissionError): void;
	};
	const publicationWaiters = new Set<PublicationWaiter>();
	const acquirePublication = (maxWait: number): Promise<void> => {
		if (registration.closed) return Promise.reject(new RestoreRuntimeAdmissionError());
		if (!publicationBusy) {
			publicationBusy = true;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				publicationWaiters.delete(waiter);
				const error = new RestoreRuntimeAdmissionError();
				// Removed before lending the lane: no native start or callback ran.
				// A close/ownership refusal never obtains this exact-object proof.
				if (!registration.closed) unenteredPublicationStartRefusals.add(error);
				reject(error);
			}, maxWait);
			const waiter: PublicationWaiter = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			publicationWaiters.add(waiter);
		});
	};
	const releasePublication = () => {
		const next = publicationWaiters.values().next().value;
		if (next && !registration.closed) {
			publicationWaiters.delete(next);
			next.resolve();
		} else publicationBusy = false;
	};
	const closePublicationAdmission = () => {
		registration.closed = true;
		for (const waiter of publicationWaiters) waiter.reject(new RestoreRuntimeAdmissionError());
		publicationWaiters.clear();
	};
	// Cached-read fan-out is bounded independently from ordinary HTTP queries.
	// Reserve closure now; accepted work may first acquire a lane during drain.
	type ReadLane = {
		busy: boolean;
		workload?: "bulk-cache";
		client?: RuntimePrismaClient;
		source?: RuntimeReadSource;
		acquiredAt?: number;
	};
	type ReadWaiter = {
		workload?: "bulk-cache";
		source: RuntimeReadSource;
		enqueuedAt?: number;
		resolve(lane: ReadLane): void;
		reject(error: unknown): void;
	};
	const readLanes: ReadLane[] = Array.from({ length: 4 }, () => ({ busy: false }));
	const readWaiters = new Set<ReadWaiter>();
	const readClock = () => {
		try {
			const now = performance.now();
			return Number.isFinite(now) && now >= 0 ? now : undefined;
		} catch {
			return undefined;
		}
	};
	const attachReadQueue = (
		error: RestoreRuntimeAdmissionError,
		waiter: ReadWaiter,
		maxWait: number,
	) => {
		try {
			const now = readClock();
			if (now === undefined || !Number.isFinite(maxWait) || maxWait < 0) return;
			const elapsed = (startedAt: number | undefined) => {
				if (startedAt === undefined || !Number.isFinite(now - startedAt))
					throw new Error("Unavailable diagnostic clock");
				return Math.max(0, now - startedAt);
			};
			const busyLanes = readLanes
				.filter((lane) => lane.busy)
				.slice(0, 4)
				.map((lane) =>
					Object.freeze({
						source: lane.source ?? "unscoped",
						workload: lane.workload === "bulk-cache" ? "bulk-cache" : "ordinary",
						heldMs: elapsed(lane.acquiredAt),
					}),
				);
			Object.defineProperty(error, "readQueue", {
				enumerable: true,
				value: Object.freeze({
					reason: "read-lane-acquisition-timeout",
					source: waiter.source,
					workload: waiter.workload === "bulk-cache" ? "bulk-cache" : "ordinary",
					maxWaitMs: maxWait,
					waitedMs: elapsed(waiter.enqueuedAt),
					busyLanes: Object.freeze(busyLanes),
					queuedWaiters: readWaiters.size,
				}),
			});
		} catch {
			// Observation failure must never replace the original admission refusal.
		}
	};
	let readsClosePromise: Promise<void> | undefined;
	// Bulk catalog validation retains its whole callback lease, but cannot fill
	// every slot needed by session validation and primary page reads. Ineligible
	// waiters own no lane and retain the same single acquisition deadline.
	const eligibleRead = (workload?: "bulk-cache") =>
		workload !== "bulk-cache" ||
		readLanes.filter((lane) => lane.busy && lane.workload === "bulk-cache").length < 2;
	const acquireReadLane = (
		maxWait: number,
		workload?: "bulk-cache",
		signal?: AbortSignal,
	): Promise<ReadLane> => {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (registration.closed) return Promise.reject(new RestoreRuntimeAdmissionError());
		const source = getRuntimeReadSource();
		const acquiredAt = readClock();
		const lane = eligibleRead(workload) && readLanes.find((candidate) => !candidate.busy);
		if (lane) {
			lane.busy = true;
			lane.workload = workload;
			lane.source = source;
			lane.acquiredAt = acquiredAt;
			return Promise.resolve(lane);
		}
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				if (readWaiters.delete(waiter)) waiter.reject(signal!.reason);
			};
			const timer = setTimeout(() => {
				readWaiters.delete(waiter);
				const error = new RestoreRuntimeAdmissionError();
				attachReadQueue(error, waiter, maxWait);
				waiter.reject(error);
			}, maxWait);
			const waiter: ReadWaiter = {
				workload,
				source,
				enqueuedAt: acquiredAt,
				resolve: (next) => {
					cleanup();
					resolve(next);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			};
			readWaiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	};
	const releaseReadLane = (lane: ReadLane) => {
		lane.busy = false;
		lane.workload = undefined;
		lane.source = undefined;
		lane.acquiredAt = undefined;
		if (registration.closed) return;
		// FIFO among eligible waiters: a capped bulk request must not block a
		// later ordinary request while spare physical lanes remain available.
		for (const next of readWaiters) {
			if (!eligibleRead(next.workload)) continue;
			readWaiters.delete(next);
			lane.busy = true;
			lane.workload = next.workload;
			lane.source = next.source;
			lane.acquiredAt = readClock();
			next.resolve(lane);
			break;
		}
	};
	const registration: SqliteClientRegistration = {
		closed: false,
		publicationTransaction: async (operation, transactionOptions) => {
			// The adapter's BEGIN mutex does not cover our preceding guard reads.
			// Own the entire companion invocation so a guard cannot borrow another
			// publication's open snapshot before its writer reservation.
			const maxWait = transactionOptions?.maxWait ?? 2000;
			const began = performance.now();
			await acquirePublication(maxWait);
			let callbackEntered = false;
			let startRefusal: object | undefined;
			try {
				if (registration.closed) throw new RestoreRuntimeAdmissionError();
				const remaining = Math.floor(maxWait - (performance.now() - began));
				if (remaining <= 0) {
					// The lane was acquired, but no native start or callback ran.
					// Publish the exact-object proof only after finally settles it.
					const error = new RestoreRuntimeAdmissionError();
					startRefusal = error;
					throw error;
				}
				// Close lifetime is already reserved; ticket, owner and native fences
				// remain unchanged, including accepted work first publishing in drain.
				publication ??= createGuardedPrismaClient(
					{ ...context, registerClose: () => () => undefined },
					runtime,
					undefined,
					undefined,
					options?.sqliteTransactionIntent,
					retainPublicationTransaction,
				);
				return await publication.prisma.$transaction(
					(tx) => {
						callbackEntered = true;
						return operation(tx);
					},
					{
						...transactionOptions,
						maxWait: remaining,
					},
				);
			} catch (error) {
				if (typeof error === "object" && error !== null)
					unenteredPublicationStartRefusals.delete(error);
				if (!callbackEntered && error instanceof Error && "code" in error && error.code === "P2028")
					startRefusal = error;
				throw error;
			} finally {
				// Prisma can reject start on maxWait before its discarded native
				// transaction is rolled back. Keep the lane and accepted ticket alive
				// until physical startup/settlement, not just the caller promise, ends.
				while (publicationTransactions.size > 0) await Promise.all(publicationTransactions);
				releasePublication();
				// Only after physical settlement may an opted-in caller retry work
				// which never entered. Preserve the original error and every fence.
				if (startRefusal && !callbackEntered && !registration.closed)
					unenteredPublicationStartRefusals.add(startRefusal);
			}
		},
		readClient: async (operation, maxWait, workload, signal) => {
			// Session validation enters this same pool before route code. Let a
			// normal display burst queue behind bounded reads without adding lanes
			// or relaxing any SQL, ticket, ownership or transaction deadline.
			const lane = await measureRuntimeReadTiming("lane-wait", () =>
				acquireReadLane(maxWait ?? 10_000, workload, signal),
			);
			try {
				signal?.throwIfAborted();
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
		closePublicationAdmission();
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
		closePublicationAdmission();
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
			closePublicationAdmission();
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
	retainTransaction?: () => () => void,
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
		const opening = measureRuntimeReadTiming("connect", async () => {
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
					const finishOwnerTiming = startRuntimeReadTiming("owner-proof");
					try {
						// Service pending I/O before proving authority, never after the final native fence.
						if (yielding) await measureRuntimeReadTiming("yield", () => setImmediate());
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
					} finally {
						finishOwnerTiming();
					}
				};
				const guard = async (loan?: () => void, sql?: string) => {
					const finishGuardTiming = startRuntimeReadTiming("guard");
					try {
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
					} finally {
						finishGuardTiming();
					}
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
						return measureRuntimeReadTiming("statement-call", () => invoke(query));
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
						return await measureRuntimeReadTiming("statement-call", () => invoke(copied));
					} finally {
						statementFences.delete(copied);
					}
				};
				await guard();
				return new Proxy(actual, {
					get(target, property) {
						if (property === "dispose") return dispose;
						if (property === "startTransaction")
							return (isolation?: Parameters<Driver["startTransaction"]>[0]) =>
								trackNativeTransactionStart(async () => {
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
								}, retainTransaction);
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
		});
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

/** Retain physical startup and settlement even if Prisma abandons its start. */
async function trackNativeTransactionStart(
	start: () => Promise<Transaction>,
	retain?: () => () => void,
): Promise<Transaction> {
	const finish = retain?.();
	try {
		const transaction = await start();
		if (!finish) return transaction;
		return new Proxy(transaction, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property === "commit" || property === "rollback")
					return async () => {
						try {
							return await Reflect.apply(value, target, []);
						} finally {
							finish();
						}
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	} catch (error) {
		finish?.();
		throw error;
	}
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
