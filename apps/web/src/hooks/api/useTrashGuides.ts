/**
 * TRaSH Guides React Query Hooks
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as trashGuidesApi from "../../lib/api-client/trash-guides";
import { customFormatsKeys } from "./useCustomFormats";

/**
 * Query key factory for TRaSH guides
 */
export const trashGuidesKeys = {
	all: ["trash-guides"] as const,
	formats: (service: "SONARR" | "RADARR", ref?: string) =>
		[...trashGuidesKeys.all, "formats", service, ref || "master"] as const,
};

/**
 * Hook to get available TRaSH custom formats
 */
export function useTrashFormats(service: "SONARR" | "RADARR", ref = "master") {
	return useQuery({
		queryKey: trashGuidesKeys.formats(service, ref),
		queryFn: () => trashGuidesApi.getTrashFormats(service, ref),
		enabled: !!service,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
	});
}

/**
 * Hook to import a TRaSH custom format
 */
export function useImportTrashFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.importTrashFormat,
		onSuccess: () => {
			// Invalidate custom formats queries to refresh the list
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			// Invalidate TRaSH tracking data
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
		},
	});
}

/**
 * Hook to get TRaSH-tracked custom formats
 */
export function useTrashTracked() {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "tracked"],
		queryFn: () => trashGuidesApi.getTrashTracked(),
		staleTime: 30 * 1000, // Cache for 30 seconds
	});
}

/**
 * Hook to sync TRaSH-managed custom formats
 */
export function useSyncTrashFormats() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.syncTrashFormats,
		onSuccess: () => {
			// Invalidate custom formats queries to refresh the list
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			// Invalidate TRaSH tracking data
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
		},
	});
}

/**
 * Hook to get all TRaSH sync automation settings
 */
export function useAllTrashSyncSettings() {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "sync-settings"],
		queryFn: () => trashGuidesApi.getAllTrashSyncSettings(),
		staleTime: 60 * 1000, // Cache for 1 minute
	});
}

/**
 * Hook to get TRaSH sync automation settings for a specific instance
 */
export function useTrashSyncSettings(instanceId: string | null) {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "sync-settings", instanceId],
		queryFn: () => trashGuidesApi.getTrashSyncSettings(instanceId!),
		enabled: !!instanceId,
		staleTime: 60 * 1000, // Cache for 1 minute
	});
}

/**
 * Hook to update TRaSH sync automation settings for a specific instance
 */
export function useUpdateTrashSyncSettings() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ instanceId, settings }: { instanceId: string; settings: trashGuidesApi.UpdateTrashInstanceSyncSettingsRequest }) =>
			trashGuidesApi.updateTrashSyncSettings(instanceId, settings),
		onSuccess: (_, variables) => {
			// Invalidate sync settings queries
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "sync-settings"] });
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "sync-settings", variables.instanceId] });
		},
	});
}

/**
 * Hook to toggle sync exclusion for a TRaSH-managed custom format
 */
export function useToggleSyncExclusion() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ instanceId, customFormatId, syncExcluded }: { instanceId: string; customFormatId: number; syncExcluded: boolean }) =>
			trashGuidesApi.toggleSyncExclusion(instanceId, customFormatId, syncExcluded),
		onSuccess: () => {
			// Invalidate TRaSH tracking data to refresh the list
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
		},
	});
}

/**
 * Hook to get available TRaSH CF groups
 */
export function useTrashCFGroups(service: "SONARR" | "RADARR", ref = "master") {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "cf-groups", service, ref],
		queryFn: () => trashGuidesApi.getTrashCFGroups(service, ref),
		enabled: !!service,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
	});
}

/**
 * Hook to import a TRaSH CF group
 */
export function useImportCFGroup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.importCFGroup,
		onSuccess: () => {
			// Invalidate custom formats queries to refresh the list
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			// Invalidate TRaSH tracking data
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
			// Invalidate tracked CF groups
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-cf-groups"] });
		},
	});
}

/**
 * Hook to get available TRaSH quality profiles
 */
export function useTrashQualityProfiles(service: "SONARR" | "RADARR", ref = "master") {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "quality-profiles", service, ref],
		queryFn: () => trashGuidesApi.getTrashQualityProfiles(service, ref),
		enabled: !!service,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
	});
}

/**
 * Hook to apply a TRaSH quality profile
 */
export function useApplyQualityProfile() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.applyQualityProfile,
		onSuccess: () => {
			// Invalidate tracked quality profiles to refresh the list
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-quality-profiles"] });
		},
	});
}

/**
 * Hook to get tracked CF groups
 */
export function useTrackedCFGroups() {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "tracked-cf-groups"],
		queryFn: () => trashGuidesApi.getTrackedCFGroups(),
		staleTime: 30 * 1000, // Cache for 30 seconds
	});
}

/**
 * Hook to re-sync a tracked CF group
 */
export function useResyncCFGroup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.resyncCFGroup,
		onSuccess: () => {
			// Invalidate custom formats queries to refresh the list
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			// Invalidate TRaSH tracking data
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
			// Invalidate tracked CF groups
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-cf-groups"] });
		},
	});
}

/**
 * Hook to get tracked quality profiles
 */
export function useTrackedQualityProfiles() {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "tracked-quality-profiles"],
		queryFn: () => trashGuidesApi.getTrackedQualityProfiles(),
		staleTime: 30 * 1000, // Cache for 30 seconds
	});
}

/**
 * Hook to untrack a CF group
 */
export function useUntrackCFGroup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ instanceId, groupFileName, deleteFormats = true }: {
			instanceId: string;
			groupFileName: string;
			deleteFormats?: boolean;
		}) =>
			trashGuidesApi.untrackCFGroup(instanceId, groupFileName, deleteFormats),
		onSuccess: () => {
			// Invalidate custom formats queries to refresh the list
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			// Invalidate TRaSH tracking data
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
			// Invalidate tracked CF groups
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-cf-groups"] });
		},
	});
}

/**
 * Hook to re-apply a tracked quality profile
 */
export function useReapplyQualityProfile() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: trashGuidesApi.reapplyQualityProfile,
		onSuccess: () => {
			// Invalidate tracked quality profiles to refresh the list
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-quality-profiles"] });
		},
	});
}

/**
 * Hook to get recommended/optional custom formats for a quality profile
 */
export function useRecommendedCFs(
	service: "SONARR" | "RADARR",
	profileTrashId: string | undefined,
	ref = "master"
) {
	return useQuery({
		queryKey: [...trashGuidesKeys.all, "recommended-cfs", service, profileTrashId, ref],
		queryFn: () => trashGuidesApi.getRecommendedCFs(service, profileTrashId!, ref),
		enabled: !!service && !!profileTrashId,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
	});
}

/**
 * Hook to untrack a quality profile
 */
export function useUntrackQualityProfile() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ instanceId, profileFileName }: { instanceId: string; profileFileName: string }) =>
			trashGuidesApi.untrackQualityProfile(instanceId, profileFileName),
		onSuccess: () => {
			// Invalidate tracked quality profiles to refresh the list
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked-quality-profiles"] });
			// Also invalidate custom formats since they might have been converted
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
			queryClient.invalidateQueries({ queryKey: [...trashGuidesKeys.all, "tracked"] });
		},
	});
}
