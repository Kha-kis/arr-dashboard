import {
	readRestoreRuntimeWorkerLoss,
	recordRestoreRuntimeWorkerLoss,
	type RestoreRuntimeLossDiagnostic,
	type RestoreRuntimeLossReason,
	sanitizeRestoreRuntimeLossReason,
} from "./restore-runtime-loss.js";

export class RestoreRuntimeAdmissionError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("Restore runtime admission is unavailable.");
		this.name = "RestoreRuntimeAdmissionError";
	}
}

// A busy main-file reader has no verified record, but has not disproved the
// separate native owner. Refuse this attempt without permanently fencing it.
class RestoreRuntimeContentionError extends RestoreRuntimeAdmissionError {}

export interface RestoreRuntime {
	runStarting<T>(operation: () => T | Promise<T>): Promise<T>;
	bindDestination(identity: string): Promise<void>;
	activate(): Promise<void>;
	runOperation<T>(operation: () => T | Promise<T>): Promise<T>;
	runIndependentOperation<T>(operation: () => T | Promise<T>): Promise<T>;
	closeAdmission(): void;
	drain(): Promise<void>;
	close(): Promise<void>;
}

export interface RetainedRestoreRuntimeOperation {
	run<T>(operation: () => Promise<T>): Promise<T>;
	release(): Promise<void>;
}

type RecordTransition = (record: Readonly<RestoreRuntimeRecord>) => Readonly<RestoreRuntimeRecord>;
type OperationParticipation = {
	initialRecord?: Readonly<RestoreRuntimeRecord>;
	release(): Promise<void>;
};
type Backend = {
	databaseUrl: string;
	postgresNamespace?: PostgresRuntimeNamespace;
	assertAvailable?(): void;
	assertOwned(): Promise<void>;
	retainOperation?(): Promise<OperationParticipation>;
	readOwnedPostgresRecord?(): Promise<Readonly<RestoreRuntimeRecord>>;
	validateSqliteBinding?(record: Record<string, unknown>): void;
	read(): Promise<Readonly<RestoreRuntimeRecord>>;
	mutate(transition: RecordTransition): Promise<void>;
	beginReplacement?(transition: RecordTransition): Promise<Readonly<RestoreRuntimeRecord>>;
	assertReplacementOwned?(): Promise<void>;
	readReplacementRecord?(): Promise<Readonly<RestoreRuntimeRecord>>;
	close(): Promise<void>;
	ownerBackendPid: number | null;
};
type RuntimeState = {
	databaseUrl: string;
	epoch: string;
	backend: Backend;
	phase: "starting" | "running";
	destinationInstallationId: string | null;
	startingAdmission: boolean;
	ordinaryAdmission: boolean;
	lost: boolean;
	closing: boolean;
	active: Set<Ticket>;
	retained: Set<Promise<void>>;
	waiters: Set<() => void>;
	clients: Set<() => Promise<void>>;
	lossListeners: Set<() => void>;
	controls: Promise<void>;
	activation?: Promise<void>;
	closePromise?: Promise<void>;
	replacement?: { completion: Promise<void> };
	lose(reason?: RestoreRuntimeLossReason): void;
};
type Ticket = { state: RuntimeState; starting: boolean; active: boolean };
const tickets = new AsyncLocalStorage<Ticket>();
const runtimes = new WeakMap<RestoreRuntime, RuntimeState>();
const runtimeActors = new WeakMap<RuntimeState, RestoreRuntime>();
declare const replacementBrand: unique symbol;
export type RestoreReplacementScope = Readonly<{ [replacementBrand]: true }>;
type ReplacementState = {
	state: RuntimeState;
	restoreId: string;
	pending: Readonly<RestoreRuntimeRecord>;
	active: boolean;
	writerClaimed: boolean;
	commitRequest: Readonly<RestoreRuntimeCommitRequest>;
};
const replacementScopes = new WeakMap<RestoreReplacementScope, ReplacementState>();
const replacementContext = new AsyncLocalStorage<ReplacementState>();
const COLUMNS = [
	"id",
	"protocolVersion",
	"phase",
	"runtimeEpoch",
	"ownerBackendPid",
	"activeRestoreId",
	"lastCommittedRestoreId",
	"lastCommittedAt",
	"destinationInstallationId",
] as const;
const quoted = (column: string) => `"${column}"`;

