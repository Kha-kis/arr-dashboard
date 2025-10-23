/**
 * Type Adapters - Minimal helpers for safe type narrowing
 * No behavior changes, only TypeScript type safety
 */

/**
 * Ensure value is an array
 */
export function ensureArray<T>(val: T | T[] | null | undefined): T[] {
	if (val == null) return [];
	return Array.isArray(val) ? val : [val];
}

/**
 * Convert unknown value to string array
 */
export function toStringArray(val: unknown): string[] {
	if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
	if (typeof val === "string") return [val];
	return [];
}

/**
 * Assert value is defined (throws if null/undefined)
 */
export function assertDefined<T>(v: T | undefined | null, msg = "Unexpected undefined"): asserts v is T {
	if (v == null) throw new Error(msg);
}

/**
 * Check if value is non-empty string
 */
export function isNonEmptyString(x: unknown): x is string {
	return typeof x === "string" && x.length > 0;
}

/**
 * Narrow unknown to Record
 */
export function narrowToRecord(x: unknown): Record<string, unknown> {
	return (x && typeof x === "object") ? (x as Record<string, unknown>) : {};
}

/**
 * Convert unknown to Error for logger
 */
export function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
