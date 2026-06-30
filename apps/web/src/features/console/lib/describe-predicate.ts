/**
 * Human-readable summaries of v1 rule predicates for the read-only composer
 * viewer. Pure + incognito-aware.
 *
 * No per-kind label map is maintained (52+ kinds): `humanizeKind` derives a
 * label from the kind id, which is stable and good enough for a read surface.
 *
 * Incognito discipline (CLAUDE.md rule 6): a predicate's param VALUES can carry
 * sensitive free text — Plex labels, usernames (`*_watched_by`,
 * `seerr_requested_by`), title/path patterns. On a screenshare those must not
 * leak. So in incognito we mask string values (and string arrays) but keep the
 * rule's STRUCTURE visible — numbers, booleans, and the `operator` are
 * non-sensitive and shown verbatim. Conservative (may mask a benign genre), but
 * always safe-direction.
 */

export const PREDICATE_FIELD_MATCH_KIND = "field_match";
const MASK = "•••";

/** "plex_last_watched" → "Plex last watched". */
export function humanizeKind(kind: string): string {
	const spaced = kind.replace(/_/g, " ").trim();
	if (!spaced) return kind;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Snake/enum token → readable: "older_than" → "older than". */
function humanizeToken(token: string): string {
	return token.replace(/_/g, " ");
}

function formatValue(value: unknown, incognito: boolean): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (Array.isArray(value)) {
		return incognito
			? MASK
			: value
					.map((v) => formatValue(v, false))
					.filter(Boolean)
					.join(", ");
	}
	if (typeof value === "string") {
		// Free-text string value — shown verbatim (it's data: an exact event
		// type, label, title, …), masked in incognito. Only the `operator` key
		// is humanized, and it's handled separately.
		return incognito ? MASK : value;
	}
	return incognito ? MASK : JSON.stringify(value);
}

export interface PredicateDescription {
	/** Human label — the kind, or the matched field for `field_match`. */
	label: string;
	/** Operator + values summary (e.g. "older than · 30"). May be empty. */
	summary: string;
}

export function describePredicate(
	predicate: { kind: string; params: Record<string, unknown> },
	incognito: boolean,
): PredicateDescription {
	const { kind, params } = predicate;

	// Notifications: the predicate's subject is the matched event field.
	if (kind === PREDICATE_FIELD_MATCH_KIND && typeof params.field === "string") {
		const op = typeof params.operator === "string" ? humanizeToken(params.operator) : "";
		const val = formatValue(params.value, incognito);
		return {
			label: params.field,
			summary: [op, val].filter(Boolean).join(" "),
		};
	}

	// Generic: operator first (structural, always shown), then the rest.
	const operator = typeof params.operator === "string" ? humanizeToken(params.operator) : null;
	const rest = Object.entries(params)
		.filter(([key]) => key !== "operator")
		.map(([, value]) => formatValue(value, incognito))
		.filter((part) => part.length > 0);

	return {
		label: humanizeKind(kind),
		summary: [operator, ...rest].filter(Boolean).join(" · "),
	};
}