async function readPostgresRuntimeRecord(client: Client): Promise<Readonly<RestoreRuntimeRecord>> {
	// Prisma's timestamp(3) is a UTC wall-clock value. Do not apply node-pg's
	// host-local timestamp parser to durable historical evidence.
	const result = await client.query(
		`SELECT ${COLUMNS.map((column) => (column === "lastCommittedAt" ? `to_char("lastCommittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCommittedAt"` : quoted(column))).join(", ")} FROM "RestoreRuntimeControl" LIMIT 2`,
	);
	if (result.rows.length !== 1) throw new RestoreRuntimeAdmissionError();
	return parseRestoreRuntimeRecord(result.rows[0]);
}

async function postgresBackend(
	databaseUrl: string,
	epoch: string,
	onUnavailable: () => void,
): Promise<Backend> {
	const configured = parsePostgresRuntimeUrl(databaseUrl);
	const owner = await acquirePostgresRestoreRuntimeOwnership(
		configured.connectionString,
		onUnavailable,
	);
	let postgresNamespace: PostgresRuntimeNamespace | undefined;
	const connections = new Set<() => Promise<void>>();
	// Ordinary query pools may retire idle sessions while an accepted callback
	// is awaiting non-SQL work. One separate, reference-counted transaction keeps
	// its database-visible participation alive until actual callback settlement.
	let participant: { references: number; close(): Promise<void> } | undefined;
	let participationQueue: Promise<void> = Promise.resolve();
	let participationUnavailable = false;
	const participationLost = () => {
		participationUnavailable = true;
		onUnavailable();
	};
	const serializeParticipation = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = participationQueue.then(operation);
		participationQueue = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const retainOperation = () =>
		serializeParticipation(async () => {
			if (participationUnavailable) throw new RestoreRuntimeAdmissionError();
			let initialRecord: Readonly<RestoreRuntimeRecord> | undefined;
			if (!participant) {
				const client = new Client({
					connectionString: configured.connectionString,
					connectionTimeoutMillis: 5000,
					query_timeout: 5000,
					statement_timeout: 5000,
				});
				let connected = false;
				let intentionalClose = false;
				let ended!: () => void;
				const physicalEnd = new Promise<void>((resolve) => {
					ended = resolve;
				});
				client.on("error", participationLost);
				client.once("end", () => {
					ended();
					if (!intentionalClose) participationLost();
				});
				let end: Promise<void> | undefined;
				const close = () =>
					(end ??= Promise.resolve().then(async () => {
						intentionalClose = true;
						// Ending the physical session rolls back its read transaction.
						// An acknowledgement alone must not let drain outrun transport.
						try {
							await client.end();
						} catch {
							participationLost();
							if (!connected) throw new RestoreRuntimeAdmissionError();
						}
						if (connected) await physicalEnd;
						connections.delete(close);
					}));
				connections.add(close);
				try {
					await client.connect();
					connected = true;
					await client.query("BEGIN");
					const acquired = await client.query(
						"SELECT pg_try_advisory_xact_lock_shared($1, $2) AS acquired",
						[RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OPERATION_LOCK],
					);
					if (acquired.rows[0]?.acquired !== true) throw new RestoreRuntimeAdmissionError();
					await assertPostgresOwner(client, owner);
					postgresNamespace = await selectPostgresRuntimeNamespace(
						client,
						configured.schema,
						postgresNamespace,
					);
					initialRecord = await readPostgresRuntimeRecord(client);
					await assertPostgresOwner(client, owner);
					participant = { references: 0, close };
				} catch {
					participationLost();
					await close();
					throw new RestoreRuntimeAdmissionError();
				}
			}
			const retained = participant;
			retained.references++;
			let release: Promise<void> | undefined;
			return {
				// This proof belongs only to the ticket creating the connection. A
				// later participant must read afresh, never reuse a held snapshot.
				initialRecord,
				release: () =>
					(release ??= serializeParticipation(async () => {
						retained.references--;
						if (retained.references === 0) {
							try {
								await retained.close();
								participant = undefined;
							} catch {
								participationLost();
								throw new RestoreRuntimeAdmissionError();
							}
						}
					})),
			};
		});
	const transaction = async (exclusive: boolean, transition?: RecordTransition) => {
		const client = new Client({
			connectionString: configured.connectionString,
			connectionTimeoutMillis: 5000,
			query_timeout: 5000,
			statement_timeout: 5000,
		});
		// An idle/terminated control connection must never emit an unhandled error.
		client.on("error", onUnavailable);
		let end: Promise<void> | undefined;
		const close = () =>
			(end ??= client.end().then(() => {
				connections.delete(close);
			}));
		connections.add(close);
		let began = false;
		try {
			await client.connect();
			await client.query("BEGIN");
			began = true;
			const lock = exclusive ? "pg_try_advisory_xact_lock" : "pg_try_advisory_xact_lock_shared";
			const acquired = await client.query(`SELECT ${lock}($1, $2) AS acquired`, [
				RESTORE_POSTGRES_LOCK_NAMESPACE,
				RESTORE_POSTGRES_OPERATION_LOCK,
			]);
			if (acquired.rows[0]?.acquired !== true) throw new RestoreRuntimeAdmissionError();
			await assertPostgresOwner(client, owner);
			postgresNamespace = await selectPostgresRuntimeNamespace(
				client,
				configured.schema,
				postgresNamespace,
			);
			const record = await readPostgresRuntimeRecord(client);
			if (transition) {
				const next = parseRestoreRuntimeRecord(transition(record));
				const values = [
					...COLUMNS.map((column) => next[column]),
					...COLUMNS.map((column) => record[column]),
				];
				const changed = await client.query(
					`UPDATE "RestoreRuntimeControl" SET ${COLUMNS.map((column, i) => `${quoted(column)} = $${i + 1}`).join(", ")} WHERE ${COLUMNS.map((column, i) => `${quoted(column)} IS NOT DISTINCT FROM $${i + 10}`).join(" AND ")}`,
					values,
				);
				if (changed.rowCount !== 1) throw new RestoreRuntimeAdmissionError();
			}
			await assertPostgresOwner(client, owner);
			await client.query("COMMIT");
			began = false;
			return record;
		} catch {
			throw new RestoreRuntimeAdmissionError();
		} finally {
			try {
				if (began) await client.query("ROLLBACK");
			} finally {
				await close();
			}
		}
	};
	try {
		// Missing journals refuse opening; first PG initialization is a separate
		// controlled deployment actor, not a generic connection-side repair.
		await transaction(true, (record) =>
			prepareRestoreRuntimeStartingRecord(record, {
				runtimeEpoch: epoch,
				ownerBackendPid: owner.ownerBackendPid,
			}),
		);
		return {
			databaseUrl,
			postgresNamespace,
			assertOwned: () => owner.assertOwned(),
			retainOperation,
			readOwnedPostgresRecord: async () =>
				parseRestoreRuntimeRecord(await owner.readOwnedRecord(postgresNamespace!)),
			ownerBackendPid: owner.ownerBackendPid,
			read: () => transaction(false),
			mutate: async (transition) => {
				await transaction(false, transition);
			},
			beginReplacement: async (transition) => {
				let next: Readonly<RestoreRuntimeRecord> | undefined;
				await transaction(true, (record) => {
					next = parseRestoreRuntimeRecord(transition(record));
					return next;
				});
				return next!;
			},
			readReplacementRecord: () => transaction(true),
			close: async () => {
				await participationQueue;
				await Promise.all([...connections].map((close) => close()));
				await owner.close();
			},
		};
	} catch {
		try {
			await Promise.all([...connections].map((close) => close()));
			await owner.close();
		} catch {
			/* No authority escapes. */
		}
		throw new RestoreRuntimeAdmissionError();
	}
}

async function assertPostgresOwner(
	client: Client,
	owner: PostgresRestoreRuntimeOwnership,
): Promise<void> {
	await owner.assertOwned();
	const proof = await client.query(
		`SELECT EXISTS (SELECT 1 FROM pg_locks
		WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
		AND pid=$1 AND classid=$2::oid AND objid=$3::oid AND objsubid=2 AND granted AND mode='ExclusiveLock') AS owned`,
		[owner.ownerBackendPid, RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OWNER_LOCK],
	);
	if (proof.rows[0]?.owned !== true) throw new RestoreRuntimeAdmissionError();
}

async function sqliteBackend(
	databaseUrl: string,
	epoch: string,
	onUnavailable: (reason?: RestoreRuntimeLossReason) => void,
): Promise<Backend> {
	const { storage, ownership } = await enrollSqliteRestoreRuntimeStorage(databaseUrl, {
		runtimeEpoch: epoch,
	});
	const connections = new Set<() => Promise<void>>();
	let replacementExclusive = false;
	const assertOwner = async () => {
		try {
			await ownership.assertOwned();
		} catch {
			onUnavailable("native-owner-unavailable");
			throw new RestoreRuntimeAdmissionError();
		}
	};
	const assertBinding = (main: Database.Database) => {
		try {
			assertSqliteRestoreRuntimeStorageBinding(main, storage);
		} catch (error) {
			// Contention refuses only this attempt; disproved storage identity
			// must fence every future operation even before async owner checks.
			if (!(error instanceof Database.SqliteError && error.code === "SQLITE_BUSY"))
				onUnavailable("storage-binding-invalid");
			throw error;
		}
	};
	const transaction = async (transition?: RecordTransition) => {
		await assertOwner();
		const participation = await acquireSqliteRestoreOperationLock(databaseUrl);
		let main: Database.Database | undefined;
		let closePromise: Promise<void> | undefined;
		const close = () =>
			(closePromise ??= Promise.resolve().then(async () => {
				// Never release participation when physical database closure fails.
				if (main?.open) main.close();
				await participation.close();
				connections.delete(close);
			}));
		connections.add(close);
		try {
			// Verify async authority without holding a SQLite transaction. In
			// DELETE mode a yielded control reader can block a synchronous
			// admitted writer's COMMIT on this same event loop.
			await assertOwner();
			try {
				await participation.assertHeld();
			} catch {
				onUnavailable("native-participation-unavailable");
				throw new RestoreRuntimeAdmissionError();
			}
			main = new Database(storage.databasePath, { fileMustExist: true, timeout: 0 });
			main.exec(transition ? "BEGIN IMMEDIATE" : "BEGIN");
			assertBinding(main);
			const rows = main
				.prepare(`SELECT ${COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
				.all() as Record<string, unknown>[];
			if (rows.length !== 1) throw new RestoreRuntimeAdmissionError();
			const raw = rows[0]!;
			const record = parseSqliteRestoreRuntimeRecord(raw);
			if (transition) {
				const next = parseRestoreRuntimeRecord(transition(record));
				const changed = main
					.prepare(
						`UPDATE RestoreRuntimeControl SET phase=@nextPhase, destinationInstallationId=@nextIdentity WHERE ${COLUMNS.map((column) => `${column} IS @${column}`).join(" AND ")}`,
					)
					.run({ ...raw, nextPhase: next.phase, nextIdentity: next.destinationInstallationId });
				if (changed.changes !== 1) throw new RestoreRuntimeAdmissionError();
			}
			// Binding, journal/CAS and COMMIT stay in one synchronous turn. The
			// native SHARED participant remains held throughout and until close.
			assertBinding(main);
			main.exec("COMMIT");
			try {
				await participation.assertHeld();
			} catch {
				onUnavailable("native-participation-unavailable");
				throw new RestoreRuntimeAdmissionError();
			}
			await assertOwner();
			return record;
		} catch (error) {
			if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY")
				throw new RestoreRuntimeContentionError();
			throw new RestoreRuntimeAdmissionError();
		} finally {
			try {
				if (main?.inTransaction) main.exec("ROLLBACK");
			} finally {
				await close();
			}
		}
	};
	try {
		await ownership.releaseExclusive();
		return {
			databaseUrl: `file:${storage.databasePath}`,
			assertOwned: assertOwner,
			validateSqliteBinding: (record) => assertSqliteRestoreRuntimeBindingRecord(storage, record),
			ownerBackendPid: null,
			read: async () => {
				const deadline = performance.now() + 100;
				for (;;) {
					try {
						return await transaction();
					} catch (error) {
						if (!(error instanceof RestoreRuntimeContentionError)) throw error;
						const remaining = deadline - performance.now();
						if (remaining <= 0) throw error;
						// The failed proof has closed its main-file handle and SHARED
						// participant before yielding. Retry only a fresh read proof,
						// never a callback, control write or disproved native owner.
						await delay(Math.min(5, remaining));
						if (performance.now() >= deadline) throw error;
					}
				}
			},
			mutate: async (transition) => {
				await transaction(transition);
			},
			beginReplacement: async (transition) => {
				await assertOwner();
				if (!(await ownership.tryAcquireExclusive())) throw new RestoreRuntimeAdmissionError();
				replacementExclusive = true;
				// Keep this owner-native EXCLUSIVE handle until backend.close. A new
				// SHARED participant here would deadlock the very exclusion it needs.
				let main: Database.Database | undefined;
				let closePromise: Promise<void> | undefined;
				const close = () =>
					(closePromise ??= Promise.resolve().then(() => {
						if (main?.open) main.close();
						connections.delete(close);
					}));
				connections.add(close);
				try {
					await assertOwner();
					main = new Database(storage.databasePath, { fileMustExist: true, timeout: 0 });
					main.exec("BEGIN IMMEDIATE");
					assertBinding(main);
					const rows = main
						.prepare(`SELECT ${COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
						.all() as Record<string, unknown>[];
					if (rows.length !== 1) throw new RestoreRuntimeAdmissionError();
					const raw = rows[0]!;
					const next = parseRestoreRuntimeRecord(transition(parseSqliteRestoreRuntimeRecord(raw)));
					const changed = main
						.prepare(
							`UPDATE RestoreRuntimeControl SET phase=@nextPhase, activeRestoreId=@nextRestoreId WHERE ${COLUMNS.map((column) => `${column} IS @${column}`).join(" AND ")}`,
						)
						.run({ ...raw, nextPhase: next.phase, nextRestoreId: next.activeRestoreId });
					if (changed.changes !== 1) throw new RestoreRuntimeAdmissionError();
					assertBinding(main);
					main.exec("COMMIT");
					await assertOwner();
					return next;
				} catch {
					throw new RestoreRuntimeAdmissionError();
				} finally {
					try {
						if (main?.inTransaction) main.exec("ROLLBACK");
					} finally {
						// Rejected physical close remains registered, preventing owner release.
						await close();
					}
				}
			},
			assertReplacementOwned: async () => {
				if (!replacementExclusive) throw new RestoreRuntimeAdmissionError();
				await assertOwner();
			},
			readReplacementRecord: async () => {
				if (!replacementExclusive) throw new RestoreRuntimeAdmissionError();
				await assertOwner();
				let main: Database.Database | undefined;
				let end: Promise<void> | undefined;
				const close = () =>
					(end ??= Promise.resolve().then(() => {
						if (main?.open) main.close();
						connections.delete(close);
					}));
				connections.add(close);
				try {
					main = new Database(storage.databasePath, {
						readonly: true,
						fileMustExist: true,
						timeout: 0,
					});
					main.exec("BEGIN");
					assertBinding(main);
					const rows = main
						.prepare(`SELECT ${COLUMNS.join(", ")} FROM RestoreRuntimeControl LIMIT 2`)
						.all() as Record<string, unknown>[];
					if (rows.length !== 1) throw new RestoreRuntimeAdmissionError();
					const record = parseSqliteRestoreRuntimeRecord(rows[0]!);
					assertBinding(main);
					main.exec("COMMIT");
					await assertOwner();
					return record;
				} finally {
					try {
						if (main?.inTransaction) main.exec("ROLLBACK");
					} finally {
						await close();
					}
				}
			},
			close: async () => {
				await Promise.all([...connections].map((close) => close()));
				await ownership.close();
			},
		};
	} catch {
		await ownership.close();
		throw new RestoreRuntimeAdmissionError();
	}
}

function stateOf(runtime: RestoreRuntime): RuntimeState {
	const state = runtimes.get(runtime);
	if (!state) throw new RestoreRuntimeAdmissionError();
	return state;
}
function validTicket(state: RuntimeState): Ticket | undefined {
	const ticket = tickets.getStore();
	return ticket?.state === state && ticket.active ? ticket : undefined;
}
function finishTicket(ticket: Ticket): void {
	ticket.active = false;
	ticket.state.active.delete(ticket);
	if (ticket.state.active.size === 0) {
		for (const resolve of ticket.state.waiters) resolve();
		ticket.state.waiters.clear();
	}
}
async function assertCurrent(
	state: RuntimeState,
	initialRecord?: Readonly<RestoreRuntimeRecord>,
): Promise<void> {
	if (state.lost) throw new RestoreRuntimeAdmissionError();
	try {
		state.backend.assertAvailable?.();
		const record = initialRecord ?? (await state.backend.read());
		state.backend.assertAvailable?.();
		if (
			record.runtimeEpoch !== state.epoch ||
			record.ownerBackendPid !== state.backend.ownerBackendPid ||
			record.phase !== state.phase ||
			(state.phase === "running" &&
				record.destinationInstallationId !== state.destinationInstallationId) ||
			state.lost
		)
			throw new RestoreRuntimeAdmissionError();
	} catch (error) {
		if (error instanceof RestoreRuntimeContentionError) throw error;
		state.lose("runtime-record-check-failed");
		throw new RestoreRuntimeAdmissionError();
	}
}

export async function openRestoreRuntime(options: {
	databaseUrl: string;
	onUnavailable?: (diagnostic: RestoreRuntimeLossDiagnostic) => void;
}): Promise<Readonly<RestoreRuntime>> {
	const databaseUrl = options.databaseUrl;
	const onUnavailable = options.onUnavailable;
	const epoch = randomUUID();
	const startedAt = performance.now();
	let state: RuntimeState | undefined;
	let lost = false;
	let notified = false;
	let firstLossDiagnostic: RestoreRuntimeLossDiagnostic | undefined;
	const lose = (reason?: RestoreRuntimeLossReason) => {
		lost = true;
		// Freeze before loss listeners can report secondary failures reentrantly.
		firstLossDiagnostic ??= {
			reason: sanitizeRestoreRuntimeLossReason(reason),
			runtimeAgeMs: Math.max(0, Math.round(performance.now() - startedAt)),
		};
		if (state) {
			const firstLoss = !state.lost;
			state.lost = true;
			state.startingAdmission = false;
			state.ordinaryAdmission = false;
			if (firstLoss) for (const listener of state.lossListeners) listener();
		}
		if (!notified) {
			notified = true;
			try {
				onUnavailable?.(firstLossDiagnostic);
			} catch {
				/* The latch cannot be undone. */
			}
		}
	};
	let backend: Backend;
	try {
		backend = /^postgres(ql)?:\/\//i.test(databaseUrl)
			? await postgresBackend(databaseUrl, epoch, lose)
			: await sqliteBackend(databaseUrl, epoch, lose);
	} catch {
		throw new RestoreRuntimeAdmissionError();
	}
	return createRuntimeActor(backend, epoch, {
		lost: () => lost,
		lose,
		bind: (owned) => {
			state = owned;
		},
	});
}

/** Private shared construction: neither an epoch string nor a structural runtime is authority. */
async function createRuntimeActor(
	backend: Backend,
	epoch: string,
	loss: {
		lost(): boolean;
		lose(reason?: RestoreRuntimeLossReason): void;
		bind(state: RuntimeState): void;
	},
	initial?: Readonly<RestoreRuntimeRecord>,
): Promise<Readonly<RestoreRuntime>> {
	const lose = loss.lose;
	const owned: RuntimeState = {
		databaseUrl: backend.databaseUrl,
		epoch,
		backend,
		phase: initial?.phase === "running" ? "running" : "starting",
		destinationInstallationId: initial?.destinationInstallationId ?? null,
		startingAdmission: true,
		ordinaryAdmission: initial?.phase === "running",
		lost: loss.lost(),
		closing: false,
		active: new Set(),
		retained: new Set(),
		waiters: new Set(),
		clients: new Set(),
		lossListeners: new Set(),
		controls: Promise.resolve(),
		lose,
	};
	loss.bind(owned);
	const drainActive = () =>
		owned.active.size === 0
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					owned.waiters.add(resolve);
				});
	const drain = async () => {
		while (owned.active.size > 0 || owned.retained.size > 0) {
			await Promise.all([drainActive(), ...owned.retained]);
		}
	};
	const run = async <T>(
		starting: boolean,
		independent: boolean,
		operation: () => T | Promise<T>,
	): Promise<T> => {
		const inherited = tickets.getStore();
		const current = validTicket(owned);
		if (!independent && inherited?.state === owned) {
			if (!current || current.starting !== starting) throw new RestoreRuntimeAdmissionError();
			await assertCurrent(owned);
			if (!current.active) throw new RestoreRuntimeAdmissionError();
			return operation();
		}
		const admitted = () =>
			!owned.closing &&
			!owned.lost &&
			(starting
				? owned.phase === "starting" && owned.startingAdmission
				: owned.phase === "running" && owned.ordinaryAdmission);
		if (!admitted()) throw new RestoreRuntimeAdmissionError();
		const ticket: Ticket = { state: owned, starting, active: true };
		// Ownership validation itself uses native SQL. Track its physical lifetime
		// before the first await so cutover cannot drain past an in-flight check.
		// The ticket enters async context only after proof and admission revalidation.
		owned.active.add(ticket);
		let participation: OperationParticipation | undefined;
		try {
			participation = await backend.retainOperation?.();
			await assertCurrent(owned, participation?.initialRecord);
			if (!admitted()) throw new RestoreRuntimeAdmissionError();
			// Prisma returns lazy thenables. Assimilate them inside the ticket's
			// context, not in the caller's await after AsyncLocalStorage.run returns.
			return await tickets.run(ticket, async () => await operation());
		} finally {
			// Keep the ticket tracked if physical participation closure is uncertain.
			await participation?.release();
			finishTicket(ticket);
		}
	};
	const control = (operation: () => Promise<void>): Promise<void> => {
		const result = owned.controls.then(async () => {
			if (owned.closing || owned.lost) throw new RestoreRuntimeAdmissionError();
			await assertCurrent(owned);
			await operation();
		});
		owned.controls = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const requireStarting = (record: Readonly<RestoreRuntimeRecord>) => {
		if (
			record.phase !== "starting" ||
			record.runtimeEpoch !== epoch ||
			record.ownerBackendPid !== backend.ownerBackendPid
		)
			throw new RestoreRuntimeAdmissionError();
	};
	const runtime: Readonly<RestoreRuntime> = Object.freeze({
		runStarting: <T>(operation: () => T | Promise<T>) => run(true, false, operation),
		runOperation: <T>(operation: () => T | Promise<T>) => run(false, false, operation),
		runIndependentOperation: <T>(operation: () => T | Promise<T>) =>
			run(owned.phase === "starting" && validTicket(owned)?.starting === true, true, operation),
		bindDestination: (identity: string) =>
			control(async () => {
				await backend.mutate((record) => {
					requireStarting(record);
					if (
						record.destinationInstallationId !== null &&
						record.destinationInstallationId !== identity
					)
						throw new RestoreRuntimeAdmissionError();
					const next = parseRestoreRuntimeRecord({
						...record,
						destinationInstallationId: identity,
					});
					if (next.destinationInstallationId === null) throw new RestoreRuntimeAdmissionError();
					return next;
				});
			}),
		activate: () => {
			if (owned.activation) return owned.activation;
			if (owned.closing || owned.lost || owned.phase !== "starting" || validTicket(owned))
				return Promise.reject(new RestoreRuntimeAdmissionError());
			owned.startingAdmission = false;
			// Do not hold the control queue while joining bootstrap: accepted
			// security/bootstrap work may itself need to bind the destination.
			owned.activation = Promise.resolve()
				.then(async () => {
					await drainActive();
					if (owned.closing || owned.lost) throw new RestoreRuntimeAdmissionError();
					await control(async () => {
						let destinationInstallationId: string | null = null;
						await backend.mutate((record) => {
							requireStarting(record);
							const next = parseRestoreRuntimeRecord({ ...record, phase: "running" });
							destinationInstallationId = next.destinationInstallationId;
							return next;
						});
						owned.destinationInstallationId = destinationInstallationId;
						owned.phase = "running";
						if (!owned.closing && !owned.lost) owned.ordinaryAdmission = true;
					});
				})
				.finally(() => {
					owned.activation = undefined;
					if (owned.phase === "starting" && !owned.closing && !owned.lost)
						owned.startingAdmission = true;
				});
			return owned.activation;
		},
		closeAdmission: () => {
			owned.closing = true;
			owned.startingAdmission = false;
			owned.ordinaryAdmission = false;
		},
		drain,
		close: () => {
			if (
				validTicket(owned) ||
				(replacementContext.getStore()?.state === owned && replacementContext.getStore()?.active)
			)
				return Promise.reject(new RestoreRuntimeAdmissionError());
			if (!owned.closePromise) {
				runtime.closeAdmission();
				owned.closePromise = Promise.resolve()
					.then(async () => {
						await owned.activation?.catch(() => {});
						await owned.controls;
						await owned.replacement?.completion;
						await drain();
						const closed = await Promise.allSettled(
							[...owned.clients].map((close) => Promise.resolve().then(close)),
						);
						if (closed.some((result) => result.status === "rejected"))
							throw new RestoreRuntimeAdmissionError();
						await backend.close();
					})
					.catch(() => {
						lose();
						throw new RestoreRuntimeAdmissionError();
					});
			}
			return owned.closePromise;
		},
	});
	runtimes.set(runtime, owned);
	runtimeActors.set(owned, runtime);
	try {
		await assertCurrent(owned);
		return runtime;
	} catch {
		await runtime.close();
		throw new RestoreRuntimeAdmissionError();
	}
}

