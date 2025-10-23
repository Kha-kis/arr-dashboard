/**
 * Profile Diff Service - Stub Implementation
 * Computes differences between quality profile sets
 */

export interface DiffResult<T = unknown> {
	added: T[];
	removed: T[];
	modified: Array<{ before: T; after: T }>;
	unchanged: T[];
}

/**
 * Compare two arrays of profiles/items and return structured diff
 * Uses id or name as unique key, falls back to JSON comparison
 */
export function diffProfiles<T extends { id?: number | string; name?: string }>(
	before: T[] = [],
	after: T[] = [],
): DiffResult<T> {
	const keyOf = (x: T) => String(x.id ?? x.name ?? JSON.stringify(x));
	const beforeMap = new Map(before.map((x) => [keyOf(x), x]));
	const afterMap = new Map(after.map((x) => [keyOf(x), x]));

	const added: T[] = [];
	const removed: T[] = [];
	const modified: Array<{ before: T; after: T }> = [];
	const unchanged: T[] = [];

	// Check after items
	for (const [k, v] of afterMap) {
		if (!beforeMap.has(k)) {
			added.push(v);
		} else if (JSON.stringify(beforeMap.get(k)) !== JSON.stringify(v)) {
			modified.push({ before: beforeMap.get(k) as T, after: v });
		} else {
			unchanged.push(v);
		}
	}

	// Check for removed items
	for (const [k, v] of beforeMap) {
		if (!afterMap.has(k)) {
			removed.push(v);
		}
	}

	return { added, removed, modified, unchanged };
}
