/**
 * Utility functions for converting quality profile data to CustomQualityConfig format
 */

import type {
	CustomQualityConfig,
	TemplateConfig,
	TemplateQualityEntry,
	TemplateQualityGroup,
	TemplateQualityItem,
} from "@arr/shared";

/**
 * Generate a unique ID for quality items
 */
const generateId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * Convert a template's qualityProfile to CustomQualityConfig format
 * This allows the quality editor to display and edit the template's quality settings
 */
export function convertQualityProfileToConfig(qualityProfile?: {
	items?: Array<{
		name: string;
		allowed: boolean;
		items?: string[]; // Nested quality names for groups
	}>;
	cutoff?: string;
}): CustomQualityConfig | undefined {
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
				qualities: item.items.map((name) => ({ name })),
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
 * Convert a completeQualityProfile (from "Clone from Instance") to CustomQualityConfig format
 */
function convertCompleteProfileToConfig(
	profile: NonNullable<TemplateConfig["completeQualityProfile"]>,
): CustomQualityConfig | undefined {
	if (!profile.items || profile.items.length === 0) return undefined;

	const entries: TemplateQualityEntry[] = [];
	let cutoffId: string | undefined;

	for (const item of profile.items) {
		if (item.items && item.items.length > 0) {
			// Quality group (multiple qualities merged)
			const groupId = generateId();
			const group: TemplateQualityGroup = {
				id: groupId,
				name: item.name ?? item.items.map((q) => q.name).join(" / "),
				allowed: item.allowed,
				qualities: item.items.map((q) => ({ name: q.name })),
			};
			entries.push({ type: "group", group });

			if (item.id === profile.cutoff || item.quality?.id === profile.cutoff) {
				cutoffId = groupId;
			}
		} else if (item.quality) {
			// Single quality item
			const qualityId = generateId();
			const quality: TemplateQualityItem = {
				id: qualityId,
				name: item.quality.name,
				allowed: item.allowed,
			};
			entries.push({ type: "quality", item: quality });

			if (item.quality.id === profile.cutoff) {
				cutoffId = qualityId;
			}
		}
	}

	if (entries.length === 0) return undefined;

	return {
		useCustomQualities: true,
		items: entries,
		cutoffId,
		origin: "instance_clone",
	};
}

/**
 * Get the effective quality config from a template config
 * Returns customQualityConfig if it has items, otherwise converts from qualityProfile or completeQualityProfile
 */
export function getEffectiveQualityConfig(
	config?: TemplateConfig,
): CustomQualityConfig | undefined {
	if (!config) return undefined;

	// If customQualityConfig exists and has items, use it
	if (config.customQualityConfig?.items?.length) {
		return config.customQualityConfig;
	}

	// Try converting from qualityProfile (TRaSH-created templates)
	const fromProfile = convertQualityProfileToConfig(config.qualityProfile);
	if (fromProfile) return fromProfile;

	// Try converting from completeQualityProfile (cloned from instance)
	if (config.completeQualityProfile) {
		return convertCompleteProfileToConfig(config.completeQualityProfile);
	}

	return undefined;
}