export async function assertRestoreRuntimeOperation(runtime: RestoreRuntime): Promise<void> {
	const state = stateOf(runtime);
	const ticket = validTicket(state);
	if (!ticket || state.lost) throw new RestoreRuntimeAdmissionError();
	await assertCurrent(state);
	if (!ticket.active || state.lost) throw new RestoreRuntimeAdmissionError();
}

/** Preserve an accepted queue obligation without extending the parent's ticket. */
export function retainRestoreRuntimeOperation(): RetainedRestoreRuntimeOperation | undefined {
	const parent = tickets.getStore();
	// Synthetic/context-free callers receive no authority. Native clients still refuse them.
	if (!parent) return undefined;
	const state = parent.state;
	if (!parent.active || state.lost || !runtimeActors.has(state)) {
		throw new RestoreRuntimeAdmissionError();
	}
	let finish!: () => void;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	state.retained.add(completion);
	let releasing = false;
	const executions = new Set<Promise<void>>();
	const executingTickets = new Set<Ticket>();
	const finishRetained = () => {
		if (releasing && executions.size === 0) {
			state.retained.delete(completion);
			finish();
		}
	};
	return Object.freeze({
		run: async <T>(operation: () => Promise<T>): Promise<T> => {
			if (releasing || state.lost) throw new RestoreRuntimeAdmissionError();
			let settle!: () => void;
			const execution = new Promise<void>((resolve) => {
				settle = resolve;
			});
			executions.add(execution);
			let ticket: Ticket | undefined;
			let participation: OperationParticipation | undefined;
			try {
				// Idle queues do not block activation. A callback arriving during the
				// transition waits before choosing its actual starting/running phase.
				if (state.activation) await state.activation;
				if (state.lost) throw new RestoreRuntimeAdmissionError();
				ticket = { state, starting: state.phase === "starting", active: true };
				state.active.add(ticket);
				executingTickets.add(ticket);
				participation = await state.backend.retainOperation?.();
				await assertCurrent(state, participation?.initialRecord);
				if (state.lost || !ticket.active) throw new RestoreRuntimeAdmissionError();
				return await tickets.run(ticket, async () => await operation());
			} finally {
				await participation?.release();
				if (ticket) {
					finishTicket(ticket);
					executingTickets.delete(ticket);
				}
				executions.delete(execution);
				settle();
				finishRetained();
			}
		},
		release: () => {
			const current = tickets.getStore();
			if (current && executingTickets.has(current)) {
				return Promise.reject(new RestoreRuntimeAdmissionError());
			}
			releasing = true;
			finishRetained();
			return completion;
		},
	});
}

