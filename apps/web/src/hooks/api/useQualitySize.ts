"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	fetchQualitySizePresets,
	getQualitySizePreview,
	fetchQualitySizeMapping,
	applyQualitySize,
	updateQualitySizeSyncStrategy,
	type QualitySizePresetsResponse,
	type QualitySizePreviewResponse,
	type QualitySizeMappingResponse,
	type ApplyQualitySizeResponse,
	type ApplyQualitySizePayload,
} from "../../lib/api-client/trash-guides";

/**
 * Fetch available quality size presets for a service type.
 */
export function useQualitySizePresets(serviceType: "RADARR" | "SONARR" | null) {
	return useQuery<QualitySizePresetsResponse>({
		queryKey: ["trash-guides", "quality-size", "presets", serviceType],
		queryFn: () => fetchQualitySizePresets(serviceType!),
		enabled: !!serviceType,
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * Fetch the current quality size mapping for an instance.
 * Returns which preset is applied, sync strategy, and last applied time.
 */
export function useQualitySizeMapping(instanceId: string | null) {
	return useQuery<QualitySizeMappingResponse>({
		queryKey: ["trash-guides", "quality-size", "mapping", instanceId],
		queryFn: () => fetchQualitySizeMapping(instanceId!),
		enabled: !!instanceId,
	});
}

/**
 * Preview the diff between a TRaSH preset and instance quality definitions.
 */
export function useQualitySizePreview(
	instanceId: string | null,
	presetTrashId: string | null,
) {
	return useQuery<QualitySizePreviewResponse>({
		queryKey: ["trash-guides", "quality-size", "preview", instanceId, presetTrashId],
		queryFn: () => getQualitySizePreview(instanceId!, presetTrashId!),
		enabled: !!instanceId && !!presetTrashId,
		retry: false,
	});
}

/**
 * Apply a quality size preset to an instance.
 */
export function useApplyQualitySize() {
	const queryClient = useQueryClient();

	return useMutation<ApplyQualitySizeResponse, Error, ApplyQualitySizePayload>({
		mutationFn: (payload) => applyQualitySize(payload),
		onSuccess: (data) => {
			if (data.warning) {
				toast.warning(data.message);
			} else {
				toast.success(data.message);
			}
			void queryClient.refetchQueries({
				queryKey: ["trash-guides", "quality-size"],
			});
		},
		onError: (error) => {
			toast.error(`Failed to apply quality size: ${error.message}`);
		},
	});
}

/**
 * Update the sync strategy for an existing quality size mapping.
 */
export function useUpdateQualitySizeSyncStrategy() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: updateQualitySizeSyncStrategy,
		onSuccess: (data) => {
			toast.success(`Sync strategy updated to "${data.syncStrategy}"`);
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "quality-size"],
			});
		},
		onError: (error: Error) => {
			toast.error(`Failed to update sync strategy: ${error.message}`);
		},
	});
}
