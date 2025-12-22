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