/** Compose existing producer guards with the module-owned actor context. */
export function withRestoreRuntimeOperation<T>(
	operation: () => Promise<T>,
	options: { independent?: boolean } = {},
): Promise<T> {
	const inherited = tickets.getStore();
	// Legacy callers without a runtime context receive no ticket. The guarded
	// native client still refuses every ordinary query without real admission.
	if (!inherited) return operation();
	const runtime = runtimeActors.get(inherited.state);
	if (!runtime) throw new RestoreRuntimeAdmissionError();
	if (options.independent || !inherited.active) return runtime.runIndependentOperation(operation);
	return inherited.starting ? runtime.runStarting(operation) : runtime.runOperation(operation);
}

/** Trusted native-client boundary; structural objects never mint this context. */
export function getRestoreRuntimeClientContext(runtime: RestoreRuntime) {
	const state = stateOf(runtime);
	if (state.closing || state.lost || (state.replacement && !validTicket(state)))
		throw new RestoreRuntimeAdmissionError();
	const assertTicket = () => {
		try {
			state.backend.assertAvailable?.();
		} catch {
			state.lose();
			throw new RestoreRuntimeAdmissionError();
		}
		if (!validTicket(state) || state.lost) throw new RestoreRuntimeAdmissionError();
	};
	const validateRecord = (value: unknown) => {
		try {
			const record = parseRestoreRuntimeRecord(value);
			if (
				record.runtimeEpoch !== state.epoch ||
				record.ownerBackendPid !== state.backend.ownerBackendPid ||
				record.phase !== state.phase ||
				(state.phase === "running" &&
					record.destinationInstallationId !== state.destinationInstallationId) ||
				state.lost
			)
				throw new RestoreRuntimeAdmissionError();
		} catch {
			state.lose("client-invalid-journal");
			throw new RestoreRuntimeAdmissionError();
		}
	};
	return Object.freeze({
		databaseUrl: state.databaseUrl,
		postgresNamespace: state.backend.postgresNamespace,
		runtimeEpoch: state.epoch,
		ownerBackendPid: state.backend.ownerBackendPid,
		assertTicket,
		captureTicket: () => {
			assertTicket();
			const captured = validTicket(state)!;
			return () => {
				assertTicket();
				if (validTicket(state) !== captured || state.lost) throw new RestoreRuntimeAdmissionError();
			};
		},
		assertOwned: async () => {
			try {
				await state.backend.assertOwned();
			} catch {
				state.lose("native-owner-unavailable");
				throw new RestoreRuntimeAdmissionError();
			}
		},
		assertCurrentPostgresRecord: async () => {
			try {
				if (!state.backend.readOwnedPostgresRecord) throw new RestoreRuntimeAdmissionError();
				validateRecord(await state.backend.readOwnedPostgresRecord());
			} catch {
				state.lose();
				throw new RestoreRuntimeAdmissionError();
			}
		},
		validateRecord,
		validateSqliteBinding: (record: Record<string, unknown>) => {
			try {
				if (!state.backend.validateSqliteBinding) throw new RestoreRuntimeAdmissionError();
				state.backend.validateSqliteBinding(record);
			} catch {
				state.lose("storage-binding-invalid");
				throw new RestoreRuntimeAdmissionError();
			}
		},
		registerClose: (close: () => Promise<void>) => {
			if (state.closing || state.lost) throw new RestoreRuntimeAdmissionError();
			state.clients.add(close);
			return () => {
				state.clients.delete(close);
			};
		},
		// Existing native event emitters may pass an Error argument. Keep their
		// callback contract, but never retain that argument as diagnostic data.
		unavailable: (reason?: unknown) => state.lose(sanitizeRestoreRuntimeLossReason(reason)),
	});
}

