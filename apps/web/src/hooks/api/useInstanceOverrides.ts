import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	getInstanceOverrides,
	updateInstanceOverrides,
	deleteInstanceOverrides,
	type InstanceOverridesResponse,
	type UpdateInstanceOverridesPayload,
	type UpdateInstanceOverridesResponse,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch instance-specific overrides for a template
 */
export function useInstanceOverrides(
	templateId: string | null,
	instanceId: string | null,
) {
	return useQuery<InstanceOverridesResponse>({
		queryKey: ["trash-guides", "instance-overrides", templateId, instanceId],
		queryFn: () => getInstanceOverrides(templateId!, instanceId!),
		enabled: !!templateId && !!instanceId,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to update instance-specific overrides
 */
export function useUpdateInstanceOverrides() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			templateId,
			instanceId,
			payload,
		}: {
			templateId: string;
			instanceId: string;
			payload: UpdateInstanceOverridesPayload;
		}) => updateInstanceOverrides(templateId, instanceId, payload),
		onSuccess: (_, variables) => {
			// Invalidate instance overrides query
			queryClient.invalidateQueries({
				queryKey: [
					"trash-guides",
					"instance-overrides",
					variables.templateId,
					variables.instanceId,
				],
			});
			// Invalidate deployment preview (since overrides affect it)
			queryClient.invalidateQueries({
				queryKey: [
					"trash-guides",
					"deployment",
					"preview",
					variables.templateId,
					variables.instanceId,
				],
			});
		},
	});
}

/**
 * Hook to delete instance-specific overrides
 */
export function useDeleteInstanceOverrides() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			templateId,
			instanceId,
		}: {
			templateId: string;
			instanceId: string;
		}) => deleteInstanceOverrides(templateId, instanceId),
		onSuccess: (_, variables) => {
			// Invalidate instance overrides query
			queryClient.invalidateQueries({
				queryKey: [
					"trash-guides",
					"instance-overrides",
					variables.templateId,
					variables.instanceId,
				],
			});
			// Invalidate deployment preview
			queryClient.invalidateQueries({
				queryKey: [
					"trash-guides",
					"deployment",
					"preview",
					variables.templateId,
					variables.instanceId,
				],
			});
		},
	});
}
