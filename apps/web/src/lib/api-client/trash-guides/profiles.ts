/**
 * Quality Profiles API Operations
 *
 * API functions for TRaSH Guides quality profile management including
 * fetching, importing, updating, and profile cloning operations.
 */

import { apiRequest } from "../base";
import type {
	CustomQualityConfig,
	ServiceType,
	QualityProfileSummary,
	QualityProfilesResponse,
} from "./types";

// ============================================================================
// Import/Export Quality Profile Types
// ============================================================================

export type ImportQualityProfilePayload = {
	serviceType: ServiceType;
	trashId: string;
	templateName: string;
	templateDescription?: string;
	syncStrategy?: "auto" | "manual" | "notify";
	customQualityConfig?: CustomQualityConfig;
};

export type UpdateQualityProfileTemplatePayload = {
	templateId: string;
	serviceType: ServiceType;
	trashId?: string; // Optional - not needed when updating existing template
	templateName: string;
	templateDescription?: string;
	customQualityConfig?: CustomQualityConfig;
};

export type ImportQualityProfileResponse = {
	template: unknown;
	message: string;
	customFormatsIncluded: number;
};

// ============================================================================
// Instance Override Types
// ============================================================================

export type InstanceOverride = {
	id: string;
	instanceId: string;
	qualityProfileId: number;
	customFormatId: number;
	score: number;
	userId: string;
	createdAt: string;
	updatedAt: string;
};

export type GetOverridesResponse = {
	success: boolean;
	overrides: InstanceOverride[];
};

export type PromoteOverridePayload = {
	customFormatId: number;
	templateId: string;
};

export type PromoteOverrideResponse = {
	success: boolean;
	message: string;
	templateId: string;
	customFormatId: number;
	newScore: number;
};

export type DeleteOverrideResponse = {
	success: boolean;
	message: string;
	customFormatId: number;
};

export type BulkDeleteOverridesPayload = {
	customFormatIds: number[];
};

export type BulkDeleteOverridesResponse = {
	success: boolean;
	message: string;
	deletedCount: number;
};

// ============================================================================
// Score Update Types
// ============================================================================

export type ScoreUpdate = {
	customFormatId: number;
	score: number;
};

export type UpdateProfileScoresPayload = {
	scoreUpdates: ScoreUpdate[];
};

export type UpdateProfileScoresResponse = {
	success: boolean;
	message: string;
	updatedCount: number;
};

// ============================================================================
// Cloned Profile Types
// ============================================================================

export type CreateClonedTemplatePayload = {
	serviceType: ServiceType;
	trashId: string;
	templateName: string;
	templateDescription?: string;
	customFormatSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	sourceInstanceId: string;
	sourceProfileId: number;
	sourceProfileName: string;
	sourceInstanceLabel: string;
	profileConfig: {
		upgradeAllowed: boolean;
		cutoff: number;
		minFormatScore: number;
		cutoffFormatScore?: number;
		items?: unknown[];
		language?: unknown;
	};
	customQualityConfig?: CustomQualityConfig;
};

// ============================================================================
// CF Validation Types (Clone from Instance)
// ============================================================================

export type MatchConfidence = "exact" | "name_only" | "specs_similar" | "no_match";

export type CFMatchDetails = {
	nameMatch: boolean;
	specsMatch: boolean;
	specsDiffer?: string[];
};

export type CFMatchResult = {
	instanceCF: {
		id: number;
		name: string;
		trash_id?: string;
		score?: number;
	};
	trashCF: {
		trash_id: string;
		name: string;
		score?: number;
	} | null;
	confidence: MatchConfidence;
	matchDetails: CFMatchDetails;
	recommendedScore?: number;
	scoreSet?: string;
};

export type CFValidationSummary = {
	total: number;
	exactMatches: number;
	nameMatches: number;
	specsSimilar: number;
	noMatch: number;
};

export type CFValidationResponse = {
	success: boolean;
	profileName: string;
	summary: CFValidationSummary;
	results: CFMatchResult[];
};

export type ValidateCFsPayload = {
	instanceId: string;
	profileId: number;
	serviceType: ServiceType;
};

// ============================================================================
// Profile Matching Types (Recommendations)
// ============================================================================

export type RecommendedCF = {
	trash_id: string;
	name: string;
	score: number;
	source: "profile" | "group";
	groupName?: string;
	required: boolean;
};

export type ProfileMatchResult = {
	success: boolean;
	matched: boolean;
	matchType?: "exact" | "fuzzy" | "partial";
	reason?: string;
	availableProfiles?: string[];
	matchedProfile?: {
		trash_id: string;
		name: string;
		description?: string;
		scoreSet?: string;
	};
	recommendations?: {
		total: number;
		mandatory: number;
		fromGroups: number;
		customFormats: RecommendedCF[];
		recommendedTrashIds: string[];
	};
};