/** Single-use maintenance reservation; never an ordinary operation ticket. */
export async function withRestoreRuntimeReplacement<T>(
	runtime: RestoreRuntime,
	prepared: unknown,
	operation: (scope: RestoreReplacementScope) => Promise<T>,
): Promise<T> {
	const state = stateOf(runtime);
	assertPreparedRestorePublication(prepared, state.destinationInstallationId ?? "");
	if (
		state.lost ||
		state.closing ||
		state.replacement ||
		state.phase !== "running" ||
		!state.ordinaryAdmission ||
		!state.backend.beginReplacement ||
		tickets.getStore()?.state === state
	)
		throw new RestoreRuntimeAdmissionError();
	let finish!: () => void;
	let failed!: () => void;
	const completion = new Promise<void>((resolve, reject) => {
		finish = resolve;
		failed = () => reject(new RestoreRuntimeAdmissionError());
	});
	// Shutdown may not yet be listening. Keep a rejected physical-close result
	// observed without converting it into successful completion for shutdown.
	void completion.catch(() => {});
	state.replacement = { completion };
	state.startingAdmission = false;
	state.ordinaryAdmission = false;
	let replacement: ReplacementState | undefined;
	let closureFailed = false;
	const closeClients = async () => {
		const closed = await Promise.allSettled(
			[...state.clients].map((close) => Promise.resolve().then(close)),
		);
		if (closed.some((result) => result.status === "rejected")) {
			closureFailed = true;
			state.lose();
			throw new RestoreRuntimeAdmissionError();
		}
	};
	try {
		await state.controls;
		await runtime.drain();
		await closeClients();
		if (state.lost || state.closing) throw new RestoreRuntimeAdmissionError();
		const restoreId = randomUUID();
		const pending = await state.backend.beginReplacement((record) => {
			if (
				state.lost ||
				state.closing ||
				record.phase !== "running" ||
				record.runtimeEpoch !== state.epoch ||
				record.ownerBackendPid !== state.backend.ownerBackendPid ||
				record.destinationInstallationId !== state.destinationInstallationId
			)
				throw new RestoreRuntimeAdmissionError();
			return parseRestoreRuntimeRecord({
				...record,
				phase: "restore-pending",
				activeRestoreId: restoreId,
			});
		});
		if (state.lost || state.closing) throw new RestoreRuntimeAdmissionError();
		replacement = {
			state,
			restoreId,
			pending,
			active: true,
			writerClaimed: false,
			commitRequest: Object.freeze({
				runtimeEpoch: state.epoch,
				restoreId,
				destinationInstallationId: pending.destinationInstallationId!,
				committedAt: new Date().toISOString(),
			}),
		};
		const scope = Object.freeze({}) as RestoreReplacementScope;
		replacementScopes.set(scope, replacement);
		return await replacementContext.run(replacement, async () => await operation(scope));
	} finally {
		if (replacement) replacement.active = false;
		try {
			await closeClients();
		} finally {
			// Maintenance never reopens this runtime. Only actual closure permits
			// shutdown to release its native owner; callback errors are not replayed.
			if (closureFailed) failed();
			else finish();
		}
	}
}

