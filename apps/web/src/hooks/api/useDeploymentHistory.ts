import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type DeploymentHistoryDetailResponse,
	type DeploymentHistoryResponse,
	deleteDeploymentHistory,
	getAllDeploymentHistory,
	getDeploymentHistoryDetail,
	getInstanceDeploymentHistory,
	getTemplateDeploymentHistory,
	type UndeployResponse,
	undeployDeployment,
} from "../../lib/api-client/trash-guides";
import { deploymentHistoryKeys } from "../../lib/query-keys";

/**
 * Hook to fetch all deployment history (global view)
 */
export function useAllDeploymentHistory(options?: { limit?: number; offset?: number }) {
	return useQuery<DeploymentHistoryResponse, Error>({
		queryKey: deploymentHistoryKeys.allHistory(options),
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
		queryKey: deploymentHistoryKeys.template(templateId!, options),
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
		queryKey: deploymentHistoryKeys.instance(instanceId!, options),
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
		queryKey: deploymentHistoryKeys.detail(historyId!),
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
				queryKey: deploymentHistoryKeys.all,
			});

			// Invalidate the specific history detail
			queryClient.invalidateQueries({
				queryKey: deploymentHistoryKeys.detail(historyId!),
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
				queryKey: deploymentHistoryKeys.all,
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
	// Build queryKey using centralized key factories
	const queryKey = templateId
		? deploymentHistoryKeys.template(templateId, options)
		: instanceId
			? deploymentHistoryKeys.instance(instanceId, options)
			: deploymentHistoryKeys.allHistory(options);

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
