/**
 * Shared types for the validation subsystem.
 *
 * Extracted to break the circular dependency between validate-batch.ts
 * and schema-fingerprint.ts.
 */

export interface Logger {
	warn: (msg: string | object, ...args: unknown[]) => void;
	error: (msg: string | object, ...args: unknown[]) => void;
}