/** Private native-client authority: an ID, clone, or escaped callback cannot mint it. */
export function getRestoreRuntimeReplacementClientContext(scope: unknown) {
	if (typeof scope !== "object" || scope === null) throw new RestoreRuntimeAdmissionError();
	const replacement = replacementScopes.get(scope as RestoreReplacementScope);
	if (!replacement) throw new RestoreRuntimeAdmissionError();
	const { state, pending, restoreId } = replacement;
	const assertTicket = () => {
		if (!replacement.active || replacementContext.getStore() !== replacement || state.lost)
			throw new RestoreRuntimeAdmissionError();
	};
	assertTicket();
	const committed = prepareRestoreRuntimeCommitRecord(pending, replacement.commitRequest);
	const sameRecord = (
		record: Readonly<RestoreRuntimeRecord>,
		expected: Readonly<RestoreRuntimeRecord>,
	) => COLUMNS.every((column) => record[column] === expected[column]);
	const validateRecord = (value: unknown) => {
		assertTicket();
		try {
			const record = parseRestoreRuntimeRecord(value);
			if (COLUMNS.some((column) => record[column] !== pending[column]))
				throw new RestoreRuntimeAdmissionError();
		} catch {
			state.lose();
			throw new RestoreRuntimeAdmissionError();
		}
	};
	return Object.freeze({
		databaseUrl: state.databaseUrl,
		postgresNamespace: state.backend.postgresNamespace,
		runtimeEpoch: state.epoch,
		ownerBackendPid: state.backend.ownerBackendPid,
		destinationInstallationId: pending.destinationInstallationId!,
		restoreId,
		assertTicket,
		captureTicket: () => {
			assertTicket();
			return assertTicket;
		},
		assertOwned: async () => {
			assertTicket();
			try {
				if (state.backend.assertReplacementOwned) await state.backend.assertReplacementOwned();
				else await state.backend.assertOwned();
				assertTicket();
			} catch {
				state.lose();
				throw new RestoreRuntimeAdmissionError();
			}
		},
		assertCurrentPostgresRecord: async () => {
			assertTicket();
			try {
				if (!state.backend.readOwnedPostgresRecord) throw new RestoreRuntimeAdmissionError();
				validateRecord(await state.backend.readOwnedPostgresRecord());
			} catch {
				state.lose();
				throw new RestoreRuntimeAdmissionError();
			}
		},
		validateRecord,
		commitRequest: replacement.commitRequest,
		claimWriter: () => {
			assertTicket();
			if (replacement.writerClaimed) throw new RestoreRuntimeAdmissionError();
			replacement.writerClaimed = true;
		},
		validateStatementRecord: (value: unknown, sql?: string) => {
			assertTicket();
			try {
				const record = parseRestoreRuntimeRecord(value);
				const commit = sql !== undefined && /^\s*COMMIT\s*;?\s*$/i.test(sql);
				if (!sameRecord(record, commit ? committed : pending))
					throw new RestoreRuntimeAdmissionError();
			} catch {
				state.lose();
				throw new RestoreRuntimeAdmissionError();
			}
		},
		readClosedPublicationOutcome: async (): Promise<"committed" | "not-committed"> => {
			assertTicket();
			if (state.clients.size !== 0 || !state.backend.readReplacementRecord)
				throw new RestoreRuntimeAdmissionError();
			const record = await state.backend.readReplacementRecord();
			assertTicket();
			if (sameRecord(record, committed)) return "committed";
			if (sameRecord(record, pending)) return "not-committed";
			state.lose();
			throw new RestoreRuntimeAdmissionError();
		},
		validateSqliteBinding: (record: Record<string, unknown>) => {
			assertTicket();
			try {
				if (!state.backend.validateSqliteBinding) throw new RestoreRuntimeAdmissionError();
				state.backend.validateSqliteBinding(record);
			} catch {
				state.lose();
				throw new RestoreRuntimeAdmissionError();
			}
		},
		registerClose: (close: () => Promise<void>) => {
			assertTicket();
			state.clients.add(close);
			return () => {
				state.clients.delete(close);
			};
		},
		unavailable: (reason?: unknown) => state.lose(sanitizeRestoreRuntimeLossReason(reason)),
	});
}
export type RestoreRuntimeWorkerBinding = Readonly<{
	databaseUrl: string;
	record: Readonly<RestoreRuntimeRecord>;
	port: MessagePort;
	fence: SharedArrayBuffer;
}>;

