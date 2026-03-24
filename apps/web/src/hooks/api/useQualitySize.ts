"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	type ApplyQualitySizePayload,
	type ApplyQualitySizeResponse,
	applyQualitySize,
	fetchQualitySizeMapping,
	fetchQualitySizePresets,
	getQualitySizePreview,
	type QualitySizeMappingResponse,
	type QualitySizePresetsResponse,
	type QualitySizePreviewResponse,
	updateQualitySizeSyncStrategy,
} from "../../lib/api-client/trash-guides";
import { trashGuidesKeys } from "../../lib/query-keys";

/**
 * Fetch available quality size presets for a service type.
 */
export function useQualitySizePresets(serviceType: "RADARR" | "SONARR" | null) {
	return useQuery<QualitySizePresetsResponse>({
		queryKey: trashGuidesKeys.qualitySize.presets(serviceType!),
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
		queryKey: trashGuidesKeys.qualitySize.mapping(instanceId!),
		queryFn: () => fetchQualitySizeMapping(instanceId!),
		enabled: !!instanceId,
	});
}

/**
 * Preview the diff between a TRaSH preset and instance quality definitions.
 */
export function useQualitySizePreview(instanceId: string | null, presetTrashId: string | null) {
	return useQuery<QualitySizePreviewResponse>({
		queryKey: trashGuidesKeys.qualitySize.preview(instanceId!, presetTrashId!),
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
				queryKey: trashGuidesKeys.qualitySize.all,
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
				queryKey: trashGuidesKeys.qualitySize.all,
			});
		},
		onError: (error: Error) => {
			toast.error(`Failed to update sync strategy: ${error.message}`);
		},
	});
}
