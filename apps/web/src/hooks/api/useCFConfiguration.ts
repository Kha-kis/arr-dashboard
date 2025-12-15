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
 * Format: cloned-{instanceId}-{profileId}-{uuid}
 * Where instanceId can contain dashes, profileId is a number, and uuid can be:
 * - Standard UUID: 5 parts (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * - Fallback: 2 parts (timestamp-random alphanumeric)
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	// Remove "cloned-" prefix
	const withoutPrefix = trashId.slice(7); // "cloned-".length = 7
	if (!withoutPrefix) return null;

	// Split by "-"
	const parts = withoutPrefix.split("-");

	// Need at least: instanceId (1+ parts) + profileId (1 part) + uuid (2 or 5 parts) = 4 or 7 parts minimum
	if (parts.length < 4) return null;

	// Try to detect UUID format by testing the last segments
	// First, try standard 5-part UUID format
	const uuidParts5 = parts.slice(-5);
	const uuidCandidate5 = uuidParts5.join("-");
	// UUID regex: 8-4-4-4-12 hex digits
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	let profileIdIndex: number;

	if (uuidRegex.test(uuidCandidate5) && parts.length >= 7) {
		// Standard 5-part UUID format detected
		profileIdIndex = parts.length - 6; // profileId is second-to-last before UUID
	} else {
		// Try fallback 2-part format (timestamp-random)
		const uuidParts2 = parts.slice(-2);
		if (parts.length < 4) return null; // Need at least instanceId + profileId + 2-part ID

		// Check if first part is numeric (timestamp) and second is alphanumeric
		const timestampPart = uuidParts2[0];
		const randomPart = uuidParts2[1];

		if (timestampPart && randomPart && /^\d+$/.test(timestampPart) && /^[a-z0-9]+$/i.test(randomPart)) {
			// Fallback 2-part format detected
			profileIdIndex = parts.length - 3; // profileId is third-to-last before 2-part ID
		} else {
			// Neither format matches
			return null;
		}
	}

	// Extract profileId and instanceId based on detected format
	const profileIdStr = parts[profileIdIndex];
	const instanceIdParts = parts.slice(0, profileIdIndex);
	const instanceId = instanceIdParts.join("-");

	// Validate that profileId and instanceId are non-empty
	if (!instanceId || !profileIdStr) return null;

	// Parse profileId as number
	const profileId = parseInt(profileIdStr, 10);
	if (isNaN(profileId) || profileId < 0) return null;

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

	// Check for error response (quality profile route returns { statusCode, error, message } on error)
	if (profileData.statusCode || profileData.error) {
		throw new Error(profileData.message || profileData.error || "Failed to fetch quality profile details");
	}

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
