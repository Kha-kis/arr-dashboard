import { performance } from "node:perf_hooks";
import pino, { type Logger } from "pino";

const failureOnlyPhases = [
	"schema-registry",
	"startup-record",
	"database-file",
	"storage-resolution",
	"database-open",
	"descriptor-identity",
	"database-configuration",
	"exclusive-transaction-begin",
	"enrollment-catalog-read",
	"cold-enrollment-check",
	"enrollment-intent-commit",
	"enrollment-object-checkpoint",
	"coordination-enrollment",
	"storage-binding-validation",
	"startup-journal-validation",
	"ownership-acquire",
	"ownership-exclusive",
	"pre-apply-ownership",
	"rollback",
	"database-close",
	"ownership-close",
] as const;

type SqliteStartupPhase =
	| (typeof failureOnlyPhases)[number]
	| "catalog-preflight"
	| "schema-plan"
	| "date-plan"
	| "oidc-migration"
	| "schema-apply"
	| "catalog-postflight"
	| "date-apply"
	| "foreign-key-check"
	| "commit"
	| "total";

let diagnosticLogger: Pick<Logger, "info"> | undefined;

const FILESYSTEM_CODES = new Set([
	"EACCES",
	"EPERM",
	"ENOENT",
	"ENOSPC",
	"EMFILE",
	"EIO",
	"EROFS",
	"ENOTDIR",
	"EISDIR",
]);
const SQLITE_CODES = new Set([
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"SQLITE_CANTOPEN",
	"SQLITE_PERM",
	"SQLITE_READONLY",
	"SQLITE_IOERR",
	"SQLITE_FULL",
	"SQLITE_CORRUPT",
	"SQLITE_NOTADB",
	"SQLITE_ERROR",
	"SQLITE_IOERR_FSTAT",
	"SQLITE_IOERR_LOCK",
	"SQLITE_IOERR_SHMOPEN",
	"SQLITE_CANTOPEN_FULLPATH",
	"SQLITE_READONLY_CANTLOCK",
	"SQLITE_BUSY_TIMEOUT",
]);
type SafeFailure = Readonly<{
	errorCategory:
		| "filesystem"
		| "database"
		| "schema"
		| "storage-identity"
		| "storage-ownership"
		| "unknown";
	code: string | null;
	refusal?: string;
}>;

const COLD_REFUSALS = new Set([
	"runtime-journal",
	"migration-receipt-table",
	"data-format-receipt",
	"coordination-path",
]);

function safeFailure(error: unknown, phase: SqliteStartupPhase): SafeFailure {
	let rawCode: unknown;
	let name: unknown;
	try {
		if (typeof error === "object" && error !== null) {
			const code = Object.getOwnPropertyDescriptor(error, "code");
			if (code && "value" in code) rawCode = code.value;
			const ownName = Object.getOwnPropertyDescriptor(error, "name");
			const refusal = Object.getOwnPropertyDescriptor(error, "refusal");
			if (
				phase === "cold-enrollment-check" &&
				ownName &&
				"value" in ownName &&
				ownName.value === "RuntimeSchemaStartupError" &&
				refusal &&
				"value" in refusal &&
				typeof refusal.value === "string" &&
				COLD_REFUSALS.has(refusal.value)
			)
				return { errorCategory: "schema", code: null, refusal: refusal.value };
			if (ownName && "value" in ownName) name = ownName.value;
			else {
				const prototype = Object.getPrototypeOf(error);
				const inheritedName =
					prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "name");
				if (inheritedName && "value" in inheritedName) name = inheritedName.value;
			}
		}
	} catch {
		return { errorCategory: "unknown", code: null };
	}
	if (typeof rawCode === "string" && FILESYSTEM_CODES.has(rawCode))
		return { errorCategory: "filesystem", code: rawCode };
	if (typeof rawCode === "string" && SQLITE_CODES.has(rawCode))
		return { errorCategory: "database", code: rawCode };
	if (
		typeof name === "string" &&
		["RuntimeSchemaStartupError", "RuntimeSchemaRegistryError", "RuntimeSchemaPlanError"].includes(
			name,
		)
	)
		return { errorCategory: "schema", code: null };
	if (
		typeof name === "string" &&
		["SqliteRestoreStorageUnavailableError", "SqliteRestoreRuntimeEnrollmentError"].includes(name)
	)
		return { errorCategory: "storage-identity", code: null };
	if (name === "SqliteRestoreRuntimeOwnershipError")
		return { errorCategory: "storage-ownership", code: null };
	return { errorCategory: "unknown", code: null };
}

function report(
	phase: SqliteStartupPhase,
	outcome: "started" | "completed" | "failed",
	began?: number,
	failure?: SafeFailure,
) {
	// These checkpoints add failure detail without increasing normal startup output.
	if (outcome !== "failed" && failureOnlyPhases.some((earlyPhase) => earlyPhase === phase)) return;
	try {
		// Pre-launch stdout is a settings protocol. No app logger/file/worker
		// initialization is safe here; emit only bounded diagnostics on stderr.
		diagnosticLogger ??= pino(
			{ base: null, timestamp: false },
			pino.destination({ dest: 2, sync: true }),
		);
		diagnosticLogger.info({
			category: "sqlite-startup-phase",
			phase,
			outcome,
			elapsedMs:
				began === undefined ? 0 : Math.round(Math.max(0, performance.now() - began) * 1000) / 1000,
			...(failure ? failure : {}),
		});
	} catch {
		// Diagnostics never replace the original startup result or failure.
	}
}

/** Phase events describe diagnostics only. */
export function timeSqliteStartupPhase<T>(phase: SqliteStartupPhase, operation: () => T): T {
	// Native validation can still be running when the supervisor times out.
	if (phase === "schema-plan" || phase === "date-plan" || phase === "foreign-key-check")
		report(phase, "started");
	const began = performance.now();
	let outcome: "completed" | "failed" = "failed";
	let failure: SafeFailure | undefined;
	try {
		const result = operation();
		outcome = "completed";
		return result;
	} catch (error) {
		failure = safeFailure(error, phase);
		throw error;
	} finally {
		report(phase, outcome, began, failure);
	}
}

/** Await actual settlement, including native writer closure for the total. */
export async function timeSqliteStartupPhaseAsync<T>(
	phase: SqliteStartupPhase,
	operation: () => Promise<T>,
): Promise<T> {
	const began = performance.now();
	let outcome: "completed" | "failed" = "failed";
	let failure: SafeFailure | undefined;
	try {
		const result = await operation();
		outcome = "completed";
		return result;
	} catch (error) {
		failure = safeFailure(error, phase);
		throw error;
	} finally {
		report(phase, outcome, began, failure);
	}
}
