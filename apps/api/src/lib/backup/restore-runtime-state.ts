export type RestoreRuntimePhase =
	| "idle"
	| "starting"
	| "running"
	| "restore-pending"
	| "restart-required";

export interface RestoreRuntimeRecord {
	id: 1;
	protocolVersion: 1;
	phase: RestoreRuntimePhase;
	runtimeEpoch: string | null;
	ownerBackendPid: number | null;
	activeRestoreId: string | null;
	lastCommittedRestoreId: string | null;
	lastCommittedAt: string | null;
	destinationInstallationId: string | null;
}

export interface RestoreRuntimeCommitRequest {
	runtimeEpoch: string;
	restoreId: string;
	destinationInstallationId: string;
	committedAt: Date | string;
}

export interface RestoreRuntimeStartingRequest {
	runtimeEpoch: string;
	ownerBackendPid: number | null;
}

export type RecoveryCategory = "no-pending-restore" | "not-committed" | "committed" | "unavailable";

export class RestoreRuntimeStateError extends Error {
	constructor() {
		super("Restore runtime state is unavailable.");
		this.name = "RestoreRuntimeStateError";
	}
}

const RECORD_FIELDS = [
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
const REQUEST_FIELDS = [
	"runtimeEpoch",
	"restoreId",
	"destinationInstallationId",
	"committedAt",
] as const;
const STARTING_FIELDS = ["runtimeEpoch", "ownerBackendPid"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read only an exact plain data projection; never invoke input accessors. */
function readFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null) throw new RestoreRuntimeStateError();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new RestoreRuntimeStateError();
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== fields.length ||
		keys.some((key) => typeof key !== "string" || !fields.includes(key))
	) {
		throw new RestoreRuntimeStateError();
	}
	return Object.fromEntries(
		fields.map((field) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			if (!descriptor || !("value" in descriptor)) throw new RestoreRuntimeStateError();
			return [field, descriptor.value];
		}),
	);
}

function parseUuid(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) {
		throw new RestoreRuntimeStateError();
	}
	return value;
}

function parseIdentity(value: unknown): string | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		value.length > 256 ||
		value.trim().length === 0 ||
		/\p{Cc}/u.test(value)
	) {
		throw new RestoreRuntimeStateError();
	}
	return value;
}

function parseTimestamp(value: unknown): string | null {
	if (value === null) return null;
	if (value instanceof Date) return Date.prototype.toISOString.call(value);
	if (typeof value !== "string") throw new RestoreRuntimeStateError();
	const canonical = new Date(value).toISOString();
	if (canonical !== value) throw new RestoreRuntimeStateError();
	return canonical;
}

function parsePhase(value: unknown): RestoreRuntimePhase {
	switch (value) {
		case "idle":
		case "starting":
		case "running":
		case "restore-pending":
		case "restart-required":
			return value;
		default:
			throw new RestoreRuntimeStateError();
	}
}

function parsePid(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) {
		throw new RestoreRuntimeStateError();
	}
	return value;
}

/** A valid row is immutable evidence, not proof of a live provider-held owner. */
export function parseRestoreRuntimeRecord(value: unknown): Readonly<RestoreRuntimeRecord> {
	try {
		const fields = readFields(value, RECORD_FIELDS);
		if (fields.id !== 1 || fields.protocolVersion !== 1) throw new RestoreRuntimeStateError();
		const record: RestoreRuntimeRecord = {
			id: 1,
			protocolVersion: 1,
			phase: parsePhase(fields.phase),
			runtimeEpoch: parseUuid(fields.runtimeEpoch),
			ownerBackendPid: parsePid(fields.ownerBackendPid),
			activeRestoreId: parseUuid(fields.activeRestoreId),
			lastCommittedRestoreId: parseUuid(fields.lastCommittedRestoreId),
			lastCommittedAt: parseTimestamp(fields.lastCommittedAt),
			destinationInstallationId: parseIdentity(fields.destinationInstallationId),
		};
		const hasMarker = record.lastCommittedRestoreId !== null;
		if (
			hasMarker !== (record.lastCommittedAt !== null) ||
			(hasMarker && record.destinationInstallationId === null)
		) {
			throw new RestoreRuntimeStateError();
		}
		if (record.phase === "idle") {
			if (
				record.runtimeEpoch !== null ||
				record.ownerBackendPid !== null ||
				record.activeRestoreId !== null
			) {
				throw new RestoreRuntimeStateError();
			}
		} else if (record.runtimeEpoch === null) {
			throw new RestoreRuntimeStateError();
		}
		if (
			(record.phase === "starting" || record.phase === "running") &&
			record.activeRestoreId !== null
		) {
			throw new RestoreRuntimeStateError();
		}
		if (record.phase === "running" && record.destinationInstallationId === null) {
			throw new RestoreRuntimeStateError();
		}
		if (record.phase === "restore-pending" || record.phase === "restart-required") {
			if (record.activeRestoreId === null || record.destinationInstallationId === null) {
				throw new RestoreRuntimeStateError();
			}
		}
		if (
			record.phase === "restart-required" &&
			record.activeRestoreId !== record.lastCommittedRestoreId
		) {
			throw new RestoreRuntimeStateError();
		}
		return Object.freeze(record);
	} catch {
		// Never retain database rows, identifiers or a dependency's raw failure.
		throw new RestoreRuntimeStateError();
	}
}

