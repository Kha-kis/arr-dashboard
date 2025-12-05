import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	getAllDeploymentHistory,
	getTemplateDeploymentHistory,
	getInstanceDeploymentHistory,
	getDeploymentHistoryDetail,
	undeployDeployment,
	deleteDeploymentHistory,
	type DeploymentHistoryResponse,
	type DeploymentHistoryDetailResponse,
	type UndeployResponse,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch all deployment history (global view)
 */
export function useAllDeploymentHistory(options?: { limit?: number; offset?: number }) {
	return useQuery<DeploymentHistoryResponse, Error>({
		queryKey: ["deployment-history", "all", options],
		queryFn: () => getAllDeploymentHistory(options),
	});
}

/**
 * Hook to fetch deployment history for a template
 */
export function useTemplateDeploymentHistory(
	templateId: string | null,
	options?: { limit?: number; offset?: number },
) {
	return useQuery<DeploymentHistoryResponse, Error>({
		queryKey: ["deployment-history", "template", templateId, options],
		queryFn: () => {
			if (!templateId) throw new Error("Template ID is required");
			return getTemplateDeploymentHistory(templateId, options);
		},
		enabled: !!templateId,
	});
}

/**
 * Hook to fetch deployment history for an instance
 */
export function useInstanceDeploymentHistory(
	instanceId: string | null,
	options?: { limit?: number; offset?: number },
) {
	return useQuery<DeploymentHistoryResponse, Error>({
		queryKey: ["deployment-history", "instance", instanceId, options],
		queryFn: () => {
			if (!instanceId) throw new Error("Instance ID is required");
			return getInstanceDeploymentHistory(instanceId, options);
		},
		enabled: !!instanceId,
	});
}

/**
 * Hook to fetch detailed deployment history entry
 */
export function useDeploymentHistoryDetail(historyId: string | null) {
	return useQuery<DeploymentHistoryDetailResponse, Error>({
		queryKey: ["deployment-history", "detail", historyId],
		queryFn: () => {
			if (!historyId) throw new Error("History ID is required");
			return getDeploymentHistoryDetail(historyId);
		},
		enabled: !!historyId,
	});
}

/**
 * Hook to undeploy a deployment (remove CFs unique to this template)
 */
export function useUndeployDeployment() {
	const queryClient = useQueryClient();

	return useMutation<UndeployResponse, Error, string>({
		mutationFn: (historyId: string) => undeployDeployment(historyId),
		onSuccess: (data, historyId) => {
			// Invalidate deployment history queries to refetch updated data
			queryClient.invalidateQueries({
				queryKey: ["deployment-history"],
			});

			// Invalidate the specific history detail
			queryClient.invalidateQueries({
				queryKey: ["deployment-history", "detail", historyId],
			});
		},
	});
}

/**
 * Hook to delete a deployment history entry
 */
export function useDeleteDeploymentHistory() {
	const queryClient = useQueryClient();

	return useMutation<{ success: boolean; message: string }, Error, string>({
		mutationFn: (historyId: string) => deleteDeploymentHistory(historyId),
		onSuccess: () => {
			// Invalidate all deployment history queries to refetch updated data
			queryClient.invalidateQueries({
				queryKey: ["deployment-history"],
			});
		},
	});
}

/**
 * Unified hook to fetch deployment history based on optional templateId or instanceId.
 * Calls the appropriate API based on which ID is provided:
 * - templateId provided: fetch template-specific history
 * - instanceId provided: fetch instance-specific history
 * - neither provided: fetch all history
 */
export function useDeploymentHistory(
	templateId?: string,
	instanceId?: string,
	options?: { limit?: number; offset?: number },
) {
	// Determine which query to use based on provided IDs
	const queryType = templateId ? "template" : instanceId ? "instance" : "all";
	const queryId = templateId || instanceId;

	// Build queryKey conditionally - omit queryId when undefined to match useAllDeploymentHistory
	const queryKey = queryId
		? ["deployment-history", queryType, queryId, options]
		: ["deployment-history", queryType, options];

	return useQuery<DeploymentHistoryResponse, Error>({
		queryKey,
		queryFn: () => {
			if (templateId) {
				return getTemplateDeploymentHistory(templateId, options);
			}
			if (instanceId) {
				return getInstanceDeploymentHistory(instanceId, options);
			}
			return getAllDeploymentHistory(options);
		},
	});
}
