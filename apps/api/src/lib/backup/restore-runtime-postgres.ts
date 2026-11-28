export const RESTORE_POSTGRES_LOCK_NAMESPACE = 1095914052;
export const RESTORE_POSTGRES_OWNER_LOCK = 1;
export const RESTORE_POSTGRES_OPERATION_LOCK = 2;

export class RestoreRuntimeOwnershipError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("Restore runtime ownership is unavailable.");
		this.name = "RestoreRuntimeOwnershipError";
	}
}

export interface PostgresRestoreRuntimeOwnership {
	readonly ownerBackendPid: number;
	assertOwned(): Promise<void>;
	readOwnedRecord(namespace: PostgresRuntimeNamespace): Promise<Readonly<Record<string, unknown>>>;
	tryAcquireExclusive(): Promise<boolean>;
	releaseExclusive(): Promise<void>;
	close(): Promise<void>;
}

/**
 * Provider-held transport only. Every application connection still needs to
 * join operation exclusion; these locks neither initialize the journal nor
 * grant authority to restore records or publish a completed Restore.
 */
export async function acquirePostgresRestoreRuntimeOwnership(
	connectionString: string,
	onUnavailable?: () => void,
): Promise<Readonly<PostgresRestoreRuntimeOwnership>> {
	if (typeof connectionString !== "string" || !/^postgres(ql)?:\/\/\S+$/i.test(connectionString)) {
		throw new RestoreRuntimeOwnershipError();
	}
	let client: Client;
	try {
		client = new Client({
			connectionString,
			connectionTimeoutMillis: 5000,
			query_timeout: 5000,
			statement_timeout: 5000,
			keepAlive: true,
		});
	} catch {
		throw new RestoreRuntimeOwnershipError();
	}
	let unavailable = false;
	let intentionalClose = false;
	let lossSignaled = false;
	let exclusive = false;
	let ownerBackendPid = 0;
	let queue: Promise<void> = Promise.resolve();
	let endPromise: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;

	const endSession = (): Promise<void> => {
		endPromise ??= Promise.resolve()
			.then(() => client.end())
			.catch(() => {
				throw new RestoreRuntimeOwnershipError();
			});
		return endPromise;
	};
	const loseOwnership = (): void => {
		unavailable = true;
		if (!intentionalClose && !lossSignaled) {
			lossSignaled = true;
			try {
				onUnavailable?.();
			} catch {
				// A subscriber cannot undo this permanent latch or expose its cause.
			}
		}
		void endSession().catch(() => {});
	};
	client.on("error", loseOwnership);
	client.on("end", () => {
		if (!intentionalClose) loseOwnership();
	});

	const assertLiveOwner = async (): Promise<void> => {
		const result = await client.query(
			`SELECT pg_backend_pid() AS pid, EXISTS (
				SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
				AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
				AND pid = pg_backend_pid() AND classid = $1::oid AND objid = $2::oid
				AND objsubid = 2 AND granted AND mode = 'ExclusiveLock'
			) AS owned`,
			[RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OWNER_LOCK],
		);
		if (
			unavailable ||
			result.rowCount !== 1 ||
			result.rows[0]?.pid !== ownerBackendPid ||
			result.rows[0]?.owned !== true
		) {
			throw new RestoreRuntimeOwnershipError();
		}
	};
	const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
		if (unavailable) return Promise.reject(new RestoreRuntimeOwnershipError());
		const result = queue.then(async () => {
			if (unavailable) throw new RestoreRuntimeOwnershipError();
			try {
				return await operation();
			} catch {
				loseOwnership();
				throw new RestoreRuntimeOwnershipError();
			}
		});
		queue = result.then(
			() => {},
			() => {},
		);
		return result;
	};

	try {
		await client.connect();
		const result = await client.query(
			"SELECT pg_backend_pid() AS pid, pg_try_advisory_lock($1, $2) AS acquired",
			[RESTORE_POSTGRES_LOCK_NAMESPACE, RESTORE_POSTGRES_OWNER_LOCK],
		);
		const pid: unknown = result.rows[0]?.pid;
		if (
			unavailable ||
			result.rowCount !== 1 ||
			result.rows[0]?.acquired !== true ||
			typeof pid !== "number" ||
			!Number.isInteger(pid) ||
			pid <= 0 ||
			pid > 2147483647
		) {
			throw new RestoreRuntimeOwnershipError();
		}
		ownerBackendPid = pid;
		await assertLiveOwner();
	} catch {
		intentionalClose = true;
		unavailable = true;
		try {
			await endSession();
		} catch {
			// Acquisition failed; a failed close never turns it into ownership.
		}
		throw new RestoreRuntimeOwnershipError();
	}

	return Object.freeze({
		ownerBackendPid,
		assertOwned: () => serialized(assertLiveOwner),
		readOwnedRecord: (namespace: PostgresRuntimeNamespace) =>
			serialized(async () => {
				if (
					!namespace ||
					typeof namespace.name !== "string" ||
					!namespace.name ||
					namespace.name.includes("\0") ||
					!/^\d+$/.test(namespace.oid)
				)
					throw new RestoreRuntimeOwnershipError();
				const columns = [
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
				// The retained owner is outside application transaction snapshots.
				// Combine its existing live-lock proof with a fresh journal read;
				// never open another connection or trust a borrowed snapshot row.
				const result = await client.query(
					`SELECT ${columns.map((column) => (column === "lastCommittedAt" ? `to_char("lastCommittedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCommittedAt"` : `"${column}"`)).join(", ")},
					pg_backend_pid() AS pid,
					EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND granted AND mode='ExclusiveLock') AS owned,
					EXISTS (SELECT 1 FROM pg_namespace WHERE oid=$3::oid AND nspname=$4) AS namespace_matches
					FROM "${namespace.name.replaceAll('"', '""')}"."RestoreRuntimeControl" LIMIT 2`,
					[
						RESTORE_POSTGRES_LOCK_NAMESPACE,
						RESTORE_POSTGRES_OWNER_LOCK,
						namespace.oid,
						namespace.name,
					],
				);
				if (
					unavailable ||
					result.rowCount !== 1 ||
					result.rows[0]?.pid !== ownerBackendPid ||
					result.rows[0]?.owned !== true ||
					result.rows[0]?.namespace_matches !== true
				)
					throw new RestoreRuntimeOwnershipError();
				return Object.freeze(
					Object.fromEntries(columns.map((column) => [column, result.rows[0][column]])),
				);
			}),
		tryAcquireExclusive: () =>
			serialized(async () => {
				await assertLiveOwner();
				if (exclusive) return true;
				const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
					RESTORE_POSTGRES_LOCK_NAMESPACE,
					RESTORE_POSTGRES_OPERATION_LOCK,
				]);
				const acquired: unknown = result.rows[0]?.acquired;
				if (unavailable || result.rowCount !== 1 || typeof acquired !== "boolean") {
					throw new RestoreRuntimeOwnershipError();
				}
				exclusive = acquired;
				return acquired;
			}),
		releaseExclusive: () =>
			serialized(async () => {
				await assertLiveOwner();
				if (!exclusive) return;
				const result = await client.query("SELECT pg_advisory_unlock($1, $2) AS released", [
					RESTORE_POSTGRES_LOCK_NAMESPACE,
					RESTORE_POSTGRES_OPERATION_LOCK,
				]);
				if (unavailable || result.rowCount !== 1 || result.rows[0]?.released !== true) {
					throw new RestoreRuntimeOwnershipError();
				}
				exclusive = false;
			}),
		close: () => {
			if (!closePromise) {
				intentionalClose = true;
				unavailable = true;
				closePromise = queue.then(endSession);
			}
			return closePromise;
		},
	});
}

import { Client } from "pg";
import type { PostgresRuntimeNamespace } from "./restore-runtime-postgres-namespace.js";

/** Database-wide two-int advisory keys; schema aliases must not split ownership. */