export type MatchProfilePayload = {
	profileName: string;
	serviceType: ServiceType;
};

// ============================================================================
// API Functions - Quality Profiles
// ============================================================================

/**
 * Fetch quality profiles for a service
 */
export async function fetchQualityProfiles(
	serviceType: ServiceType,
): Promise<QualityProfilesResponse> {
	return await apiRequest<QualityProfilesResponse>(
		`/api/trash-guides/quality-profiles/${serviceType}`,
	);
}

/**
 * Fetch detailed quality profile by trash_id
 */
export async function fetchQualityProfileDetails(
	serviceType: ServiceType,
	trashId: string,
): Promise<{ profile: unknown }> {
	return await apiRequest<{ profile: unknown }>(
		`/api/trash-guides/quality-profiles/${serviceType}/${trashId}`,
	);
}

/**
 * Import quality profile as template
 */
export async function importQualityProfile(
	payload: ImportQualityProfilePayload,
): Promise<ImportQualityProfileResponse> {
	return await apiRequest<ImportQualityProfileResponse>(
		"/api/trash-guides/quality-profiles/import",
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Update quality profile template
 */
export async function updateQualityProfileTemplate(
	payload: UpdateQualityProfileTemplatePayload,
): Promise<ImportQualityProfileResponse> {
	const { templateId, ...restPayload } = payload;
	return await apiRequest<ImportQualityProfileResponse>(
		`/api/trash-guides/quality-profiles/update/${templateId}`,
		{
			method: "PUT",
			json: restPayload,
		},
	);
}

// ============================================================================
// API Functions - Instance Overrides
// ============================================================================

/**
 * Get instance-level score overrides for a quality profile
 */
export async function getQualityProfileOverrides(
	instanceId: string,
	qualityProfileId: number,
): Promise<GetOverridesResponse> {
	return await apiRequest<GetOverridesResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides`,
	);
}

/**
 * Promote an instance override to template (updates all instances using that template)
 */
export async function promoteOverrideToTemplate(
	instanceId: string,
	qualityProfileId: number,
	payload: PromoteOverridePayload,
): Promise<PromoteOverrideResponse> {
	return await apiRequest<PromoteOverrideResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/promote-override`,
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Delete an instance override (revert to template/default score)
 */
export async function deleteQualityProfileOverride(
	instanceId: string,
	qualityProfileId: number,
	customFormatId: number,
): Promise<DeleteOverrideResponse> {
	return await apiRequest<DeleteOverrideResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides/${customFormatId}`,
		{
			method: "DELETE",
		},
	);
}

/**
 * Bulk delete instance overrides (revert multiple to template/default scores)
 */
export async function bulkDeleteQualityProfileOverrides(
	instanceId: string,
	qualityProfileId: number,
	payload: BulkDeleteOverridesPayload,
): Promise<BulkDeleteOverridesResponse> {
	return await apiRequest<BulkDeleteOverridesResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides/bulk-delete`,
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Update custom format scores for a quality profile on an instance
 */
export async function updateQualityProfileScores(
	instanceId: string,
	qualityProfileId: number,
	payload: UpdateProfileScoresPayload,
): Promise<UpdateProfileScoresResponse> {
	return await apiRequest<UpdateProfileScoresResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/scores`,
		{
			method: "PATCH",
			json: payload,
		},
	);
}

// ============================================================================
// API Functions - Cloned Profiles
// ============================================================================

/**
 * Create template from cloned profile (instance-based, not TRaSH cache)
 */
export async function createClonedProfileTemplate(
	payload: CreateClonedTemplatePayload,
): Promise<ImportQualityProfileResponse> {
	return await apiRequest<ImportQualityProfileResponse>(
		"/api/trash-guides/profile-clone/create-template",
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Validate instance Custom Formats against TRaSH cache
 * Used when cloning a profile from an instance to identify which CFs match TRaSH Guides
 */
export async function validateClonedCFs(
	payload: ValidateCFsPayload,
): Promise<CFValidationResponse> {
	return await apiRequest<CFValidationResponse>(
		"/api/trash-guides/profile-clone/validate-cfs",
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Match instance profile name to TRaSH Guides quality profiles
 * Returns CF recommendations based on the matched profile
 */
export async function matchProfileToTrash(
	payload: MatchProfilePayload,
): Promise<ProfileMatchResult> {
	return await apiRequest<ProfileMatchResult>(
		"/api/trash-guides/profile-clone/match-profile",
		{
			method: "POST",
			json: payload,
		},
	);
}

// Re-export types for convenience
export type { QualityProfileSummary, QualityProfilesResponse };
