/**
 * Quality Profiles API Client
 * Client functions for quality profile operations and custom format scoring
 */

import { apiRequest } from "./base";

// Types
export interface QualityProfileFormatItem {
	format: number; // Custom format ID
	score: number;
	name?: string;
}

export interface QualityProfile {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	formatItems?: QualityProfileFormatItem[];
	// ARR API includes many more fields, but these are the relevant ones for CF management
	[key: string]: any;
}

export interface GetQualityProfilesResponse {
	profiles: QualityProfile[];
}

export interface UpdateProfileScoresRequest {
	customFormatScores: Array<{
		customFormatId: number;
		score: number;
	}>;
}

/**
 * Get all quality profiles for an instance
 */
export async function getQualityProfiles(
	instanceId: string,
): Promise<GetQualityProfilesResponse> {
	return apiRequest<GetQualityProfilesResponse>(
		`/api/quality-profiles?instanceId=${instanceId}`,
		{
			method: "GET",
		},
	);
}

/**
 * Get a single quality profile
 */
export async function getQualityProfile(
	instanceId: string,
	profileId: number,
): Promise<QualityProfile> {
	return apiRequest<QualityProfile>(
		`/api/quality-profiles/${instanceId}/${profileId}`,
		{
			method: "GET",
		},
	);
}

/**
 * Update custom format scores in a quality profile
 */
export async function updateProfileScores(
	instanceId: string,
	profileId: number,
	request: UpdateProfileScoresRequest,
): Promise<QualityProfile> {
	return apiRequest<QualityProfile>(
		`/api/quality-profiles/${instanceId}/${profileId}/scores`,
		{
			method: "PUT",
			json: request,
		},
	);
}