/** Caller must independently establish quiescence before acting on this category. */
export function classifyRestoreRuntimeRecovery(
	value: unknown,
	currentDestinationInstallationId: string,
): RecoveryCategory {
	try {
		const record = parseRestoreRuntimeRecord(value);
		const identity = parseIdentity(currentDestinationInstallationId);
		if (identity === null || identity !== record.destinationInstallationId) return "unavailable";
		if (record.activeRestoreId === null) return "no-pending-restore";
		return record.activeRestoreId === record.lastCommittedRestoreId ? "committed" : "not-committed";
	} catch {
		return "unavailable";
	}
}

/** Native owner and actor exclusion must already be held by the caller. */
export function prepareRestoreRuntimeStartingRecord(
	value: unknown,
	request: RestoreRuntimeStartingRequest,
): Readonly<RestoreRuntimeRecord> {
	try {
		const current = parseRestoreRuntimeRecord(value);
		const fields = readFields(request, STARTING_FIELDS);
		const runtimeEpoch = parseUuid(fields.runtimeEpoch);
		const ownerBackendPid = parsePid(fields.ownerBackendPid);
		if (runtimeEpoch === null || runtimeEpoch === current.runtimeEpoch) {
			throw new RestoreRuntimeStateError();
		}
		// A positive old marker is never replayed or cleared. Only the obsolete
		// attempt is retired after the caller independently establishes quiescence.
		return parseRestoreRuntimeRecord({
			...current,
			phase: "starting",
			runtimeEpoch,
			ownerBackendPid,
			activeRestoreId: null,
		});
	} catch {
		throw new RestoreRuntimeStateError();
	}
}

/** For explicit cold initialization only; this pure value grants no ownership. */
export function createInitialRestoreRuntimeRecord(
	request: RestoreRuntimeStartingRequest,
): Readonly<RestoreRuntimeRecord> {
	return prepareRestoreRuntimeStartingRecord(
		{
			id: 1,
			protocolVersion: 1,
			phase: "idle",
			runtimeEpoch: null,
			ownerBackendPid: null,
			activeRestoreId: null,
			lastCommittedRestoreId: null,
			lastCommittedAt: null,
			destinationInstallationId: null,
		},
		request,
	);
}

/** Prepare a marker; only its surrounding database transaction can commit it. */
export function prepareRestoreRuntimeCommitRecord(
	value: unknown,
	request: RestoreRuntimeCommitRequest,
): Readonly<RestoreRuntimeRecord> {
	try {
		const record = parseRestoreRuntimeRecord(value);
		const fields = readFields(request, REQUEST_FIELDS);
		const runtimeEpoch = parseUuid(fields.runtimeEpoch);
		const restoreId = parseUuid(fields.restoreId);
		const identity = parseIdentity(fields.destinationInstallationId);
		const committedAt = parseTimestamp(fields.committedAt);
		if (
			record.phase !== "restore-pending" ||
			runtimeEpoch !== record.runtimeEpoch ||
			restoreId !== record.activeRestoreId ||
			identity !== record.destinationInstallationId ||
			committedAt === null
		) {
			throw new RestoreRuntimeStateError();
		}
		return Object.freeze({
			...record,
			phase: "restart-required",
			lastCommittedRestoreId: restoreId,
			lastCommittedAt: committedAt,
		});
	} catch {
		throw new RestoreRuntimeStateError();
	}
}
