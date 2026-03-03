/**
 * Recently Added Helpers
 *
 * Pure functions for mapping PlexCache entries to recently-added response items.
 */

import type { PlexRecentlyAddedItem } from "@arr/shared";

/** PlexCache row shape for recently-added mapping */
export interface PlexCacheRecentEntry {
	tmdbId: number;
	title: string;
	mediaType: string;
	sectionTitle: string;
	addedAt: Date | null;
	ratingKey: string | null;
	instanceId: string;
}

/**
 * Map PlexCache entries to PlexRecentlyAddedItem response objects.
 */
export function mapToRecentlyAddedItems(
	entries: PlexCacheRecentEntry[],
	instanceNameMap: Map<string, string>,
): PlexRecentlyAddedItem[] {
	return entries.map((entry) => ({
		tmdbId: entry.tmdbId,
		title: entry.title,
		mediaType: entry.mediaType,
		sectionTitle: entry.sectionTitle,
		addedAt: entry.addedAt!.toISOString(),
		ratingKey: entry.ratingKey,
		instanceId: entry.instanceId,
		instanceName: instanceNameMap.get(entry.instanceId) ?? "Unknown",
	}));
}
