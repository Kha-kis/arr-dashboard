/**
 * API hooks for Quality Profile Clone operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
				let errorMessage = "Failed to fetch profiles";
				try {
					const error = await response.json();
					errorMessage = error.error || error.message || errorMessage;
				} catch {
					errorMessage = `Request failed: ${response.status}`;
				}
				throw new Error(errorMessage);
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
	const queryClient = useQueryClient();

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
				let errorMessage = "Failed to import profile";
				try {
					const error = await response.json();
					errorMessage = error.error || error.message || errorMessage;
				} catch {
					errorMessage = `Request failed: ${response.status}`;
				}
				throw new Error(errorMessage);
			}

			const data = await response.json();
			return {
				profile: data.data.profile as CompleteQualityProfile,
				instanceId: request.instanceId,
			};
		},
		onSuccess: (data) => {
			// Invalidate profile list for the affected instance
			queryClient.invalidateQueries({
				queryKey: ["profile-clone", "profiles", data.instanceId],
			});
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
				let errorMessage = "Failed to preview deployment";
				try {
					const error = await response.json();
					errorMessage = error.error || error.message || errorMessage;
				} catch {
					errorMessage = `Request failed: ${response.status}`;
				}
				throw new Error(errorMessage);
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
	const queryClient = useQueryClient();

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
				let errorMessage = "Failed to deploy profile";
				try {
					const error = await response.json();
					errorMessage = error.error || error.message || errorMessage;
				} catch {
					errorMessage = `Request failed: ${response.status}`;
				}
				throw new Error(errorMessage);
			}

			const data = await response.json();
			return {
				profileId: data.data.profileId as number,
				instanceId: request.instanceId,
			};
		},
		onSuccess: (data) => {
			// Invalidate profile list for the affected instance
			queryClient.invalidateQueries({
				queryKey: ["profile-clone", "profiles", data.instanceId],
			});
		},
	});
}