/** Transfer only from an active module-owned operation; this never creates another owner. */
export async function attachRestoreRuntimeWorker(databaseUrl?: string): Promise<
	Readonly<{
		binding: RestoreRuntimeWorkerBinding;
		onUnavailable(listener: () => void): () => void;
		close(): Promise<void>;
	}>
> {
	const ticket = tickets.getStore();
	if (!ticket?.active || ticket.state.lost) throw new RestoreRuntimeAdmissionError();
	const state = ticket.state;
	if (!runtimeActors.has(state) || !state.databaseUrl.startsWith("file:"))
		throw new RestoreRuntimeAdmissionError();
	if (
		databaseUrl !== undefined &&
		`file:${resolveSqliteRestoreStorage(databaseUrl).databasePath}` !== state.databaseUrl
	)
		throw new RestoreRuntimeAdmissionError();
	await assertCurrent(state);
	const record = await state.backend.read();
	if (!ticket.active || state.lost) throw new RestoreRuntimeAdmissionError();
	const { port1, port2 } = new MessageChannel();
	const fence = new SharedArrayBuffer(8),
		words = new Int32Array(fence);
	let closing = false,
		released = false,
		quarantined = false,
		lastId = 0;
	const pending = new Set<Promise<void>>(),
		listeners = new Set<() => void>();
	const notifyUnavailable = () => {
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				/* Revocation cannot be undone by a consumer. */
			}
		}
	};
	const unavailable = () => {
		Atomics.compareExchange(words, 0, 0, 1);
		try {
			port1.postMessage({ kind: "unavailable" });
		} catch {
			/* Already fenced. */
		}
		notifyUnavailable();
	};
	state.lossListeners.add(unavailable);
	const quarantineTimedOutFollower = () => {
		if (quarantined) return true;
		if (
			closing ||
			released ||
			state.lost ||
			!ticket.active ||
			lastId === 0 ||
			Atomics.load(words, 1) !== lastId ||
			readRestoreRuntimeWorkerLoss(words) !== "worker-proof-timeout"
		)
			return false;
		// The follower has already fenced itself. Never clear that fence or
		// answer its late proofs; its consumer must physically join the worker.
		// A delayed reply did not disprove this independent native owner. Any
		// new operation/bridge still needs its own current ownership proof.
		quarantined = true;
		notifyUnavailable();
		return true;
	};
	const check = () => {
		// Closing revokes this bridge, not the parent's genuine native owner.
		// Join in-flight proofs without sending a response or inventing loss.
		if (closing || quarantined || quarantineTimedOutFollower()) return false;
		if (released || !ticket.active || state.lost || Atomics.load(words, 0) !== 0)
			throw new RestoreRuntimeAdmissionError();
		return true;
	};
	port1.on("message", (message: unknown) => {
		if (closing || quarantined) return;
		if (typeof message !== "object" || message === null) {
			state.lose("worker-proof-invalid");
			return;
		}
		const value = message as { kind?: unknown; id?: unknown; reason?: unknown };
		if (value.kind === "released") {
			released = true;
			return;
		}
		if (value.kind === "unavailable") {
			if (value.reason === "worker-proof-timeout" && quarantineTimedOutFollower()) return;
			state.lose(sanitizeRestoreRuntimeLossReason(value.reason));
			return;
		}
		const id = value.id;
		if (
			(value.kind !== "proof" && value.kind !== "owner-proof") ||
			typeof id !== "number" ||
			!Number.isSafeInteger(id) ||
			id <= lastId ||
			id > 2147483647
		) {
			state.lose("worker-proof-invalid");
			return;
		}
		lastId = id;
		const operation = Promise.resolve()
			.then(async () => {
				if (!check()) return;
				if (Atomics.load(words, 1) !== id) throw new RestoreRuntimeAdmissionError();
				let live = record;
				if (value.kind === "owner-proof") {
					// The actual writer separately validates journal and binding on its
					// own connection. Reading its main file here can deadlock permission
					// to COMMIT when DELETE-mode spilling holds EXCLUSIVE.
					await state.backend.assertOwned();
					if (
						state.phase !== record.phase ||
						state.epoch !== record.runtimeEpoch ||
						(state.phase === "running" &&
							state.destinationInstallationId !== record.destinationInstallationId)
					)
						throw new RestoreRuntimeAdmissionError();
				} else {
					await assertCurrent(state);
					live = await state.backend.read();
				}
				if (!check()) return;
				if (Atomics.load(words, 1) !== id) throw new RestoreRuntimeAdmissionError();
				port1.postMessage({ kind: "proof", id, databaseUrl: state.databaseUrl, record: live });
			})
			.catch((error) => {
				if (error instanceof RestoreRuntimeContentionError) {
					try {
						if (!check()) return;
						port1.postMessage({ kind: "busy", id, databaseUrl: state.databaseUrl });
						return;
					} catch {
						/* Broken native proof channel is terminal. */
					}
				}
				// The child fences synchronously before sending its reason over IPC.
				// Preserve that closed first cause if this proof observes it first.
				if (quarantineTimedOutFollower()) return;
				state.lose(readRestoreRuntimeWorkerLoss(words) ?? "worker-proof-failed");
			});
		pending.add(operation);
		void operation.finally(() => {
			pending.delete(operation);
		});
	});
	port1.on("close", () => {
		if (!closing && !released && !quarantined) state.lose("worker-channel-unavailable");
	});
	port1.on("messageerror", () => {
		if (!closing && !quarantined) state.lose("worker-channel-unavailable");
	});
	let closePromise: Promise<void> | undefined;
	return Object.freeze({
		binding: Object.freeze({ databaseUrl: state.databaseUrl, record, port: port2, fence }),
		onUnavailable: (listener: () => void) => {
			listeners.add(listener);
			if (state.lost || Atomics.load(words, 0) !== 0) listener();
			return () => {
				listeners.delete(listener);
			};
		},
		close: () =>
			(closePromise ??= Promise.resolve().then(async () => {
				closing = true;
				Atomics.store(words, 0, 1);
				state.lossListeners.delete(unavailable);
				port1.close();
				port2.close();
				await Promise.all([...pending]);
				listeners.clear();
			})),
	});
}

