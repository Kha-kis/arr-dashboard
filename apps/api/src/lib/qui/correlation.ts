import type { QuiCrossSeedMatch, QuiTorrent } from "@arr/shared";

/**
 * Library item context used as the join key in correlation routines.
 * The hash is the canonical identifier; the optional fields are the
 * human-meaningful fallbacks the UI renders alongside the torrent.
 */
export interface LibraryItemRef {
	infoHash: string;
	arrItemId?: number;
	title?: string;
}

export interface TorrentGroup {
	item: LibraryItemRef;
	primary: QuiTorrent | null;
	siblings: QuiCrossSeedMatch[];
}

/**
 * Group fetched torrents by the library item they belong to.
 *
 * `torrentsByHash` is the result of looking up each library item's
 * primary infoHash in qui — most items resolve to one torrent, some to
 * none (orphaned), some to multiple if cross-seed siblings have already
 * been merged at the call site.
 */
export function groupTorrentsByLibraryItem(
	items: LibraryItemRef[],
	torrentsByHash: Map<string, QuiTorrent>,
	siblingsByHash: Map<string, QuiCrossSeedMatch[]> = new Map(),
): TorrentGroup[] {
	return items.map((item) => ({
		item,
		primary: torrentsByHash.get(item.infoHash) ?? null,
		siblings: siblingsByHash.get(item.infoHash) ?? [],
	}));
}

/**
 * True if a library item has at least one cross-seed sibling whose
 * tracker reports `unregistered`. Used as a high-confidence signal in
 * Phase 2.2 ("safe to delete? tracker says no one is seeding it
 * anywhere") and Phase 3.3 (orphan-scan surface).
 */
export function hasUnregisteredSibling(siblings: QuiCrossSeedMatch[]): boolean {
	return siblings.some((s) => s.trackerHealth === "unregistered");
}

/**
 * True if a library item has any seeding instance — either the primary
 * torrent is seeding, or a cross-seed sibling is. Drives the "still
 * seeding" gate.
 */
export function isItemSeeding(group: TorrentGroup): boolean {
	const primary = group.primary;
	if (primary && (primary.state === "uploading" || primary.state === "forcedUP")) {
		return true;
	}
	return group.siblings.some(
		(s) => s.state === "uploading" || s.state === "forcedUP" || s.state === "stalledUP",
	);
}
