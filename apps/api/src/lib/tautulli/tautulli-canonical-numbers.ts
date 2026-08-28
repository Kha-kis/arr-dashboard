const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

/** True only for primitive, canonical, non-negative safe integers. */
export function isCanonicalTautulliNonNegativeSafeInteger(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
	);
}

/** Parse a numeric value or a complete canonical decimal string into the shared domain. */
export function parseCanonicalTautulliNonNegativeSafeInteger(value: unknown): number | null {
	if (typeof value === "number") {
		return isCanonicalTautulliNonNegativeSafeInteger(value) ? value : null;
	}
	if (typeof value !== "string" || !CANONICAL_NON_NEGATIVE_INTEGER.test(value)) return null;
	const parsed = Number(value);
	return isCanonicalTautulliNonNegativeSafeInteger(parsed) ? parsed : null;
}
