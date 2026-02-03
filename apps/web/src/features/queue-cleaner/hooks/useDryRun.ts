import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { CleanerResult, EnhancedPreviewResult } from "../lib/queue-cleaner-types";

async function runDryRun(instanceId: string): Promise<CleanerResult> {
	return apiRequest<CleanerResult>(`/api/queue-cleaner/dry-run/${instanceId}`, {
		method: "POST",
	});
}

async function runEnhancedPreview(instanceId: string): Promise<EnhancedPreviewResult> {
	return apiRequest<EnhancedPreviewResult>(`/api/queue-cleaner/preview/${instanceId}`, {
		method: "POST",
	});
}

async function triggerClean(instanceId: string): Promise<{ triggered: boolean; message: string }> {
	return apiRequest<{ triggered: boolean; message: string }>(`/api/queue-cleaner/trigger/${instanceId}`, {
		method: "POST",
	});
}

export function useDryRun() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: (instanceId: string) => runDryRun(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	return {
		runDryRun: (instanceId: string) => mutation.mutateAsync(instanceId),
		result: mutation.data ?? null,
		isRunning: mutation.isPending,
		error: mutation.error,
		reset: mutation.reset,
	};
}

export function useEnhancedPreview() {
	const queryClient = useQueryClient();

	const previewMutation = useMutation({
		mutationFn: (instanceId: string) => runEnhancedPreview(instanceId),
	});

	const cleanMutation = useMutation({
		mutationFn: (instanceId: string) => triggerClean(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	return {
		runPreview: (instanceId: string) => previewMutation.mutateAsync(instanceId),
		runClean: (instanceId: string) => cleanMutation.mutateAsync(instanceId),
		previewResult: previewMutation.data ?? null,
		isLoadingPreview: previewMutation.isPending,
		isRunningClean: cleanMutation.isPending,
		previewError: previewMutation.error,
		cleanError: cleanMutation.error,
		resetPreview: previewMutation.reset,
	};
}
