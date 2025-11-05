/**
 * Sync React Query Hooks
 *
 * React Query hooks for TRaSH Guides sync operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	validateSync,
	executeSync,
	getSyncProgress,
	getSyncHistory,
	getSyncDetail,
	rollbackSync,
	createSyncProgressStream,
	type SyncValidationRequest,
	type SyncExecuteRequest,
	type ValidationResult,
	type SyncResult,
	type SyncProgress,
	type SyncHistoryResponse,
	type SyncDetail,
	type RollbackResult,
} from "../../lib/api-client/sync";

// ============================================================================
// Validation Hook
// ============================================================================

export function useValidateSync() {
	return useMutation<ValidationResult, Error, SyncValidationRequest>({
		mutationFn: validateSync,
	});
}

// ============================================================================
// Execute Sync Hook
// ============================================================================

export function useExecuteSync() {
	const queryClient = useQueryClient();

	return useMutation<SyncResult, Error, SyncExecuteRequest>({
		mutationFn: executeSync,
		onSuccess: (data, variables) => {
			// Invalidate sync history for the instance
			queryClient.invalidateQueries({
				queryKey: ["sync-history", variables.instanceId],
			});

			// Invalidate template stats
			queryClient.invalidateQueries({
				queryKey: ["template-stats", variables.templateId],
			});
		},
	});
}

// ============================================================================
// Progress Streaming Hook with SSE and Polling Fallback
// ============================================================================

export function useSyncProgress(syncId: string | null, enabled = true) {
	const [progress, setProgress] = useState<SyncProgress | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [usePolling, setUsePolling] = useState(false);

	// SSE streaming
	useEffect(() => {
		if (!syncId || !enabled || usePolling) return;

		let eventSource: EventSource | null = null;

		try {
			eventSource = createSyncProgressStream(
				syncId,
				(progressUpdate) => {
					setProgress(progressUpdate);
					setError(null);
				},
				(streamError) => {
					console.warn("SSE failed, falling back to polling:", streamError);
					setError(streamError);
					setUsePolling(true); // Fall back to polling on SSE failure
				},
			);
		} catch (err) {
			console.warn("SSE not supported, using polling fallback");
			setUsePolling(true);
		}

		return () => {
			if (eventSource) {
				eventSource.close();
			}
		};
	}, [syncId, enabled, usePolling]);

	// Polling fallback
	const pollingQuery = useQuery({
		queryKey: ["sync-progress", syncId],
		queryFn: () => getSyncProgress(syncId!),
		enabled: enabled && usePolling && !!syncId,
		refetchInterval: (query) => {
			const data = query.state.data;
			// Stop polling when completed or failed
			if (data?.status === "COMPLETED" || data?.status === "FAILED") {
				return false;
			}
			return 2000; // Poll every 2 seconds
		},
		retry: false,
	});

	// Update progress from polling
	useEffect(() => {
		if (usePolling && pollingQuery.data) {
			setProgress(pollingQuery.data);
		}
	}, [usePolling, pollingQuery.data]);

	return {
		progress: usePolling ? pollingQuery.data : progress,
		error: usePolling ? pollingQuery.error : error,
		isLoading: usePolling ? pollingQuery.isLoading : !progress && !error,
		isPolling: usePolling,
	};
}

// ============================================================================
// Sync History Hook
// ============================================================================

export function useSyncHistory(
	instanceId: string,
	params?: { limit?: number; offset?: number },
) {
	return useQuery<SyncHistoryResponse, Error>({
		queryKey: ["sync-history", instanceId, params],
		queryFn: () => getSyncHistory(instanceId, params),
		enabled: !!instanceId,
	});
}

// ============================================================================
// Sync Detail Hook
// ============================================================================

export function useSyncDetail(syncId: string | null) {
	return useQuery<SyncDetail, Error>({
		queryKey: ["sync-detail", syncId],
		queryFn: () => getSyncDetail(syncId!),
		enabled: !!syncId,
	});
}

// ============================================================================
// Rollback Hook
// ============================================================================

export function useRollbackSync() {
	const queryClient = useQueryClient();

	return useMutation<RollbackResult, Error, string>({
		mutationFn: rollbackSync,
		onSuccess: (data, syncId) => {
			// Invalidate sync detail
			queryClient.invalidateQueries({
				queryKey: ["sync-detail", syncId],
			});

			// Invalidate sync history
			queryClient.invalidateQueries({
				queryKey: ["sync-history"],
			});
		},
	});
}
