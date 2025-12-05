import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TEMPLATES_QUERY_KEY } from "./useTemplates";
import {
	checkForUpdates,
	getTemplatesNeedingAttention,
	syncTemplate,
	processAutoUpdates,
	getLatestVersion,
	getSchedulerStatus,
	triggerUpdateCheck,
	getTemplateDiff,
	type SyncTemplatePayload,
	type UpdateCheckResponse,
	type AttentionResponse,
	type LatestVersionResponse,
	type SchedulerStatusResponse,
	type TemplateDiffResponse,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to check for available template updates
 */
export function useTemplateUpdates(options?: { refetchInterval?: number }) {
	return useQuery<UpdateCheckResponse>({
		queryKey: ["trash-guides", "updates"],
		queryFn: checkForUpdates,
		refetchInterval: options?.refetchInterval,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to get templates requiring user attention
 */
export function useTemplatesNeedingAttention() {
	return useQuery<AttentionResponse>({
		queryKey: ["trash-guides", "updates", "attention"],
		queryFn: getTemplatesNeedingAttention,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to get latest TRaSH Guides version
 */
export function useLatestVersion() {
	return useQuery<LatestVersionResponse>({
		queryKey: ["trash-guides", "updates", "version", "latest"],
		queryFn: getLatestVersion,
		staleTime: 15 * 60 * 1000, // 15 minutes
	});
}

/**
 * Hook to get scheduler status
 */
export function useSchedulerStatus(options?: { refetchInterval?: number }) {
	return useQuery<SchedulerStatusResponse>({
		queryKey: ["trash-guides", "updates", "scheduler", "status"],
		queryFn: getSchedulerStatus,
		refetchInterval: options?.refetchInterval,
		staleTime: 60 * 1000, // 1 minute
	});
}

/**
 * Hook to sync a specific template
 */
export function useSyncTemplate() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			templateId,
			payload,
		}: {
			templateId: string;
			payload?: SyncTemplatePayload;
		}) => syncTemplate(templateId, payload),
		onSuccess: () => {
			// Invalidate relevant queries
			queryClient.invalidateQueries({ queryKey: ["trash-guides", "updates"] });
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "updates", "attention"],
			});
			queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
}

/**
 * Hook to process all auto-sync eligible templates
 */
export function useProcessAutoUpdates() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: processAutoUpdates,
		onSuccess: () => {
			// Invalidate relevant queries
			queryClient.invalidateQueries({ queryKey: ["trash-guides", "updates"] });
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "updates", "attention"],
			});
			queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
}

/**
 * Hook to manually trigger an update check
 *
 * The backend waits for the update check to complete before responding,
 * so we can immediately invalidate queries once we receive the response.
 */
export function useTriggerUpdateCheck() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: triggerUpdateCheck,
		onSuccess: () => {
			// The backend waits for the update check to complete before responding,
			// so we can immediately invalidate queries without a timeout
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "updates"],
			});
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "updates", "attention"],
			});
			queryClient.invalidateQueries({
				queryKey: ["trash-guides", "updates", "scheduler", "status"],
			});
		},
	});
}

/**
 * Hook to fetch template diff comparison
 */
export function useTemplateDiff(templateId: string | null, targetCommit?: string) {
	return useQuery<TemplateDiffResponse>({
		queryKey: ["trash-guides", "updates", "diff", templateId, targetCommit],
		queryFn: () => getTemplateDiff(templateId!, targetCommit),
		enabled: !!templateId,
		staleTime: 2 * 60 * 1000, // 2 minutes
	});
}
