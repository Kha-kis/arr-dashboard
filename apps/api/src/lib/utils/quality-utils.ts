/**
 * Quality Profile Utilities
 *
 * Shared utility functions for working with Sonarr/Radarr quality profiles.
 */

/**
 * Quality profile item structure from Sonarr/Radarr API.
 * Items can be single qualities or quality groups containing nested items.
 */
export interface QualityProfileItem {
	id?: number;
	name?: string;
	quality?: {
		id: number;
		name: string;
	};
	items?: QualityProfileItem[];
}

/**
 * Find the quality name for a given cutoff ID in a quality profile's items.
 *
 * The cutoff ID can match:
 * 1. A single quality item (item.quality.id)
 * 2. A quality group (item.id with item.name, has item.items)
 * 3. A quality inside a group (subItem.quality.id or subItem.id)
 *
 * @param items - Array of quality profile items
 * @param cutoffId - The cutoff quality ID to find
 * @returns The quality name if found, "Unknown" otherwise
 */
export function findCutoffQualityName(
	items: QualityProfileItem[],
	cutoffId: number
): string {
	for (const item of items) {
		// Check if this is a single quality item matching the cutoff
		if (item.quality?.id === cutoffId) {
			return item.quality.name;
		}
		// Check if this is a quality GROUP matching the cutoff (group has id + name + items)
		if (item.id === cutoffId && item.name && item.items) {
			return item.name;
		}
		// Check if this is a group containing the cutoff quality
		if (item.items && Array.isArray(item.items)) {
			for (const subItem of item.items) {
				// Sub-items can have quality wrapper or direct id/name
				if (subItem.quality?.id === cutoffId) {
					return subItem.quality.name;
				}
				if (subItem.id === cutoffId && subItem.name) {
					return subItem.name;
				}
			}
		}
	}
	return "Unknown";
}
