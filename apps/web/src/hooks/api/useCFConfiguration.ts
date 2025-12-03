/**
 * Custom hook for fetching CF configuration data
 * Extracted from cf-configuration.tsx to reduce component complexity
 */

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";
import type { QualityProfileSummary } from "../../lib/api-client/trash-guides";

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 * In edit mode, templates don't persist the original TRaSH profile ID.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface UseCFConfigurationOptions {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: WizardSelectedProfile;
	isEditMode?: boolean;
	editingTemplate?: any;
}

/**
 * Check if a trashId indicates a cloned profile from an instance
 * Cloned profile trashIds have format: cloned-{instanceId}-{profileId}-{uuid}
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: string } | null {
	if (!isClonedProfile(trashId)) return null;

	// Format: cloned-{instanceId}-{profileId}-{uuid}
	const parts = trashId.split("-");
	if (parts.length < 4) return null;

	// instanceId is the second part (could be a UUID with dashes)
	// profileId is after instanceId, before the final uuid
	// Example: cloned-cmgpfmpu90001og0k8e4zhji1-9-0343e401-360b-46cb-973d-cf61f1321f53
	// instanceId = cmgpfmpu90001og0k8e4zhji1, profileId = 9

	const instanceId = parts[1];
	const profileId = parts[2];

	if (!instanceId || !profileId) return null;

	return { instanceId, profileId };
}

export function useCFConfiguration({
	serviceType,
	qualityProfile,
	isEditMode = false,
	editingTemplate,
}: UseCFConfigurationOptions) {
	// In normal mode, we need a valid trashId to fetch profile data
	const hasValidTrashId = !!qualityProfile.trashId;
	const isCloned = isClonedProfile(qualityProfile.trashId);

	return useQuery({
		queryKey: isEditMode
			? ["template-edit-data", editingTemplate?.id]
			: isCloned
				? ["cloned-profile-details", qualityProfile.trashId]
				: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			try {
				if (isEditMode && editingTemplate) {
					return await fetchEditModeData(serviceType, editingTemplate);
				} else if (isCloned && qualityProfile.trashId) {
					// Handle cloned profile - fetch from source instance
					return await fetchClonedProfileData(qualityProfile.trashId);
				} else {
					// Guard: trashId must exist in normal mode
					if (!qualityProfile.trashId) {
						throw new Error("Missing trashId for quality profile fetch");
					}
					return await fetchNormalModeData(serviceType, qualityProfile.trashId);
				}
			} catch (error) {
				console.error("Failed to fetch CF configuration:", error);
				throw new Error(
					`Failed to load custom formats: ${error instanceof Error ? error.message : "Unknown error"}`
				);
			}
		},
		// Only enable in edit mode (with template) or normal mode (with valid trashId)
		enabled: isEditMode ? !!editingTemplate : hasValidTrashId,
	});
}

async function fetchEditModeData(serviceType: string, editingTemplate: any) {
	const templateCFs = editingTemplate.config.customFormats || [];
	const templateCFGroups = editingTemplate.config.customFormatGroups || [];

	// Extract custom formats from template's originalConfig
	const mandatoryCFs = templateCFs.map((cf: any) => {
		const trashScores = cf.originalConfig?.trash_scores || {};
		const defaultScore = trashScores.default || 0;

		return {
			trash_id: cf.trashId,
			name: cf.originalConfig?.name || cf.name,
			displayName: cf.originalConfig?.name || cf.name,
			description: "",
			defaultScore,
			scoreOverride: cf.scoreOverride,
			source: "template" as const,
			locked: false,
			originalConfig: cf.originalConfig,
		};
	});

	// Fetch all available custom formats from cache
	const availableFormats = await fetchAvailableFormats(serviceType);

	// Map CF Groups
	const cfGroups = templateCFGroups.map((cfGroup: any) => ({
		trash_id: cfGroup.trashId,
		name: cfGroup.originalConfig?.name || cfGroup.name,
		trash_description: cfGroup.originalConfig?.trash_description || "",
		custom_formats: cfGroup.originalConfig?.custom_formats || [],
		default: cfGroup.originalConfig?.default,
		quality_profiles: cfGroup.originalConfig?.quality_profiles,
	}));

	return {
		cfGroups,
		mandatoryCFs,
		availableFormats,
		stats: {
			mandatoryCount: templateCFs.length,
			optionalGroupCount: templateCFGroups.length,
			totalOptionalCFs: availableFormats.length,
		},
	};
}

/**
 * Fetch data for a cloned profile from the source instance
 */
async function fetchClonedProfileData(trashId: string) {
	const parsedId = parseClonedProfileId(trashId);

	if (!parsedId) {
		throw new Error("Invalid cloned profile ID format");
	}

	const { instanceId, profileId } = parsedId;

	// Fetch profile details from the source instance
	const response = await apiRequest<any>(
		`/api/trash-guides/profile-clone/profile-details/${instanceId}/${profileId}`
	);

	if (!response.success || !response.data) {
		throw new Error(response.error || "Failed to fetch profile details from instance");
	}

	const { profile, customFormats, allCustomFormats } = response.data;

	// Convert instance CFs to the format expected by the wizard
	const mandatoryCFs = customFormats.map((cf: any) => ({
		trash_id: cf.trash_id,
		name: cf.name,
		displayName: cf.name,
		description: "",
		score: cf.score,
		defaultScore: cf.score,
		source: "instance" as const,
		locked: false,
		specifications: cf.specifications,
		originalConfig: {
			name: cf.name,
			specifications: cf.specifications,
			includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
		},
	}));

	// All instance CFs as available formats
	const availableFormats = allCustomFormats.map((cf: any) => ({
		trash_id: cf.trash_id,
		name: cf.name,
		displayName: cf.name,
		description: "",
		score: 0, // Instance CFs don't have TRaSH scores by default
		originalConfig: {
			name: cf.name,
			specifications: cf.specifications,
			includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
		},
	}));

	return {
		cfGroups: [], // Cloned profiles don't have CF groups
		mandatoryCFs,
		availableFormats,
		profile: {
			name: profile.name,
			upgradeAllowed: profile.upgradeAllowed,
			cutoff: profile.cutoff,
			minFormatScore: profile.minFormatScore,
		},
		stats: {
			mandatoryCount: customFormats.length,
			optionalGroupCount: 0,
			totalOptionalCFs: allCustomFormats.length,
		},
		isClonedProfile: true,
	};
}

async function fetchNormalModeData(
	serviceType: string,
	trashId: string
) {
	const profileData = await apiRequest<any>(
		`/api/trash-guides/quality-profiles/${serviceType}/${trashId}`
	);

	const availableFormats = await fetchAvailableFormats(serviceType);

	return {
		...profileData,
		availableFormats,
	};
}

async function fetchAvailableFormats(serviceType: string) {
	const customFormatsRes = await apiRequest<any>(
		`/api/trash-guides/cache/entries?serviceType=${serviceType}&configType=CUSTOM_FORMATS`
	);

	const customFormatsCacheEntry = Array.isArray(customFormatsRes)
		? customFormatsRes[0]
		: customFormatsRes;

	const allCustomFormats = customFormatsCacheEntry?.data || [];

	return allCustomFormats.map((cf: any) => {
		const trashScores = cf.trash_scores || {};
		const defaultScore = trashScores.default || 0;

		return {
			trash_id: cf.trash_id,
			name: cf.name,
			displayName: cf.name,
			description: cf.trash_description || "",
			score: defaultScore,
			originalConfig: cf,
		};
	});
}
