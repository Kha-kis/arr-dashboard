const STAGES = [
	"schema",
	"runtime-open",
	"settings",
	"server-build",
	"listen",
	"handoff",
	"running",
	"unknown",
] as const;
export type ApiStartupStage = (typeof STAGES)[number];
const stages = new Set<unknown>(STAGES);

// Exact codes only: a matching prefix may contain private or unbounded text.
const CODE_CATEGORIES = {
	SQLITE_BUSY: "database",
	SQLITE_LOCKED: "database",
	SQLITE_CORRUPT: "database",
	SQLITE_NOTADB: "database",
	SQLITE_ERROR: "database",
	SQLITE_CONSTRAINT: "database",
	SQLITE_CONSTRAINT_UNIQUE: "database",
	SQLITE_CONSTRAINT_PRIMARYKEY: "database",
	SQLITE_CONSTRAINT_FOREIGNKEY: "database",
	SQLITE_CONSTRAINT_NOTNULL: "database",
	SQLITE_CONSTRAINT_CHECK: "database",
	P1000: "database",
	P1001: "database",
	P1008: "database",
	P2002: "database",
	P2003: "database",
	P2010: "database",
	P2021: "schema",
	P2022: "schema",
	P2023: "database",
	P2024: "database",
	P2025: "database",
	EACCES: "filesystem",
	EPERM: "filesystem",
	ENOENT: "filesystem",
	ENOSPC: "filesystem",
	EMFILE: "filesystem",
	EADDRINUSE: "bind",
	EADDRNOTAVAIL: "bind",
	ECONNREFUSED: "network",
	ETIMEDOUT: "network",
	EAI_AGAIN: "network",
	FST_ERR_PLUGIN_TIMEOUT: "framework",
	FST_ERR_DEC_ALREADY_PRESENT: "framework",
	FST_ERR_DEC_MISSING_DEPENDENCY: "framework",
	FST_ERR_PLUGIN_NOT_VALID: "framework",
	FST_ERR_PLUGIN_VERSION_MISMATCH: "framework",
} as const;

// Keep this module independent of runtime/database imports and their side effects.
const NAME_CATEGORIES = {
	RestoreRuntimeAdmissionError: "runtime-admission",
	RestoreRuntimeStateError: "runtime-state",
	SqliteRestoreStorageUnavailableError: "storage-identity",
	SqliteDockerMountRequiredError: "sqlite-mount-required",
	SqliteRestoreRuntimeEnrollmentError: "storage-identity",
	RestoreRuntimeOwnershipError: "storage-ownership",
	SqliteRestoreRuntimeOwnershipError: "storage-ownership",
	RuntimeSchemaStartupError: "schema",
	RuntimeSchemaRegistryError: "schema",
	RuntimeSchemaPlanError: "schema",
	SqliteDateCompatibilityError: "schema",
	PrismaClientKnownRequestError: "database",
	PrismaClientUnknownRequestError: "database",
	PrismaClientInitializationError: "database",
	PrismaClientRustPanicError: "database",
	PrismaClientValidationError: "validation",
	ZodError: "validation",
	TypeError: "type",
	RangeError: "range",
} as const;

type StartupErrorCode = keyof typeof CODE_CATEGORIES;
type StartupErrorCategory =
	| (typeof CODE_CATEGORIES)[StartupErrorCode]
	| (typeof NAME_CATEGORIES)[keyof typeof NAME_CATEGORIES]
	| "unknown";
type ApiStartupDiagnostic = Readonly<{
	category: "api-startup-failure";
	stage: ApiStartupStage;
	errorCategory: StartupErrorCategory;
	code: StartupErrorCode | null;
}>;

function readDataString(error: object, key: "code" | "name"): string | undefined {
	let descriptor = Object.getOwnPropertyDescriptor(error, key);
	if (!descriptor) {
		const prototype = Object.getPrototypeOf(error);
		if (prototype !== null) descriptor = Object.getOwnPropertyDescriptor(prototype, key);
	}
	return descriptor && "value" in descriptor && typeof descriptor.value === "string"
		? descriptor.value
		: undefined;
}

/** A closed projection for logs; never inspect error text, causes, or other metadata. */
export function getApiStartupDiagnostic(stage: unknown, error: unknown): ApiStartupDiagnostic {
	let code: StartupErrorCode | null = null;
	let errorCategory: StartupErrorCategory = "unknown";
	try {
		if (typeof error === "object" && error !== null) {
			const rawCode = readDataString(error, "code");
			const name = readDataString(error, "name");
			if (rawCode !== undefined && Object.hasOwn(CODE_CATEGORIES, rawCode)) {
				code = rawCode as StartupErrorCode;
				errorCategory = CODE_CATEGORIES[code];
			}
			if (name !== undefined && Object.hasOwn(NAME_CATEGORIES, name)) {
				const nameCategory = NAME_CATEGORIES[name as keyof typeof NAME_CATEGORIES];
				// Preserve runtime boundaries, but let a specific code refine generic database names.
				if (code === null || nameCategory !== "database") errorCategory = nameCategory;
			}
		}
	} catch {
		// Reflection on a revoked or hostile Proxy is itself untrusted.
		code = null;
		errorCategory = "unknown";
	}
	return Object.freeze({
		category: "api-startup-failure",
		stage: stages.has(stage) ? (stage as ApiStartupStage) : "unknown",
		errorCategory,
		code,
	});
}

/** Diagnostic delivery must never prevent the caller's failure drain. */
export function writeApiStartupDiagnostic(diagnostic: ApiStartupDiagnostic): void {
	try {
		writeSync(2, `Failed to start API server\n${JSON.stringify({ level: 50, ...diagnostic })}\n`);
		if (diagnostic.errorCategory === "sqlite-mount-required") {
			writeSync(
				2,
				"Docker SQLite requires a separate writable local directory mount. Retain this mount across replacements. Preserve any existing container and appdata before changing mounts. See docs/SQLITE-STORAGE.md.\n",
			);
		}
	} catch {
		/* Diagnostic delivery cannot replace the failure shutdown. */
	}
}

import { writeSync } from "node:fs";
