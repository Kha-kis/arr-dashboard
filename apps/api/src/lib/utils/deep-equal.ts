/**
 * Deep equality comparison utility
 *
 * Performs a stable deep comparison of two values, handling:
 * - Primitives (string, number, boolean, null, undefined)
 * - Objects with different key ordering (string and symbol keys)
 * - Arrays (order-sensitive)
 * - Nested structures
 * - Date objects
 * - RegExp objects
 * - Map objects (key equality via has(), value equality via deepEqual)
 * - Set objects (order-insensitive, value equality via deepEqual)
 * - Symbol keys (using strict equality for symbol comparison)
 * - Circular references (tracked via WeakSet to prevent infinite recursion)
 */

/**
 * Checks if two values are deeply equal
 * Unlike JSON.stringify comparison, this handles:
 * - Different object key ordering
 * - Special types (Date, RegExp)
 * - Circular reference detection (using WeakSet tracking)
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	return deepEqualInternal(a, b, new WeakSet(), new WeakSet());
}

/**
 * Internal recursive comparator with cycle tracking
 */
function deepEqualInternal(
	a: unknown,
	b: unknown,
	seenA: WeakSet<object>,
	seenB: WeakSet<object>
): boolean {
	// Strict equality check (handles primitives and same reference)
	if (a === b) {
		return true;
	}

	// Handle null/undefined
	if (a === null || b === null || a === undefined || b === undefined) {
		return a === b;
	}

	// Type check
	const typeA = typeof a;
	const typeB = typeof b;
	if (typeA !== typeB) {
		return false;
	}

	// Handle non-object types (primitives already handled by ===)
	if (typeA !== "object") {
		return false;
	}

	// At this point, both are objects (including arrays)
	const objA = a as Record<string, unknown>;
	const objB = b as Record<string, unknown>;

	// Circular reference detection: if we've seen both objects before at the same
	// structural position, consider them equal to prevent infinite recursion
	if (seenA.has(objA) && seenB.has(objB)) {
		return true;
	}

	// Track these objects as visited before recursing
	seenA.add(objA);
	seenB.add(objB);

	// Handle Date objects
	if (objA instanceof Date && objB instanceof Date) {
		return objA.getTime() === objB.getTime();
	}
	if (objA instanceof Date || objB instanceof Date) {
		return false;
	}

	// Handle RegExp objects
	if (objA instanceof RegExp && objB instanceof RegExp) {
		return objA.toString() === objB.toString();
	}
	if (objA instanceof RegExp || objB instanceof RegExp) {
		return false;
	}

	// Handle Map objects
	const isMapA = objA instanceof Map;
	const isMapB = objB instanceof Map;
	if (isMapA !== isMapB) {
		return false;
	}
	if (isMapA && isMapB) {
		const mapA = objA as Map<unknown, unknown>;
		const mapB = objB as Map<unknown, unknown>;
		if (mapA.size !== mapB.size) {
			return false;
		}
		for (const [key, valueA] of mapA) {
			if (!mapB.has(key)) {
				return false;
			}
			if (!deepEqualInternal(valueA, mapB.get(key), seenA, seenB)) {
				return false;
			}
		}
		return true;
	}

	// Handle Set objects (order-insensitive comparison)
	const isSetA = objA instanceof Set;
	const isSetB = objB instanceof Set;
	if (isSetA !== isSetB) {
		return false;
	}
	if (isSetA && isSetB) {
		const setA = objA as Set<unknown>;
		const setB = objB as Set<unknown>;
		if (setA.size !== setB.size) {
			return false;
		}
		// For each value in setA, find a matching value in setB using deepEqual
		for (const valueA of setA) {
			let found = false;
			for (const valueB of setB) {
				if (deepEqualInternal(valueA, valueB, seenA, seenB)) {
					found = true;
					break;
				}
			}
			if (!found) {
				return false;
			}
		}
		return true;
	}

	// Handle arrays
	const isArrayA = Array.isArray(objA);
	const isArrayB = Array.isArray(objB);
	if (isArrayA !== isArrayB) {
		return false;
	}
	if (isArrayA && isArrayB) {
		const arrA = objA as unknown[];
		const arrB = objB as unknown[];
		if (arrA.length !== arrB.length) {
			return false;
		}
		for (let i = 0; i < arrA.length; i++) {
			if (!deepEqualInternal(arrA[i], arrB[i], seenA, seenB)) {
				return false;
			}
		}
		return true;
	}

	// Handle plain objects - compare keys regardless of order
	// Collect both string keys and symbol keys
	const stringKeysA = Object.keys(objA);
	const stringKeysB = Object.keys(objB);
	const symbolKeysA = Object.getOwnPropertySymbols(objA);
	const symbolKeysB = Object.getOwnPropertySymbols(objB);

	// Check total key counts match
	const totalKeysA = stringKeysA.length + symbolKeysA.length;
	const totalKeysB = stringKeysB.length + symbolKeysB.length;
	if (totalKeysA !== totalKeysB) {
		return false;
	}

	// Check string key counts match
	if (stringKeysA.length !== stringKeysB.length) {
		return false;
	}

	// Check symbol key counts match
	if (symbolKeysA.length !== symbolKeysB.length) {
		return false;
	}

	// Order-independent string key comparison using Set
	const stringKeySetB = new Set(stringKeysB);
	for (const key of stringKeysA) {
		if (!stringKeySetB.has(key)) {
			return false;
		}
	}

	// Order-independent symbol key comparison using strict equality
	// Every symbol in A must exist in B (symbols are unique, so strict equality required)
	for (const symA of symbolKeysA) {
		let found = false;
		for (const symB of symbolKeysB) {
			if (symA === symB) {
				found = true;
				break;
			}
		}
		if (!found) {
			return false;
		}
	}

	// Check if all string key values are equal
	for (const key of stringKeysA) {
		if (!deepEqualInternal(objA[key], objB[key], seenA, seenB)) {
			return false;
		}
	}

	// Check if all symbol key values are equal
	for (const sym of symbolKeysA) {
		const valA = (objA as Record<symbol, unknown>)[sym];
		const valB = (objB as Record<symbol, unknown>)[sym];
		if (!deepEqualInternal(valA, valB, seenA, seenB)) {
			return false;
		}
	}

	return true;
}
