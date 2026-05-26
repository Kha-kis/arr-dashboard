/**
 * Tracker brand resolver — fully delegated to qui's per-user meta map.
 *
 * Previous versions maintained a static `BRANDS` table here (BHD/BLU/ATH
 * etc. with abbreviations, names, and brand colors). That worked but
 * required manual maintenance as new trackers appeared. qui already
 * maintains a richer per-user registry (community-curated favicons +
 * user-uploaded custom icons + per-tracker display name customizations),
 * so we now route ALL brand identity through qui:
 *
 *   - Icon: from qui's `/api/tracker-icons` (data:image/png URLs)
 *   - Display name: from qui's `/api/tracker-customizations`
 *   - Abbreviation: derived from the display name (or hostname)
 *
 * Both qui calls are fused server-side into a single `Record<host,
 * {iconUrl?, name?}>` and served via `/api/qui/tracker-icons` to the
 * frontend. This file is purely the resolution layer — no data tables,
 * no maintenance burden.
 *
 * Fallback chain when qui has no entry for a hostname:
 *   1. Auto-derive a display name from the hostname (strip "tracker.",
 *      "announce." prefixes, title-case the apex segment).
 *   2. Auto-derive a 3-letter abbreviation from that display name.
 *
 * This means an unknown tracker still gets a sensible-looking pill
 * (e.g., a brand-new tracker at `tracker.newrelease.io` reads as
 * "NEW" with the full name "Newrelease" in the tooltip).
 */

export interface TrackerBrand {
	abbr: string;
	name: string;
	/** Tracker logo as a `data:image/png;base64,...` URL when qui has one. */
	iconUrl?: string;
}

/**
 * Extract the apex domain (last 2 segments) from a hostname. Used to
 * match `tracker.beyond-hd.me` to `beyond-hd.me`-keyed customizations
 * and vice versa. Single-segment hostnames pass through.
 */
function hostnameToApex(hostname: string): string {
	const parts = hostname.toLowerCase().split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	return parts.slice(-2).join(".");
}

/**
 * Strip common boilerplate prefixes from a hostname and return the most
 * identifying segment. Used to derive a fallback display name when qui
 * has no customization for the host.
 *
 *   `tracker.avistaz.to`     → `avistaz`
 *   `announce.beyond-hd.me`  → `beyond-hd`
 *   `hdbits.org`             → `hdbits`
 */
function pickIdentifyingSegment(hostname: string): string {
	const parts = hostname.toLowerCase().split(".").filter(Boolean);
	const filtered = parts.filter((p) => p !== "tracker" && p !== "announce" && p !== "t");
	return filtered[0] ?? parts[0] ?? "";
}

/**
 * Title-case a single identifying segment for display.
 *   `avistaz`    → `Avistaz`
 *   `beyond-hd`  → `Beyond-Hd`   (qui's customization name overrides
 *                                 this when present, so we don't try
 *                                 to be clever about the second cap)
 */
function titleCase(s: string): string {
	if (!s) return "";
	return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Derive a 3-letter abbreviation from a display name. Strips spaces and
 * punctuation, uppercases. Tries to pick the first letter of each word
 * for multi-word names; falls back to the first 3 alphanumerics.
 *
 *   `Beyond-HD`        → `BHD`
 *   `PassThePopcorn`   → `PAS`  (no obvious word boundary)
 *   `BroadcasTheNet`   → `BTN`  (likewise)
 *   `LST`              → `LST`
 *   `Avistaz`          → `AVI`
 *
 * When qui's display name doesn't yield a clean 3-letter form, the
 * full name still appears in tooltips and the icon carries the
 * primary brand signal.
 */
function deriveAbbr(name: string): string {
	if (!name) return "?";
	// Multi-word: first letter of each segment.
	const segments = name.split(/[\s\-_/.]+/).filter(Boolean);
	if (segments.length >= 2) {
		return segments
			.slice(0, 3)
			.map((s) => s[0]!.toUpperCase())
			.join("");
	}
	// Single segment: first 3 alphanumerics.
	const cleaned = name.replace(/[^a-zA-Z0-9]/g, "");
	return cleaned.slice(0, 3).toUpperCase();
}

/**
 * Resolve a tracker's brand identity using qui's per-user meta map.
 *
 * Lookup order:
 *   1. For each candidate hostname (announce-URL hosts + path-derived
 *      tracker), check qui's map for both the exact host AND the apex
 *      domain (covers `tracker.foo.me` vs `foo.me` keying).
 *   2. If qui has an entry: return it with name from qui (or derived
 *      from hostname), icon from qui (or undefined), abbr derived.
 *   3. If qui has no entry: derive name + abbr from the first valid
 *      hostname's identifying segment.
 *   4. No hostnames at all: return generic "?" placeholder.
 */
export function resolveCopyTrackerBrand(args: {
	/** Path-derived tracker name (from `/links/<tracker>/` savePath segment). */
	tracker: string | null;
	/** Announce URL hostnames from qBit (authoritative). */
	trackerHostnames?: readonly string[];
	/** qui's meta map. Pass `useTrackerIcons().data?.trackers` here. */
	icons?: Record<string, { iconUrl?: string; name?: string }>;
}): TrackerBrand {
	const lookupQui = (host: string): { iconUrl?: string; name?: string } | undefined => {
		if (!args.icons) return undefined;
		const exact = args.icons[host];
		if (exact && (exact.iconUrl || exact.name)) return exact;
		const apex = hostnameToApex(host);
		const apexEntry = args.icons[apex];
		if (apexEntry && (apexEntry.iconUrl || apexEntry.name)) return apexEntry;
		return undefined;
	};

	// Walk all hostname candidates — first one with a qui hit wins.
	const hosts = args.trackerHostnames ?? [];
	for (const host of hosts) {
		const meta = lookupQui(host);
		if (meta) {
			const name = meta.name ?? titleCase(pickIdentifyingSegment(host));
			return {
				abbr: deriveAbbr(name),
				name,
				iconUrl: meta.iconUrl,
			};
		}
	}

	// No qui hit — derive everything from the first hostname (if any).
	const firstHost = hosts[0] ?? args.tracker;
	if (firstHost) {
		const name = titleCase(pickIdentifyingSegment(firstHost));
		return { abbr: deriveAbbr(name), name: name || "Tracker" };
	}

	return { abbr: "?", name: "Unknown" };
}

/**
 * Lookup helper for the per-tracker pill row (separate from cluster
 * header) — same resolution path but for a single hostname.
 */
export function resolveHostnameBrand(
	hostname: string,
	icons: Record<string, { iconUrl?: string; name?: string }> | undefined,
): TrackerBrand {
	if (icons) {
		const exact = icons[hostname];
		const apex = icons[hostnameToApex(hostname)];
		const meta = exact?.iconUrl || exact?.name ? exact : apex;
		if (meta && (meta.iconUrl || meta.name)) {
			const name = meta.name ?? titleCase(pickIdentifyingSegment(hostname));
			return { abbr: deriveAbbr(name), name, iconUrl: meta.iconUrl };
		}
	}
	const name = titleCase(pickIdentifyingSegment(hostname));
	return { abbr: deriveAbbr(name), name: name || "Tracker" };
}
