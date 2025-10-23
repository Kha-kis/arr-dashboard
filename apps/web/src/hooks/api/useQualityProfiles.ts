/**
 * Quality Profiles React Query Hooks
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as qualityProfilesApi from "../../lib/api-client/quality-profiles";

/**
 * Query key factory for quality profiles
 */
export const qualityProfilesKeys = {
	all: ["quality-profiles"] as const,
	lists: () => [...qualityProfilesKeys.all, "list"] as const,
	list: (instanceId: string) =>
		[...qualityProfilesKeys.lists(), { instanceId }] as const,
	details: () => [...qualityProfilesKeys.all, "detail"] as const,
	detail: (instanceId: string, profileId: number) =>
		[...qualityProfilesKeys.details(), instanceId, profileId] as const,
};

/**
 * Hook to get all quality profiles for an instance
 */
export function useQualityProfiles(instanceId: string) {
	return useQuery({
		queryKey: qualityProfilesKeys.list(instanceId),
		queryFn: () => qualityProfilesApi.getQualityProfiles(instanceId),
		enabled: !!instanceId,
	});
}

/**
 * Hook to get a single quality profile
 */
export function useQualityProfile(instanceId: string, profileId: number) {
	return useQuery({
		queryKey: qualityProfilesKeys.detail(instanceId, profileId),
		queryFn: () => qualityProfilesApi.getQualityProfile(instanceId, profileId),
		enabled: !!instanceId && !!profileId,
	});
}

/**
 * Hook to update custom format scores in a quality profile
 */
export function useUpdateProfileScores() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			profileId,
			customFormatScores,
		}: {
			instanceId: string;
			profileId: number;
			customFormatScores: Array<{
				customFormatId: number;
				score: number;
			}>;
		}) =>
			qualityProfilesApi.updateProfileScores(instanceId, profileId, {
				customFormatScores,
			}),
		onSuccess: (_, variables) => {
			// Invalidate the specific profile and all profiles list
			queryClient.invalidateQueries({
				queryKey: qualityProfilesKeys.detail(
					variables.instanceId,
					variables.profileId,
				),
			});
			queryClient.invalidateQueries({
				queryKey: qualityProfilesKeys.list(variables.instanceId),
			});
		},
	});
}
