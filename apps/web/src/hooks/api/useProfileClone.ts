/**
 * API hooks for Quality Profile Clone operations
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import type { CompleteQualityProfile } from "@arr/shared";

// ============================================================================
// Types
// ============================================================================

interface QualityProfileListItem {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	cutoffQuality?: {
		id: number;
		name: string;
	};
	minFormatScore: number;
	formatItemsCount: number;
}

interface ImportProfileRequest {
	instanceId: string;
	profileId: number;
}

interface PreviewProfileRequest {
	instanceId: string;
	profile: CompleteQualityProfile;
	customFormats: Array<{ trash_id: string; score: number }>;
}

interface DeployProfileRequest {
	instanceId: string;
	profile: CompleteQualityProfile;
	customFormats: Array<{ trash_id: string; score: number }>;
	profileName: string;
	existingProfileId?: number;
}

interface ProfilePreview {
	profileName: string;
	qualityDefinitions: {
		cutoff: string;
		upgradeAllowed: boolean;
		totalQualities: number;
		allowedQualities: number;
	};
	customFormats: {
		total: number;
		matched: number;
		unmatched: string[];
	};
	formatScores: {
		minScore: number;
		cutoffScore: number;
		avgScore: number;
	};
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Fetch quality profiles from an instance
 */
export function useInstanceProfiles(instanceId: string | null) {
	return useQuery({
		queryKey: ["profile-clone", "profiles", instanceId],
		queryFn: async () => {
			if (!instanceId) return [];

			const response = await fetch(
				`/api/trash-guides/profile-clone/profiles/${instanceId}`,
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to fetch profiles");
			}

			const data = await response.json();
			return data.data.profiles as QualityProfileListItem[];
		},
		enabled: !!instanceId,
	});
}

/**
 * Import quality profile from instance
 */
export function useImportProfile() {
	return useMutation({
		mutationFn: async (request: ImportProfileRequest) => {
			const response = await fetch(
				"/api/trash-guides/profile-clone/import",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to import profile");
			}

			const data = await response.json();
			return data.data.profile as CompleteQualityProfile;
		},
	});
}

/**
 * Preview profile deployment
 */
export function usePreviewProfileDeployment() {
	return useMutation({
		mutationFn: async (request: PreviewProfileRequest) => {
			const response = await fetch(
				"/api/trash-guides/profile-clone/preview",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to preview deployment");
			}

			const data = await response.json();
			return data.data as ProfilePreview;
		},
	});
}

/**
 * Deploy complete profile to instance
 */
export function useDeployProfile() {
	return useMutation({
		mutationFn: async (request: DeployProfileRequest) => {
			const response = await fetch(
				"/api/trash-guides/profile-clone/deploy",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(request),
				},
			);

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Failed to deploy profile");
			}

			const data = await response.json();
			return data.data.profileId as number;
		},
	});
}
