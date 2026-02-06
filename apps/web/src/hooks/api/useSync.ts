/**
 * Sync React Query Hooks
 *
 * React Query hooks for TRaSH Guides sync operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	type RollbackResult,
	type SyncDetail,
	type SyncExecuteRequest,
	type SyncHistoryResponse,
	type SyncProgress,
	type SyncResult,
	type SyncValidationRequest,
	type ValidationResult,
	createSyncProgressStream,
	executeSync,
	getSyncDetail,
	getSyncHistory,
	getSyncProgress,
	rollbackSync,
	validateSync,
} from "../../lib/api-client/sync";

// ============================================================================
// Validation Hook
// ============================================================================

/** Default timeout for validation requests (30 seconds) */
export const VALIDATION_TIMEOUT_MS = 30000;

/** Maximum retry attempts for network/server errors */
export const MAX_RETRY_ATTEMPTS = 2;

/** Base delay for exponential backoff (1 second) */
export const RETRY_BASE_DELAY_MS = 1000;

export interface UseValidateSyncOptions {
	onError?: (error: Error) => void;
	onSuccess?: (data: ValidationResult) => void;
	/** Custom timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
	/** Callback for retry progress updates */
	onRetryProgress?: (attempt: number, maxAttempts: number, delayMs: number) => void;
	/** Callback when retry is cancelled */
	onRetryCancelled?: () => void;
}

/**
 * Check if an error is retryable (network errors or 5xx server errors)
 * Validation failures (4xx) should not be retried
 */
function isRetryableError(error: Error): boolean {
	const message = error.message.toLowerCase();

	// Network errors
	if (
		message.includes("network") ||
		message.includes("fetch") ||
		message.includes("connection") ||
		message.includes("timeout") ||
		message.includes("econnrefused") ||
		message.includes("enotfound") ||
		error.name === "TypeError" // Often indicates network failure
	) {
		return true;
	}

	// 5xx server errors (extract status code from error message)
	const statusMatch = message.match(/\b5\d{2}\b/);
	if (statusMatch) {
		return true;
	}

	// Check for specific server error phrases
	if (
		message.includes("internal server error") ||
		message.includes("service unavailable") ||
		message.includes("gateway") ||
		message.includes("bad gateway")
	) {
		return true;
	}

	return false;
}

/**
 * Retry wrapper with exponential backoff for network/server errors
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts: number;
		baseDelayMs: number;
		onProgress?: (attempt: number, maxAttempts: number, delayMs: number) => void;
		shouldCancel?: () => boolean;
	},
): Promise<T> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= options.maxAttempts + 1; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if we should cancel
			if (options.shouldCancel?.()) {
				throw new Error("Validation cancelled by user");
			}

			// Don't retry if it's the last attempt or not a retryable error
			if (attempt > options.maxAttempts || !isRetryableError(lastError)) {
				throw lastError;
			}

			// Calculate delay with exponential backoff
			const delayMs = options.baseDelayMs * Math.pow(2, attempt - 1);

			// Notify about retry progress
			options.onProgress?.(attempt, options.maxAttempts, delayMs);

			// Wait before retrying
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw lastError ?? new Error("Unexpected retry failure");
}

export function useValidateSync(options?: UseValidateSyncOptions) {
	const timeoutMs = options?.timeoutMs ?? VALIDATION_TIMEOUT_MS;
	// Use ref instead of state to avoid stale closure issues in shouldCancel callback
	const cancelRetryRef = useRef(false);

	// Reset cancel flag when mutation starts
	const resetCancel = () => {
		cancelRetryRef.current = false;
	};

	// Expose cancel function for external use
	const cancelRetry = () => {
		cancelRetryRef.current = true;
		options?.onRetryCancelled?.();
	};

	const mutation = useMutation<ValidationResult, Error, SyncValidationRequest>({
		mutationFn: async (request) => {
			resetCancel();

			return withRetry(
				async () => {
					// Create an AbortController for timeout handling
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

					try {
						// Pass the abort signal to validateSync for proper timeout handling
						const result = await validateSync(request, { signal: controller.signal });
						clearTimeout(timeoutId);
						return result;
					} catch (error) {
						clearTimeout(timeoutId);
						if (error instanceof Error && error.name === "AbortError") {
							throw new Error(`Validation timed out after ${timeoutMs / 1000} seconds`);
						}
						throw error;
					}
				},
				{
					maxAttempts: MAX_RETRY_ATTEMPTS,
					baseDelayMs: RETRY_BASE_DELAY_MS,
					onProgress: options?.onRetryProgress,
					// Access ref.current to always get the latest value
					shouldCancel: () => cancelRetryRef.current,
				},
			);
		},
		onError: (error) => {
			// Enhanced error logging with timestamp
			console.error("[useValidateSync] Validation failed:", {
				message: error.message,
				name: error.name,
				timestamp: new Date().toISOString(),
			});
			options?.onError?.(error);
		},
		onSuccess: (data, variables) => {
			// Enhanced logging with full context for debugging
			const logContext = {
				valid: data.valid,
				errorsCount: data.errors?.length ?? 0,
				warningsCount: data.warnings?.length ?? 0,
				conflictsCount: data.conflicts?.length ?? 0,
				templateId: variables.templateId,
				instanceId: variables.instanceId,
				timestamp: new Date().toISOString(),
			};

			if (!data.valid && (data.errors?.length ?? 0) === 0) {
				console.warn(
					"[useValidateSync] Silent failure detected - validation invalid with no errors:",
					logContext,
				);
				console.warn("[useValidateSync] Full validation response:", data);
			} else if (process.env.NODE_ENV === "development") {
				console.log("[useValidateSync] Validation completed:", logContext);
			}
			options?.onSuccess?.(data);
		},
	});

	// Return mutation with cancelRetry function for external control
	return {
		...mutation,
		cancelRetry,
	};
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
		} catch {
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

export function useSyncHistory(instanceId: string, params?: { limit?: number; offset?: number }) {
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

interface RollbackVariables {
	syncId: string;
	/** Optional instanceId for targeted cache invalidation. When provided,
	 * only that instance's sync history is invalidated instead of all instances. */
	instanceId?: string;
}

export function useRollbackSync() {
	const queryClient = useQueryClient();

	return useMutation<RollbackResult, Error, RollbackVariables>({
		mutationFn: ({ syncId }) => rollbackSync(syncId),
		onSuccess: (data, variables) => {
			// Invalidate sync detail
			queryClient.invalidateQueries({
				queryKey: ["sync-detail", variables.syncId],
			});

			// Invalidate sync history - targeted if instanceId provided
			if (variables.instanceId) {
				queryClient.invalidateQueries({
					queryKey: ["sync-history", variables.instanceId],
				});
			} else {
				// Global invalidation when instanceId not available
				// This may cause cross-instance refetches but ensures data consistency
				queryClient.invalidateQueries({
					queryKey: ["sync-history"],
				});
			}
		},
	});
}
