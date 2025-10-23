/**
 * React Query hooks for Profiles API
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as profilesApi from "../../lib/api-client/profiles";

/**
 * Fetch quality profiles from an ARR instance
 */
export function useQualityProfiles(instanceId: string | undefined) {
	return useQuery({
		queryKey: ["profiles", "quality-profiles", instanceId],
		queryFn: () => {
			if (!instanceId) throw new Error("Instance ID is required");
			return profilesApi.getQualityProfiles(instanceId);
		},
		enabled: !!instanceId,
	});
}

/**
 * Get template overlay configuration for an instance
 */
export function useOverlay(instanceId: string | undefined) {
	return useQuery({
		queryKey: ["profiles", "overlays", instanceId],
		queryFn: () => {
			if (!instanceId) throw new Error("Instance ID is required");
			return profilesApi.getOverlay(instanceId);
		},
		enabled: !!instanceId,
	});
}

/**
 * Update template overlay configuration
 */
export function useUpdateOverlay() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			data,
		}: {
			instanceId: string;
			data: profilesApi.UpdateOverlayRequest;
		}) => profilesApi.updateOverlay(instanceId, data),
		onSuccess: (_, variables) => {
			// Invalidate the overlay query for this instance
			queryClient.invalidateQueries({
				queryKey: ["profiles", "overlays", variables.instanceId],
			});
		},
	});
}

/**
 * Preview template overlay changes
 */
export function usePreviewOverlay() {
	return useMutation({
		mutationFn: ({
			instanceId,
			data,
		}: {
			instanceId: string;
			data: profilesApi.PreviewRequest;
		}) => profilesApi.previewOverlay(instanceId, data),
	});
}

/**
 * Apply template overlay to an instance
 */
export function useApplyOverlay() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			data,
		}: {
			instanceId: string;
			data: profilesApi.ApplyRequest;
		}) => profilesApi.applyOverlay(instanceId, data),
		onSuccess: (_, variables) => {
			// Invalidate both overlay and quality profiles queries
			queryClient.invalidateQueries({
				queryKey: ["profiles", "overlays", variables.instanceId],
			});
			queryClient.invalidateQueries({
				queryKey: ["profiles", "quality-profiles", variables.instanceId],
			});
		},
	});
}
