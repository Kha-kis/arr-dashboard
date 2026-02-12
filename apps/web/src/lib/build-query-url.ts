/**
 * Shared URL + query-string builder for API client functions.
 *
 * Replaces the duplicated URLSearchParams → conditional interpolation pattern
 * found across dashboard.ts, library/index.ts, tmdb/index.ts, discover.ts,
 * and trash-guides/*.ts.
 */

type ParamValue = string | number | boolean | undefined | null;

/**
 * Build a URL with an optional query string.
 *
 * - Filters out `undefined` and `null` values automatically
 * - Converts numbers and booleans to strings
 * - Returns the bare path when no params survive filtering
 *
 * @example
 * buildQueryUrl("/api/library", { page: 1, search: "foo", tag: undefined })
 * // → "/api/library?page=1&search=foo"
 *
 * buildQueryUrl("/api/dashboard/queue", {})
 * // → "/api/dashboard/queue"
 */
export function buildQueryUrl(
	basePath: string,
	params: Record<string, ParamValue>,
): string {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value != null && value !== "") {
			searchParams.set(key, String(value));
		}
	}
	const query = searchParams.toString();
	return query ? `${basePath}?${query}` : basePath;
}
