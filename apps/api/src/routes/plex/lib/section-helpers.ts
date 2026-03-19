/**
 * Section Helpers
 *
 * Pure functions for mapping Prisma groupBy results to PlexSection response items.
 */

import type { PlexSection } from "@arr/shared";

/** Shape returned by Prisma groupBy for section queries */
export interface SectionGroupRow {
	instanceId: string;
	sectionId: string;
	sectionTitle: string;
	mediaType: string;
}

/**
 * Map Prisma groupBy rows to PlexSection response objects.
 */
export function mapToSections(
	groups: SectionGroupRow[],
	instanceNameMap: Map<string, string>,
): PlexSection[] {
	return groups.map((group) => ({
		sectionId: group.sectionId,
		sectionTitle: group.sectionTitle,
		mediaType: group.mediaType,
		instanceId: group.instanceId,
		instanceName: instanceNameMap.get(group.instanceId) ?? "Unknown",
	}));
}
