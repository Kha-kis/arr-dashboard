/**
 * On-Deck Helpers
 *
 * Pure functions for mapping PlexCache entries to OnDeck response items.
 */

import type { PlexOnDeckItem } from "@arr/shared";

/** PlexCache row shape for on-deck mapping */
export interface PlexCacheOnDeckEntry {
	tmdbId: number;
	title: string;
	mediaType: string;
	sectionTitle: string;
	instanceId: string;
	ratingKey: string | null;
}

/**
 * Map PlexCache entries to PlexOnDeckItem response objects.
 */
export function mapToOnDeckItems(
	entries: PlexCacheOnDeckEntry[],
	instanceNameMap: Map<string, string>,
): PlexOnDeckItem[] {
	return entries.map((entry) => ({
		tmdbId: entry.tmdbId,
		title: entry.title,
		mediaType: entry.mediaType,
		sectionTitle: entry.sectionTitle,
		instanceId: entry.instanceId,
		instanceName: instanceNameMap.get(entry.instanceId) ?? "Unknown",
		ratingKey: entry.ratingKey,
	}));
}
