/**
 * Sync API Client
 *
 * API functions for TRaSH Guides sync operations
 */

import { apiRequest } from "./base";

// ============================================================================
// Types
// ============================================================================

export interface SyncValidationRequest {
	templateId: string;
	instanceId: string;
}

export interface ConflictInfo {
	configName: string;
	existingId: number;
	action: "REPLACE" | "SKIP" | "KEEP_EXISTING";
	reason: string;
}

export interface ValidationResult {
	valid: boolean;
	conflicts: ConflictInfo[];
	errors: string[];
	warnings: string[];
}

export interface SyncExecuteRequest {
	templateId: string;
	instanceId: string;
	syncType: "MANUAL" | "SCHEDULED";
	conflictResolutions?: Record<string, "REPLACE" | "SKIP">;
}

export interface SyncError {
	configName: string;
	error: string;
	retryable: boolean;
}

export interface SyncResult {
	syncId: string;
	success: boolean;
	status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
	duration: number;
	configsApplied: number;
	configsFailed: number;
	configsSkipped: number;
	errors: SyncError[];
	backupId?: string;
}

export type SyncProgressStatus =
	| "INITIALIZING"
	| "VALIDATING"
	| "BACKING_UP"
	| "APPLYING"
	| "COMPLETED"
	| "FAILED";

export interface SyncProgress {
	syncId: string;
	status: SyncProgressStatus;
	currentStep: string;
	progress: number; // 0-100
	totalConfigs: number;
	appliedConfigs: number;
	failedConfigs: number;
	errors: SyncError[];
}

export interface SyncHistoryItem {
	id: string;
	templateId: string;
	templateName: string;
	status: string;
	syncType: string;
	startedAt: string;
	completedAt: string | null;
	duration: number | null;
	configsApplied: number;
	configsFailed: number;
	configsSkipped: number;
	backupId: string | null;
}

export interface SyncHistoryResponse {
	syncs: SyncHistoryItem[];
	total: number;
}

export interface SyncDetail {
	id: string;
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceName: string;
	status: string;
	syncType: string;
	startedAt: string;
	completedAt: string | null;
	duration: number | null;
	configsApplied: number;
	configsFailed: number;
	configsSkipped: number;
	appliedConfigs: any[] | null;
	failedConfigs: any[] | null;
	errorLog: string | null;
	backupId: string | null;
}

export interface RollbackResult {
	success: boolean;
	restoredCount: number;
	failedCount: number;
	errors: string[];
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Validate sync before execution
 * @param request - The sync validation request
 * @param options - Optional fetch options (e.g., AbortSignal for timeout)
 */
export async function validateSync(
	request: SyncValidationRequest,
	options?: { signal?: AbortSignal },
): Promise<ValidationResult> {
	return await apiRequest<ValidationResult>("/api/trash-guides/sync/validate", {
		method: "POST",
		json: request,
		signal: options?.signal,
	});
}

/**
 * Execute sync operation
 */
export async function executeSync(request: SyncExecuteRequest): Promise<SyncResult> {
	return await apiRequest<SyncResult>("/api/trash-guides/sync/execute", {
		method: "POST",
		json: request,
	});
}

/**
 * Get sync progress (polling)
 */
export async function getSyncProgress(syncId: string): Promise<SyncProgress> {
	return await apiRequest<SyncProgress>(`/api/trash-guides/sync/${syncId}/progress`);
}

/**
 * Get sync history for instance
 */
export async function getSyncHistory(
	instanceId: string,
	params?: { limit?: number; offset?: number },
): Promise<SyncHistoryResponse> {
	const queryParams = params
		? `?limit=${params.limit || 20}&offset=${params.offset || 0}`
		: "";
	return await apiRequest<SyncHistoryResponse>(
		`/api/trash-guides/sync/history/${instanceId}${queryParams}`,
	);
}

/**
 * Get sync details
 */
export async function getSyncDetail(syncId: string): Promise<SyncDetail> {
	return await apiRequest<SyncDetail>(`/api/trash-guides/sync/${syncId}`);
}

/**
 * Rollback sync to backup
 */
export async function rollbackSync(syncId: string): Promise<RollbackResult> {
	return await apiRequest<RollbackResult>(`/api/trash-guides/sync/${syncId}/rollback`, {
		method: "POST",
	});
}

/**
 * Create EventSource for SSE progress streaming
 */
export function createSyncProgressStream(
	syncId: string,
	onProgress: (progress: SyncProgress) => void,
	onError?: (error: Error) => void,
): EventSource {
	const eventSource = new EventSource(`/api/trash-guides/sync/${syncId}/stream`);

	eventSource.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);

			// Ignore connection message
			if (data.type === "connected") {
				return;
			}

			// Handle error message
			if (data.type === "error") {
				onError?.(new Error(data.message));
				eventSource.close();
				return;
			}

			// Handle progress update
			onProgress(data);

			// Close on completion
			if (data.status === "COMPLETED" || data.status === "FAILED") {
				setTimeout(() => {
					eventSource.close();
				}, 1000);
			}
		} catch (error) {
			onError?.(error instanceof Error ? error : new Error("Failed to parse progress"));
		}
	};

	eventSource.onerror = (error) => {
		onError?.(new Error("Stream connection failed"));
		eventSource.close();
	};

	return eventSource;
}
