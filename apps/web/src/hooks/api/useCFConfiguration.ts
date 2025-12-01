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

export function useCFConfiguration({
	serviceType,
	qualityProfile,
	isEditMode = false,
	editingTemplate,
}: UseCFConfigurationOptions) {
	// In normal mode, we need a valid trashId to fetch profile data
	const hasValidTrashId = !!qualityProfile.trashId;

	return useQuery({
		queryKey: isEditMode
			? ["template-edit-data", editingTemplate?.id]
			: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			try {
				if (isEditMode && editingTemplate) {
					return await fetchEditModeData(serviceType, editingTemplate);
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
