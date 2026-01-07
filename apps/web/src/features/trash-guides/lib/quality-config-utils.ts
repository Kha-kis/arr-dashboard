/**
 * Utility functions for converting quality profile data to CustomQualityConfig format
 */

import type {
	CustomQualityConfig,
	TemplateQualityEntry,
	TemplateQualityItem,
	TemplateQualityGroup,
	TemplateConfig,
} from "@arr/shared";

/**
 * Generate a unique ID for quality items
 */
const generateId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * Convert a template's qualityProfile to CustomQualityConfig format
 * This allows the quality editor to display and edit the template's quality settings
 */
export function convertQualityProfileToConfig(
	qualityProfile?: {
		items?: Array<{
			name: string;
			allowed: boolean;
			items?: string[]; // Nested quality names for groups
		}>;
		cutoff?: string;
	}
): CustomQualityConfig | undefined {
	if (!qualityProfile?.items || qualityProfile.items.length === 0) {
		return undefined;
	}

	const entries: TemplateQualityEntry[] = [];
	let cutoffId: string | undefined;

	for (const item of qualityProfile.items) {
		if (item.items && item.items.length > 0) {
			// This is a quality group
			const groupId = generateId();
			const group: TemplateQualityGroup = {
				id: groupId,
				name: item.name,
				allowed: item.allowed,
				qualities: item.items.map(name => ({ name })),
			};
			entries.push({ type: "group", group });

			// Check if this is the cutoff
			if (qualityProfile.cutoff === item.name) {
				cutoffId = groupId;
			}
		} else {
			// This is a single quality
			const qualityId = generateId();
			const quality: TemplateQualityItem = {
				id: qualityId,
				name: item.name,
				allowed: item.allowed,
			};
			entries.push({ type: "quality", item: quality });

			// Check if this is the cutoff
			if (qualityProfile.cutoff === item.name) {
				cutoffId = qualityId;
			}
		}
	}

	return {
		useCustomQualities: true,
		items: entries,
		cutoffId,
		origin: "trash_profile",
	};
}

/**
 * Get the effective quality config from a template config
 * Returns customQualityConfig if it has items, otherwise converts from qualityProfile
 */
export function getEffectiveQualityConfig(
	config?: TemplateConfig
): CustomQualityConfig | undefined {
	if (!config) return undefined;

	// If customQualityConfig exists and has items, use it
	if (config.customQualityConfig?.items?.length) {
		return config.customQualityConfig;
	}

	// Otherwise, convert from qualityProfile
	return convertQualityProfileToConfig(config.qualityProfile);
}
