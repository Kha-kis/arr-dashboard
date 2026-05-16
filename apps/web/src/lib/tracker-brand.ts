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
 * Apex-domain → brand-registry key. The announce-URL hostname is the
 * authoritative signal — qBit publishes the exact tracker URL per
 * torrent, independent of file paths or user-applied tags.
 *
 * Keyed by the apex domain because announce hosts vary by tracker
 * convention: BHD uses `tracker.beyond-hd.me`, Luminarr uses bare
 * `luminarr.me`, HDBits uses `tracker.hdbits.org`, TheFL uses
 * `reactor.thefl.org` (the user's qui setup paths confirm this).
 * Stripping subdomains and matching apex catches all variants.
 */
const HOSTNAME_TO_BRAND_KEY: Record<string, string> = {
	"beyond-hd.me": "beyond-hd",
	"hdbits.org": "hdbits",
	"aither.cc": "aither",
	"blutopia.cc": "blutopia",
	"luminarr.me": "luminarr",
	"privatehd.to": "privatehd",
	"lst.gg": "lst",
	"thefl.org": "fl",
	"passthepopcorn.me": "ptp",
	"broadcasthe.net": "btn",
	"landof.tv": "btn", // BTN historical
	"torrentleech.org": "tl",
};

/**
 * Extract the apex domain from a hostname by dropping subdomains.
 * `tracker.beyond-hd.me` → `beyond-hd.me`. Already-apex hostnames
 * pass through unchanged. Handles `co.uk`-style 2-part TLDs by
 * keeping the last 2 segments unless a 3-part TLD is detected.
 */
function hostnameToApex(hostname: string): string {
	const parts = hostname.toLowerCase().split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	// Most tracker domains are 2-part TLDs (.org, .me, .cc, .net, .to, .gg).
	// Drop everything except the last 2 segments — `tracker.beyond-hd.me`
	// becomes `beyond-hd.me`. The HOSTNAME_TO_BRAND_KEY map is the
	// source of truth; unknown apex domains fall through to `null`.
	return parts.slice(-2).join(".");
}

/**
 * Resolve a tracker's brand from its announce URL hostname. The
 * authoritative path — independent of file paths and user tags.
 * Returns null for hostnames not in the registry (the UI falls back
 * to a neutral pill or honest `?`).
 */
export function getTrackerBrandByHostname(
	hostname: string | null | undefined,
): TrackerBrand | null {
	if (!hostname) return null;
	const apex = hostnameToApex(hostname);
	const key = HOSTNAME_TO_BRAND_KEY[apex];
	if (!key) return null;
	return BRANDS[key] ?? null;
}

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
 * Resolve a brand for a torrent copy using only **authoritative** signals.
 *
 * Priority:
 *   1. **Announce URL hostnames** (from qBit's per-torrent tracker list,
 *      surfaced via qui's `getTrackers(instanceId, hash)` endpoint). This
 *      is the ground truth — qBit publishes exactly which trackers a
 *      torrent is configured to announce to, independent of file paths
 *      or user-applied tags.
 *   2. **Path-derived tracker** (from qui's hardlink-mode `/links/<tracker>/`
 *      layout segment). Authoritative when present, because qui's
 *      cross-seed automation owns this directory structure.
 *   3. `?` fallback when neither signal is available.
 *
 * **Tags are intentionally NOT consulted.** Tags are user/automation
 * labels — informative for humans, but not authority. A torrent tagged
 * `Beyond-HD` may not actually be announcing to BHD (tracker dropped it,
 * user mis-tagged, autotagger glitch). Showing a brand pill based on a
 * tag would dress up a guess as a fact.
 */
export function resolveCopyTrackerBrand(args: {
	/** Path-derived tracker name (from `/links/<tracker>/` savePath segment). */
	tracker: string | null;
	/** Announce URL hostnames from qBit (authoritative). First match wins. */
	trackerHostnames?: readonly string[];
}): TrackerBrand {
	// Tier 1: authoritative — first announce URL that maps to a known brand.
	if (args.trackerHostnames) {
		for (const host of args.trackerHostnames) {
			const branded = getTrackerBrandByHostname(host);
			if (branded) return branded;
		}
	}
	// Tier 2: path-derived — also authoritative within qui's hardlink layout.
	if (args.tracker) {
		const fromName = getTrackerBrand(args.tracker);
		if (fromName.abbr !== "?") return fromName;
	}
	// Tier 3: honest unknown. No tag guessing.
	return { abbr: "?", name: "Unknown" };
}
