import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TEMPLATES_QUERY_KEY } from "./useTemplates";
import { toast } from "sonner";
import {
	getQualityProfileOverrides,
	promoteOverrideToTemplate,
	deleteQualityProfileOverride,
	bulkDeleteQualityProfileOverrides,
	type GetOverridesResponse,
	type PromoteOverridePayload,
	type BulkDeleteOverridesPayload,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch quality profile score overrides for an instance
 */
export function useQualityProfileOverrides(
	instanceId: string | null,
	qualityProfileId: number | null,
) {
	return useQuery<GetOverridesResponse>({
		queryKey: ["quality-profile-overrides", instanceId, qualityProfileId],
		queryFn: () => getQualityProfileOverrides(instanceId!, qualityProfileId!),
		enabled: !!instanceId && !!qualityProfileId,
		staleTime: 30 * 1000, // 30 seconds (refresh frequently to show latest changes)
	});
}

/**
 * Hook to promote an instance override to template
 */
export function usePromoteOverride() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			qualityProfileId,
			payload,
		}: {
			instanceId: string;
			qualityProfileId: number;
			payload: PromoteOverridePayload;
		}) => promoteOverrideToTemplate(instanceId, qualityProfileId, payload),
		onSuccess: (_, variables) => {
			// Invalidate override queries for this profile
			queryClient.invalidateQueries({
				queryKey: ["quality-profile-overrides", variables.instanceId, variables.qualityProfileId],
			});
			// Invalidate templates query (template was updated)
			queryClient.invalidateQueries({
				queryKey: TEMPLATES_QUERY_KEY,
			});
			// Invalidate specific template
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "template", variables.payload.templateId],
			});
		},
	});
}

/**
 * Hook to delete a single instance override (revert to template)
 */
export function useDeleteOverride() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			qualityProfileId,
			customFormatId,
		}: {
			instanceId: string;
			qualityProfileId: number;
			customFormatId: number;
		}) => deleteQualityProfileOverride(instanceId, qualityProfileId, customFormatId),
		onSuccess: (data, variables) => {
			// Invalidate override queries for this profile
			queryClient.invalidateQueries({
				queryKey: ["quality-profile-overrides", variables.instanceId, variables.qualityProfileId],
			});
			// Invalidate bulk-scores query used by bulk score manager
			queryClient.invalidateQueries({
				queryKey: ["bulk-scores"],
			});
			// Show success toast if message is provided
			if (data.message) {
				toast.success(data.message);
			}
		},
		onError: (error) => {
			console.error("Failed to delete override:", error);
			toast.error("Failed to delete override", {
				description: error.message,
			});
		},
	});
}

/**
 * Hook to bulk delete instance overrides (revert multiple to template)
 */
export function useBulkDeleteOverrides() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			qualityProfileId,
			payload,
		}: {
			instanceId: string;
			qualityProfileId: number;
			payload: BulkDeleteOverridesPayload;
		}) => bulkDeleteQualityProfileOverrides(instanceId, qualityProfileId, payload),
		onSuccess: (data, variables) => {
			// Invalidate override queries for this profile
			queryClient.invalidateQueries({
				queryKey: ["quality-profile-overrides", variables.instanceId, variables.qualityProfileId],
			});
			// Invalidate bulk-scores query used by bulk score manager
			queryClient.invalidateQueries({
				queryKey: ["bulk-scores"],
			});
			// Show success toast if message is provided
			if (data.message) {
				toast.success(data.message);
			}
		},
		onError: (error) => {
			console.error("Failed to bulk delete overrides:", error);
			toast.error("Failed to delete overrides", {
				description: error.message,
			});
		},
	});
}
