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

/** Param key → readable label: "yearFrom" → "year from", "size_gb" → "size gb". */
function humanizeKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toLowerCase();
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
	//
	// Fix (a): when a kind carries more than ONE value-bearing param, prefix each
	// with its humanized key so the summary is unambiguous — "before · 2020" is
	// clear, but a bare "2020 · 2024" (year_range between) or "10 · 0"
	// (episode_completion percentage/minSeason) is not. Single-value kinds keep
	// the clean value-only form. Keys are structural, so they show in incognito;
	// only VALUES are masked.
	const operator = typeof params.operator === "string" ? humanizeToken(params.operator) : null;
	const valued = Object.entries(params)
		.filter(([key]) => key !== "operator")
		.map(([key, value]) => ({ key, text: formatValue(value, incognito) }))
		.filter((entry) => entry.text.length > 0);
	const keyed = valued.length > 1;
	const rest = valued.map((entry) =>
		keyed ? `${humanizeKey(entry.key)} ${entry.text}` : entry.text,
	);

	return {
		label: humanizeKind(kind),
		summary: [operator, ...rest].filter(Boolean).join(" · "),
	};
}
