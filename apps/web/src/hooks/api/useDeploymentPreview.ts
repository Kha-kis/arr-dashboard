import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	getDeploymentPreview,
	executeDeployment,
	executeBulkDeployment,
	type DeploymentPreviewResponse,
	type ExecuteDeploymentPayload,
	type ExecuteDeploymentResponse,
	type ExecuteBulkDeploymentPayload,
	type ExecuteBulkDeploymentResponse,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch deployment preview for template → instance
 */
export function useDeploymentPreview(
	templateId: string | null,
	instanceId: string | null,
) {
	return useQuery<DeploymentPreviewResponse>({
		queryKey: ["trash-guides", "deployment", "preview", templateId, instanceId],
		queryFn: () => getDeploymentPreview(templateId!, instanceId!),
		enabled: !!templateId && !!instanceId,
		staleTime: 2 * 60 * 1000, // 2 minutes
		retry: false, // Don't retry on failure (likely instance unreachable)
	});
}

/**
 * Hook to execute deployment to instance
 */
export function useExecuteDeployment() {
	const queryClient = useQueryClient();

	return useMutation<ExecuteDeploymentResponse, Error, ExecuteDeploymentPayload>({
		mutationFn: (payload) => executeDeployment(payload),
		onSuccess: () => {
			// Invalidate relevant queries
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "deployment"],
			});
			queryClient.invalidateQueries({
				queryKey: ["deployment-history"],
			});
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "templates"],
			});
		},
	});
}

/**
 * Hook to execute bulk deployment to multiple instances
 */
export function useExecuteBulkDeployment() {
	const queryClient = useQueryClient();

	return useMutation<ExecuteBulkDeploymentResponse, Error, ExecuteBulkDeploymentPayload>({
		mutationFn: (payload) => executeBulkDeployment(payload),
		onSuccess: () => {
			// Invalidate relevant queries
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "deployment"],
			});
			queryClient.invalidateQueries({
				queryKey: ["deployment-history"],
			});
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "templates"],
			});
		},
	});
}