/** Native follower admission. No enrollment, reconciliation or control writes are permitted. */
export async function openRestoreRuntimeWorker(
	value: unknown,
	databaseUrl: string,
): Promise<Readonly<RestoreRuntime>> {
	if (
		typeof value !== "object" ||
		value === null ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw new RestoreRuntimeAdmissionError();
	const keys = ["databaseUrl", "record", "port", "fence"];
	if (
		Reflect.ownKeys(value).length !== keys.length ||
		keys.some((key) => !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))
	)
		throw new RestoreRuntimeAdmissionError();
	const binding = value as RestoreRuntimeWorkerBinding;
	if (
		!(binding.port instanceof MessagePort) ||
		!(binding.fence instanceof SharedArrayBuffer) ||
		binding.fence.byteLength !== 8
	)
		throw new RestoreRuntimeAdmissionError();
	const port = binding.port,
		words = new Int32Array(binding.fence);
	let state: RuntimeState | undefined,
		lost = false,
		closing = false,
		sequence = 0;
	let wait:
		| {
				id: number;
				resolve(record: Readonly<RestoreRuntimeRecord>): void;
				reject(error?: Error): void;
		  }
		| undefined;
	const lose = (reason?: RestoreRuntimeLossReason) => {
		if (lost) return;
		lost = true;
		recordRestoreRuntimeWorkerLoss(words, sanitizeRestoreRuntimeLossReason(reason));
		if (state) {
			state.lost = true;
			state.startingAdmission = false;
			state.ordinaryAdmission = false;
			for (const listener of state.lossListeners) listener();
		}
		wait?.reject();
		try {
			port.postMessage({ kind: "unavailable", reason: sanitizeRestoreRuntimeLossReason(reason) });
		} catch {
			/* Terminal latch persists. */
		}
	};
	const available = () => {
		if (lost || closing || Atomics.load(words, 0) !== 0) {
			lose();
			throw new RestoreRuntimeAdmissionError();
		}
	};
	let initial: Readonly<RestoreRuntimeRecord>;
	const matches = (record: Readonly<RestoreRuntimeRecord>) => {
		if (
			record.runtimeEpoch !== initial.runtimeEpoch ||
			record.ownerBackendPid !== null ||
			record.phase !== initial.phase ||
			record.destinationInstallationId !== initial.destinationInstallationId
		)
			throw new RestoreRuntimeAdmissionError();
	};
	port.on("message", (message: unknown) => {
		try {
			available();
			if (typeof message !== "object" || message === null) throw new RestoreRuntimeAdmissionError();
			const response = message as {
				kind?: unknown;
				id?: unknown;
				record?: unknown;
				databaseUrl?: unknown;
			};
			if (
				(response.kind !== "proof" && response.kind !== "busy") ||
				response.id !== wait?.id ||
				response.databaseUrl !== binding.databaseUrl
			)
				throw new RestoreRuntimeAdmissionError();
			if (response.kind === "busy") {
				wait!.reject(new RestoreRuntimeContentionError());
				return;
			}
			const record = parseRestoreRuntimeRecord(response.record);
			matches(record);
			wait!.resolve(record);
		} catch {
			lose("worker-proof-invalid");
		}
	});
	port.on("close", () => {
		if (!closing) lose("worker-channel-unavailable");
	});
	port.on("messageerror", () => lose("worker-channel-unavailable"));
	let proofs = Promise.resolve();
	const read = (ownerOnly = false): Promise<Readonly<RestoreRuntimeRecord>> => {
		const result = proofs.then(async () => {
			available();
			if (++sequence > 2147483647) {
				lose();
				throw new RestoreRuntimeAdmissionError();
			}
			Atomics.store(words, 1, sequence);
			const record = await new Promise<Readonly<RestoreRuntimeRecord>>((resolve, reject) => {
				const timer = setTimeout(() => {
					lose("worker-proof-timeout");
				}, 5000);
				wait = {
					id: sequence,
					resolve: (record) => {
						clearTimeout(timer);
						wait = undefined;
						resolve(record);
					},
					reject: (error = new RestoreRuntimeAdmissionError()) => {
						clearTimeout(timer);
						wait = undefined;
						reject(error);
					},
				};
				try {
					port.postMessage({ kind: ownerOnly ? "owner-proof" : "proof", id: sequence });
				} catch {
					lose("worker-channel-unavailable");
				}
			});
			available();
			return record;
		});
		proofs = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	let participation: Awaited<ReturnType<typeof acquireSqliteRestoreOperationLock>> | undefined;
	try {
		initial = parseRestoreRuntimeRecord(binding.record);
		if (
			!initial.runtimeEpoch ||
			initial.ownerBackendPid !== null ||
			(initial.phase !== "starting" && initial.phase !== "running") ||
			binding.databaseUrl !== databaseUrl ||
			typeof databaseUrl !== "string" ||
			!databaseUrl.startsWith("file:")
		)
			throw new RestoreRuntimeAdmissionError();
		await read();
		const storage = resolveSqliteRestoreStorage(databaseUrl);
		if (`file:${storage.databasePath}` !== binding.databaseUrl)
			throw new RestoreRuntimeAdmissionError();
		participation = await acquireSqliteRestoreOperationLock(databaseUrl);
		available();
		storage.assertUnchanged();
		const backend: Backend = {
			databaseUrl,
			ownerBackendPid: null,
			assertAvailable: available,
			assertOwned: async () => {
				available();
				await read(true);
				await participation!.assertHeld();
				storage.assertUnchanged();
				available();
			},
			validateSqliteBinding: (record) => {
				available();
				assertSqliteRestoreRuntimeBindingRecord(storage, record);
			},
			read: () => read(),
			mutate: async () => {
				throw new RestoreRuntimeAdmissionError();
			},
			close: async () => {
				await proofs;
				await participation!.close();
				closing = true;
				port.postMessage({ kind: "released" });
				port.close();
			},
		};
		return await createRuntimeActor(
			backend,
			initial.runtimeEpoch,
			{
				lost: () => lost,
				lose,
				bind: (owned) => {
					state = owned;
				},
			},
			initial,
		);
	} catch (error) {
		if (!(error instanceof RestoreRuntimeContentionError)) lose();
		try {
			await participation?.close();
		} finally {
			closing = true;
			if (error instanceof RestoreRuntimeContentionError) port.postMessage({ kind: "released" });
			port.close();
		}
		throw new RestoreRuntimeAdmissionError();
	}
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel, MessagePort } from "node:worker_threads";
import Database from "better-sqlite3";
import { Client } from "pg";
import { assertPreparedRestorePublication } from "./backup-database.js";
import {
	acquirePostgresRestoreRuntimeOwnership,
	type PostgresRestoreRuntimeOwnership,
	RESTORE_POSTGRES_LOCK_NAMESPACE,
	RESTORE_POSTGRES_OPERATION_LOCK,
	RESTORE_POSTGRES_OWNER_LOCK,
} from "./restore-runtime-postgres.js";
import {
	type PostgresRuntimeNamespace,
	parsePostgresRuntimeUrl,
	selectPostgresRuntimeNamespace,
} from "./restore-runtime-postgres-namespace.js";
import { acquireSqliteRestoreOperationLock } from "./restore-runtime-sqlite.js";
import {
	assertSqliteRestoreRuntimeBindingRecord,
	assertSqliteRestoreRuntimeStorageBinding,
	enrollSqliteRestoreRuntimeStorage,
	parseSqliteRestoreRuntimeRecord,
} from "./restore-runtime-sqlite-enrollment.js";
import { resolveSqliteRestoreStorage } from "./restore-runtime-sqlite-storage.js";
import {
	parseRestoreRuntimeRecord,
	prepareRestoreRuntimeCommitRecord,
	prepareRestoreRuntimeStartingRecord,
	type RestoreRuntimeCommitRequest,
	type RestoreRuntimeRecord,
} from "./restore-runtime-state.js";
