import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { TEMPLATES_QUERY_KEY } from "./useTemplates";
import {
	getDeploymentPreview,
	executeDeployment,
	executeBulkDeployment,
	updateSyncStrategy,
	bulkUpdateSyncStrategy,
	unlinkTemplateFromInstance,
	type DeploymentPreviewResponse,
	type ExecuteDeploymentPayload,
	type ExecuteDeploymentResponse,
	type ExecuteBulkDeploymentPayload,
	type ExecuteBulkDeploymentResponse,
	type UpdateSyncStrategyPayload,
	type UpdateSyncStrategyResponse,
	type BulkUpdateSyncStrategyPayload,
	type BulkUpdateSyncStrategyResponse,
	type UnlinkTemplatePayload,
	type UnlinkTemplateResponse,
} from "../../lib/api-client/trash-guides";

export type InstancePreviewResult = {
	instanceId: string;
	isLoading: boolean;
	isError: boolean;
	error: Error | null;
	data: DeploymentPreviewResponse | undefined;
};

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
				queryKey: TEMPLATES_QUERY_KEY,
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
				queryKey: TEMPLATES_QUERY_KEY,
			});
		},
	});
}

/**
 * Hook to fetch deployment previews for multiple instances in parallel.
 * Uses React Query's useQueries for efficient parallel fetching with
 * automatic caching, deduplication, and error handling.
 */
export function useBulkDeploymentPreviews(
	templateId: string | null,
	instanceIds: string[],
): {
	results: InstancePreviewResult[];
	isLoading: boolean;
	hasErrors: boolean;
} {
	const queries = useQueries({
		queries: instanceIds.map((instanceId) => ({
			queryKey: ["trash-guides", "deployment", "preview", templateId, instanceId],
			queryFn: () => getDeploymentPreview(templateId!, instanceId),
			enabled: !!templateId && instanceIds.length > 0,
			staleTime: 2 * 60 * 1000, // 2 minutes
			retry: false, // Don't retry on failure (likely instance unreachable)
		})),
	});

	const results: InstancePreviewResult[] = queries.map((query, index) => ({
		instanceId: instanceIds[index]!,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		data: query.data,
	}));

	return {
		results,
		isLoading: queries.some((q) => q.isLoading),
		hasErrors: queries.some((q) => q.isError),
	};
}

/**
 * Hook to update sync strategy for a single instance deployment
 */
export function useUpdateSyncStrategy() {
	const queryClient = useQueryClient();

	return useMutation<UpdateSyncStrategyResponse, Error, UpdateSyncStrategyPayload>({
		mutationFn: (payload) => updateSyncStrategy(payload),
		onSuccess: (_data, variables) => {
			// Invalidate template stats for the specific template
			queryClient.invalidateQueries({
				queryKey: ["template-stats", variables.templateId],
			});
			// Also invalidate deployment queries
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "deployment"],
			});
		},
		onError: (error) => {
			console.error("Failed to update sync strategy:", error);
			toast.error("Failed to update sync strategy", {
				description: error.message,
			});
		},
	});
}

/**
 * Hook to bulk update sync strategy for all instances of a template
 */
export function useBulkUpdateSyncStrategy() {
	const queryClient = useQueryClient();

	return useMutation<BulkUpdateSyncStrategyResponse, Error, BulkUpdateSyncStrategyPayload>({
		mutationFn: (payload) => bulkUpdateSyncStrategy(payload),
		onSuccess: (_data, variables) => {
			// Invalidate template stats for the specific template
			queryClient.invalidateQueries({
				queryKey: ["template-stats", variables.templateId],
			});
			// Also invalidate deployment queries
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "deployment"],
			});
		},
		onError: (error) => {
			console.error("Failed to bulk update sync strategy:", error);
			toast.error("Failed to update sync strategy", {
				description: error.message,
			});
		},
	});
}

/**
 * Hook to unlink a template from an instance
 */
export function useUnlinkTemplateFromInstance() {
	const queryClient = useQueryClient();

	return useMutation<UnlinkTemplateResponse, Error, UnlinkTemplatePayload>({
		mutationFn: (payload) => unlinkTemplateFromInstance(payload),
		onSuccess: (data) => {
			// Show success toast
			toast.success("Template unlinked", {
				description: data.message,
			});

			// Invalidate templates list
			queryClient.invalidateQueries({
				queryKey: TEMPLATES_QUERY_KEY,
			});
			// Invalidate template stats for the specific template
			queryClient.invalidateQueries({
				queryKey: ["template-stats", data.data.templateId],
			});
			// Invalidate deployment queries
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "deployment"],
			});
		},
		onError: (error) => {
			console.error("Unlink failed:", error);
			toast.error("Failed to unlink template from instance", {
				description: error.message,
			});
		},
	});
}
