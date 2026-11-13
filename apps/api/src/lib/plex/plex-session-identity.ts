/** Preserve opaque string identities; never manufacture an ID by numeric coercion. */
export function normalizePlexSessionUserId(value: unknown): string | null {
	if (typeof value === "string") return value.trim().length > 0 ? value : null;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? String(value)
		: null;
}
