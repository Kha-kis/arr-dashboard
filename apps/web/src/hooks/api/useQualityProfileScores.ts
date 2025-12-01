import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	updateQualityProfileScores,
	type UpdateProfileScoresPayload,
	type UpdateProfileScoresResponse,
} from "../../lib/api-client/trash-guides";

/**
 * Entry for bulk score update operations
 */
export type BulkScoreUpdateEntry = {
	profileId: number;
	instanceId: string;
	changes: Array<{ cfTrashId: string; score: number }>;
};

/**
 * Result from a single profile score update
 */
export type ProfileUpdateResult = {
	profileId: number;
	instanceId: string;
	success: boolean;
	response?: UpdateProfileScoresResponse;
	error?: Error;
};

/**
 * Result from bulk score update mutation
 */
export type BulkUpdateScoresResult = {
	totalProfiles: number;
	successCount: number;
	failureCount: number;
	results: ProfileUpdateResult[];
};

/**
 * Hook to update scores for a single quality profile
 */
export function useUpdateProfileScores() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			qualityProfileId,
			payload,
		}: {
			instanceId: string;
			qualityProfileId: number;
			payload: UpdateProfileScoresPayload;
		}) => updateQualityProfileScores(instanceId, qualityProfileId, payload),
		onSuccess: (_, variables) => {
			// Invalidate related queries
			queryClient.invalidateQueries({
				queryKey: ["bulk-scores"],
			});
			queryClient.invalidateQueries({
				queryKey: ["quality-profile-overrides", variables.instanceId, variables.qualityProfileId],
			});
		},
	});
}

/**
 * Hook to bulk update scores across multiple quality profiles
 *
 * Accepts an array of { profileId, instanceId, changes } and calls the
 * updateQualityProfileScores API for each entry via Promise.all
 */
export function useBulkUpdateScores() {
	const queryClient = useQueryClient();

	return useMutation<BulkUpdateScoresResult, Error, BulkScoreUpdateEntry[]>({
		mutationFn: async (entries) => {
			const results: ProfileUpdateResult[] = [];

			// Process all profile updates in parallel
			const updatePromises = entries.map(async (entry) => {
				const { profileId, instanceId, changes } = entry;

				// Convert changes to API format (extract CF ID from trashId format "cf-{id}")
				const scoreUpdates = changes.map(({ cfTrashId, score }) => {
					const customFormatId = parseInt(cfTrashId.replace("cf-", ""));
					return { customFormatId, score };
				});

				try {
					const response = await updateQualityProfileScores(instanceId, profileId, {
						scoreUpdates,
					});

					return {
						profileId,
						instanceId,
						success: true,
						response,
					} as ProfileUpdateResult;
				} catch (error) {
					return {
						profileId,
						instanceId,
						success: false,
						error: error instanceof Error ? error : new Error(String(error)),
					} as ProfileUpdateResult;
				}
			});

			const settledResults = await Promise.all(updatePromises);
			results.push(...settledResults);

			const successCount = results.filter((r) => r.success).length;
			const failureCount = results.filter((r) => !r.success).length;

			// If there were any failures, throw an error with details
			if (failureCount > 0) {
				const errorMessages = results
					.filter((r) => !r.success)
					.map((r) => r.error?.message || "Unknown error")
					.join(", ");

				const error = new Error(
					`Failed to update ${failureCount} quality profile(s): ${errorMessages}`,
				);
				// Attach results to the error for access in onError
				(error as any).results = {
					totalProfiles: entries.length,
					successCount,
					failureCount,
					results,
				};
				throw error;
			}

			return {
				totalProfiles: entries.length,
				successCount,
				failureCount,
				results,
			};
		},
		onSuccess: (result) => {
			// Invalidate cache keys for all successfully updated profiles
			queryClient.invalidateQueries({
				queryKey: ["bulk-scores"],
			});

			// Invalidate individual quality profile override queries
			for (const profileResult of result.results) {
				if (profileResult.success) {
					queryClient.invalidateQueries({
						queryKey: [
							"quality-profile-overrides",
							profileResult.instanceId,
							profileResult.profileId,
						],
					});
				}
			}
		},
	});
}
