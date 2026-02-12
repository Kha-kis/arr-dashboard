/**
 * Safe JSON parsing utilities
 *
 * Provides error-safe JSON parsing to prevent unhandled exceptions
 * when parsing potentially malformed JSON from database fields or external sources.
 */

/**
 * Safely parse a JSON string, returning a fallback value on error.
 *
 * @param value - The JSON string to parse (can be null/undefined)
 * @param fallback - Value to return if parsing fails (defaults to null)
 * @returns Parsed value or fallback on error
 *
 * @example
 * // Returns parsed object or null
 * const data = safeJsonParse<MyType>(jsonString);
 *
 * @example
 * // Returns parsed array or empty array on error
 * const items = safeJsonParse<Item[]>(jsonString, []);
 */
export function safeJsonParse<T = unknown>(
	value: string | null | undefined,
	fallback: T | null = null,
): T | null {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/**
 * Safely parse a JSON string that is expected to contain an array,
 * filtering elements to only those matching a given type guard.
 *
 * Returns an empty array when:
 * - The input is null/undefined/empty
 * - Parsing fails
 * - The parsed result is not an array
 *
 * @param value - The JSON string to parse
 * @param guard - Type guard to filter elements (required — no unsafe default)
 * @param context - Optional label used for logging on parse failure
 * @param logger - Optional structured logger ({ warn(...) })
 * @param meta - Optional extra fields merged into log entries (e.g. configId, instanceId)
 * @returns Filtered array of elements that pass the guard
 *
 * @example
 * // Parse a string[] array with logging context
 * const patterns = parseJsonArray(json, isString, "customPatterns", log, { configId });
 *
 * @example
 * // Parse a number[] array (no logging)
 * const ids = parseJsonArray(json, isNumber);
 */
export function parseJsonArray<T>(
	value: string | null | undefined,
	guard: (item: unknown) => item is T,
	context?: string,
	logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
	meta?: Record<string, unknown>,
): T[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) {
			if (logger && context) {
				logger.warn(
					{ field: context, type: typeof parsed, value, ...meta },
					`Expected ${context} to be a JSON array, got ${typeof parsed} - using empty array`,
				);
			}
			return [];
		}
		return parsed.filter(guard);
	} catch (error) {
		if (logger && context) {
			logger.warn(
				{ err: error, field: context, value, ...meta },
				`Failed to parse ${context} JSON - using empty array`,
			);
		}
		return [];
	}
}

/** Type guard: value is a string */
export const isString = (v: unknown): v is string => typeof v === "string";

/** Type guard: value is a number */
export const isNumber = (v: unknown): v is number => typeof v === "number";
