/**
 * Tracker brand registry — maps normalized tracker names (parsed from
 * qui's hardlink-mode savePath layout `/data/torrents/links/<tracker>/`)
 * to compact abbreviations and brand colors used in the cluster panel.
 *
 * Normalization rules (applied in `normalizeTrackerName`):
 *   - Lowercase
 *   - Strip parentheticals (e.g., "Blutopia (API)" → "blutopia")
 *   - Strip whitespace and punctuation
 *
 * Abbreviations are 2-3 characters, chosen to match the tracker community's
 * own conventions where possible (BHD for Beyond-HD, HDB for HDBits,
 * ATH for Aither, etc.).
 *
 * Adding a tracker: add a row below with its normalized key + brand metadata.
 * Trackers not in this map fall back to an auto-derived 3-letter slug.
 */

export interface TrackerBrand {
	abbr: string;
	name: string;
	/** Optional hex color for Ship 3 brand-color visuals. Falls back to gray pill. */
	color?: string;
}

const BRANDS: Record<string, TrackerBrand> = {
	"beyond-hd": { abbr: "BHD", name: "Beyond-HD", color: "#9333ea" },
	hdbits: { abbr: "HDB", name: "HDBits", color: "#dc2626" },
	aither: { abbr: "ATH", name: "Aither", color: "#84cc16" },
	blutopia: { abbr: "BLU", name: "Blutopia", color: "#2563eb" },
	luminarr: { abbr: "LUM", name: "Luminarr", color: "#06b6d4" },
	privatehd: { abbr: "PHD", name: "PrivateHD", color: "#1e40af" },
	lst: { abbr: "LST", name: "LST", color: "#f59e0b" },
	fl: { abbr: "FL", name: "TheFL", color: "#7c3aed" },
	ptp: { abbr: "PTP", name: "PassThePopcorn", color: "#ea580c" },
	btn: { abbr: "BTN", name: "BroadcasTheNet", color: "#16a34a" },
	tl: { abbr: "TL", name: "TorrentLeech", color: "#0ea5e9" },
	torrentleech: { abbr: "TL", name: "TorrentLeech", color: "#0ea5e9" },
};

/**
 * Normalize a tracker name from qui's savePath segment to the brand-map key.
 * Idempotent — passing an already-normalized name returns it unchanged.
 */
export function normalizeTrackerName(raw: string | null | undefined): string {
	if (!raw) return "";
	return raw
		.toLowerCase()
		.replace(/\([^)]*\)/g, "") // strip parentheticals
		.replace(/[^a-z0-9-]/g, "") // keep only alphanumerics + hyphen
		.trim();
}

/**
 * Look up a tracker's brand info. Falls back to an auto-derived abbreviation
 * (first 3 characters of the normalized name, uppercased) when the tracker
 * isn't in the registry. Color is left undefined for unknown trackers so the
 * UI uses a neutral pill.
 */
export function getTrackerBrand(raw: string | null | undefined): TrackerBrand {
	const key = normalizeTrackerName(raw);
	const known = BRANDS[key];
	if (known) return known;
	if (!key) return { abbr: "?", name: "Unknown" };
	return {
		abbr: key.slice(0, 3).toUpperCase(),
		name: raw ?? key,
	};
}

/**
 * Scan a list of candidate strings (typically a torrent's savePath-parsed
 * tracker name + its tags) and return the first one that maps to a known
 * brand. Null when none match.
 *
 * This is the right shape for the UI's "what tracker is this?" question:
 * library copies live under `/data/torrents/tv/` with no tracker in the
 * path, but qui usually tags them with the tracker name. By scanning tags
 * AFTER the path-derived tracker, we recover the brand for those cases
 * without misclassifying torrents that legitimately have no tracker tag.
 *
 * Filters out generic non-tracker tags like `cross-seed`, `noHL`, `issue`
 * so they don't poison the search.
 */
const NON_TRACKER_TAGS = new Set(["cross-seed", "nohl", "issue", "permaseed"]);

export function findKnownTracker(
	candidates: Array<string | null | undefined>,
): TrackerBrand | null {
	for (const c of candidates) {
		if (!c) continue;
		const key = normalizeTrackerName(c);
		if (!key || NON_TRACKER_TAGS.has(key)) continue;
		const known = BRANDS[key];
		if (known) return known;
	}
	return null;
}

/**
 * Resolve the best brand for a torrent copy given its savePath-parsed
 * tracker AND its tags. Priority: known brand from any candidate, then
 * auto-derived 3-letter slug from the tracker name, then "?" when there
 * is no signal at all.
 */
export function resolveCopyTrackerBrand(args: {
	tracker: string | null;
	tags: readonly string[];
}): TrackerBrand {
	const known = findKnownTracker([args.tracker, ...args.tags]);
	if (known) return known;
	// Fallback to auto-derived from path-parsed tracker (preserves the
	// existing "?" sentinel when even that's null).
	return getTrackerBrand(args.tracker);
}
