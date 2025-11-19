import type { TrashCacheStatus, TrashCacheEntry } from "@arr/shared";
import { apiRequest } from "./base";

export type TrashCacheStatusResponse = {
	radarr: TrashCacheStatus[];
	sonarr: TrashCacheStatus[];
	stats?: {
		totalEntries: number;
		staleEntries: number;
		totalSizeBytes: number;
		oldestEntry?: string;
		newestEntry?: string;
	};
};

export type RefreshCachePayload = {
	serviceType: "RADARR" | "SONARR";
	configType?: "CUSTOM_FORMATS" | "CF_GROUPS" | "QUALITY_SIZE" | "NAMING";
	force?: boolean;
};

export type RefreshCacheResponse = {
	message: string;
	refreshed: boolean;
	results?: Record<string, unknown>;
	status?: TrashCacheStatus;
};

/**
 * Fetch cache status for all services or a specific service
 */
export async function fetchCacheStatus(
	serviceType?: "RADARR" | "SONARR",
): Promise<TrashCacheStatusResponse> {
	const url = serviceType
		? `/api/trash-guides/cache/status?serviceType=${serviceType}`
		: "/api/trash-guides/cache/status";

	return await apiRequest<TrashCacheStatusResponse>(url);
}

/**
 * Refresh cache from GitHub
 */
export async function refreshCache(payload: RefreshCachePayload): Promise<RefreshCacheResponse> {
	return await apiRequest<RefreshCacheResponse>("/api/trash-guides/cache/refresh", {
		method: "POST",
		json: payload,
	});
}

// ============================================================================
// Instance Quality Profile Override Operations
// ============================================================================

export type InstanceOverride = {
	id: string;
	instanceId: string;
	qualityProfileId: number;
	customFormatId: number;
	score: number;
	userId: string;
	createdAt: string;
	updatedAt: string;
};

export type GetOverridesResponse = {
	success: boolean;
	overrides: InstanceOverride[];
};

export type PromoteOverridePayload = {
	customFormatId: number;
	templateId: string;
};

export type PromoteOverrideResponse = {
	success: boolean;
	message: string;
	templateId: string;
	customFormatId: number;
	newScore: number;
};

export type DeleteOverrideResponse = {
	success: boolean;
	message: string;
	customFormatId: number;
};

export type BulkDeleteOverridesPayload = {
	customFormatIds: number[];
};

export type BulkDeleteOverridesResponse = {
	success: boolean;
	message: string;
	deletedCount: number;
};

/**
 * Get instance-level score overrides for a quality profile
 */
export async function getQualityProfileOverrides(
	instanceId: string,
	qualityProfileId: number,
): Promise<GetOverridesResponse> {
	return await apiRequest<GetOverridesResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides`,
	);
}

/**
 * Promote an instance override to template (updates all instances using that template)
 */
export async function promoteOverrideToTemplate(
	instanceId: string,
	qualityProfileId: number,
	payload: PromoteOverridePayload,
): Promise<PromoteOverrideResponse> {
	return await apiRequest<PromoteOverrideResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/promote-override`,
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Delete an instance override (revert to template/default score)
 */
export async function deleteQualityProfileOverride(
	instanceId: string,
	qualityProfileId: number,
	customFormatId: number,
): Promise<DeleteOverrideResponse> {
	return await apiRequest<DeleteOverrideResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides/${customFormatId}`,
		{
			method: "DELETE",
		},
	);
}

/**
 * Bulk delete instance overrides (revert multiple to template/default scores)
 */
export async function bulkDeleteQualityProfileOverrides(
	instanceId: string,
	qualityProfileId: number,
	payload: BulkDeleteOverridesPayload,
): Promise<BulkDeleteOverridesResponse> {
	return await apiRequest<BulkDeleteOverridesResponse>(
		`/api/trash-guides/instances/${instanceId}/quality-profiles/${qualityProfileId}/overrides/bulk-delete`,
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Fetch cache entries with data
 */
export async function fetchCacheEntries(
	serviceType: "RADARR" | "SONARR",
): Promise<TrashCacheEntry[]> {
	return await apiRequest<TrashCacheEntry[]>(
		`/api/trash-guides/cache/entries?serviceType=${serviceType}`,
	);
}

/**
 * Delete specific cache entry
 */
export async function deleteCacheEntry(
	serviceType: "RADARR" | "SONARR",
	configType: "CUSTOM_FORMATS" | "CF_GROUPS" | "QUALITY_SIZE" | "NAMING",
): Promise<void> {
	await apiRequest<void>(`/api/trash-guides/cache/${serviceType}/${configType}`, {
		method: "DELETE",
	});
}

/**
 * Quality Profile API Types and Functions
 */

export type QualityProfileSummary = {
	trashId: string;
	name: string;
	description?: string;
	scoreSet?: string;
	upgradeAllowed: boolean;
	cutoff: string;
	language?: string;
	customFormatCount: number;
	qualityCount: number;
};

export type QualityProfilesResponse = {
	profiles: QualityProfileSummary[];
	count: number;
};

export type ImportQualityProfilePayload = {
	serviceType: "RADARR" | "SONARR";
	trashId: string;
	templateName: string;
	templateDescription?: string;
};

export type UpdateQualityProfileTemplatePayload = {
	templateId: string;
	serviceType: "RADARR" | "SONARR";
	trashId?: string; // Optional - not needed when updating existing template
	templateName: string;
	templateDescription?: string;
};

export type ImportQualityProfileResponse = {
	template: unknown;
	message: string;
	customFormatsIncluded: number;
};

/**
 * Fetch quality profiles for a service
 */
export async function fetchQualityProfiles(
	serviceType: "RADARR" | "SONARR",
): Promise<QualityProfilesResponse> {
	return await apiRequest<QualityProfilesResponse>(
		`/api/trash-guides/quality-profiles/${serviceType}`,
	);
}

/**
 * Fetch detailed quality profile by trash_id
 */
export async function fetchQualityProfileDetails(
	serviceType: "RADARR" | "SONARR",
	trashId: string,
): Promise<{ profile: unknown }> {
	return await apiRequest<{ profile: unknown }>(
		`/api/trash-guides/quality-profiles/${serviceType}/${trashId}`,
	);
}

/**
 * Import quality profile as template
 */
export async function importQualityProfile(
	payload: ImportQualityProfilePayload,
): Promise<ImportQualityProfileResponse> {
	return await apiRequest<ImportQualityProfileResponse>(
		"/api/trash-guides/quality-profiles/import",
		{
			method: "POST",
			json: payload,
		},
	);
}

/**
 * Update quality profile template
 */
export async function updateQualityProfileTemplate(
	payload: UpdateQualityProfileTemplatePayload,
): Promise<ImportQualityProfileResponse> {
	const { templateId, ...restPayload } = payload;
	return await apiRequest<ImportQualityProfileResponse>(
		`/api/trash-guides/quality-profiles/update/${templateId}`,
		{
			method: "PUT",
			json: restPayload,
		},
	);
}

/**
 * TRaSH Guides Update System API Types and Functions
 */

export type TemplateUpdateInfo = {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
	syncStrategy: "auto" | "manual" | "notify";
	canAutoSync: boolean;
	serviceType: "RADARR" | "SONARR";
};

export type CommitInfo = {
	commitHash: string;
	commitDate: string;
	author: string;
	message: string;
};

export type UpdateCheckResponse = {
	success: boolean;
	data: {
		templatesWithUpdates: TemplateUpdateInfo[];
		latestCommit: CommitInfo;
		summary: {
			total: number;
			outdated: number;
			upToDate: number;
		};
	};
};

export type TemplateAttention = {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
};

export type AttentionResponse = {
	success: boolean;
	data: {
		templates: TemplateAttention[];
		count: number;
	};
};

export type SyncTemplatePayload = {
	targetCommitHash?: string;
	strategy?: "replace" | "merge" | "keep_custom";
};

export type SyncTemplateResponse = {
	success: boolean;
	data: {
		templateId: string;
		previousCommit: string | null;
		newCommit: string;
		message: string;
	};
};

export type ProcessAutoUpdatesResponse = {
	success: boolean;
	data: {
		summary: {
			processed: number;
			successful: number;
			failed: number;
		};
		results: Array<{
			templateId: string;
			success: boolean;
			previousCommit?: string | null;
			newCommit?: string;
			errors?: string[];
		}>;
	};
};

export type LatestVersionResponse = {
	success: boolean;
	data: CommitInfo;
};

export type SchedulerStats = {
	isRunning: boolean;
	lastCheckAt?: string;
	nextCheckAt?: string;
	lastCheckResult?: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesNeedingAttention: number;
		cachesRefreshed: number;
		cachesFailed: number;
		errors: string[];
	};
};

export type SchedulerStatusResponse = {
	success: boolean;
	data: SchedulerStats;
};

export type TriggerCheckResponse = {
	success: boolean;
	message: string;
};

/**
 * Check for available template updates
 */
export async function checkForUpdates(): Promise<UpdateCheckResponse> {
	return await apiRequest<UpdateCheckResponse>("/api/trash-guides/updates");
}

/**
 * Get templates requiring user attention
 */
export async function getTemplatesNeedingAttention(): Promise<AttentionResponse> {
	return await apiRequest<AttentionResponse>("/api/trash-guides/updates/attention");
}

/**
 * Sync specific template to latest or target commit
 */
export async function syncTemplate(
	templateId: string,
	payload?: SyncTemplatePayload,
): Promise<SyncTemplateResponse> {
	return await apiRequest<SyncTemplateResponse>(
		`/api/trash-guides/updates/${templateId}/sync`,
		{
			method: "POST",
			json: payload || {},
		},
	);
}

/**
 * Process all auto-sync eligible templates
 */
export async function processAutoUpdates(): Promise<ProcessAutoUpdatesResponse> {
	return await apiRequest<ProcessAutoUpdatesResponse>(
		"/api/trash-guides/updates/process-auto",
		{
			method: "POST",
		},
	);
}

/**
 * Get latest TRaSH Guides version information
 */
export async function getLatestVersion(): Promise<LatestVersionResponse> {
	return await apiRequest<LatestVersionResponse>(
		"/api/trash-guides/updates/version/latest",
	);
}

/**
 * Get scheduler status and statistics
 */
export async function getSchedulerStatus(): Promise<SchedulerStatusResponse> {
	return await apiRequest<SchedulerStatusResponse>(
		"/api/trash-guides/updates/scheduler/status",
	);
}

/**
 * Manually trigger an update check
 */
export async function triggerUpdateCheck(): Promise<TriggerCheckResponse> {
	return await apiRequest<TriggerCheckResponse>(
		"/api/trash-guides/updates/scheduler/trigger",
		{
			method: "POST",
		},
	);
}

/**
 * Template Diff API Types and Functions
 */

export type TemplateDiffSummary = {
	totalChanges: number;
	addedCFs: number;
	removedCFs: number;
	modifiedCFs: number;
	unchangedCFs: number;
};

export type CustomFormatDiffItem = {
	trashId: string;
	name: string;
	changeType: "added" | "removed" | "modified" | "unchanged";
	currentScore?: number;
	newScore?: number;
	currentSpecifications?: unknown[];
	newSpecifications?: unknown[];
	hasSpecificationChanges: boolean;
};

export type CustomFormatGroupDiffItem = {
	trashId: string;
	name: string;
	changeType: "added" | "removed" | "modified" | "unchanged";
	customFormatDiffs: unknown[];
};

export type TemplateDiffResult = {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	summary: TemplateDiffSummary;
	customFormatDiffs: CustomFormatDiffItem[];
	customFormatGroupDiffs: CustomFormatGroupDiffItem[];
	hasUserModifications: boolean;
};

export type TemplateDiffResponse = {
	success: boolean;
	data: TemplateDiffResult;
};

/**
 * Get template diff comparison
 */
export async function getTemplateDiff(
	templateId: string,
	targetCommit?: string,
): Promise<TemplateDiffResponse> {
	const url = targetCommit
		? `/api/trash-guides/updates/${templateId}/diff?targetCommit=${targetCommit}`
		: `/api/trash-guides/updates/${templateId}/diff`;

	return await apiRequest<TemplateDiffResponse>(url);
}

/**
 * Deployment Preview API Types and Functions (Phase 4)
 */

import type {
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
} from "@arr/shared";

export type DeploymentPreviewResponse = {
	success: boolean;
	data: DeploymentPreview;
};

export type DeploymentPreviewRequest = {
	templateId: string;
	instanceId: string;
};

/**
 * Get deployment preview for template → instance
 */
export async function getDeploymentPreview(
	templateId: string,
	instanceId: string,
): Promise<DeploymentPreviewResponse> {
	return await apiRequest<DeploymentPreviewResponse>(
		"/api/trash-guides/deployment/preview",
		{
			method: "POST",
			json: { templateId, instanceId },
		},
	);
}

// Re-export deployment types for convenience
export type {
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
};

/**
 * Instance Override API Types and Functions (Phase 4.2)
 */

export type InstanceOverrides = {
	scoreOverrides?: Record<string, number>;
	cfOverrides?: Record<string, { enabled: boolean }>;
};

export type InstanceOverridesResponse = {
	templateId: string;
	instanceId: string;
	overrides: InstanceOverrides;
};

export type UpdateInstanceOverridesPayload = {
	scoreOverrides?: Record<string, number>;
	cfOverrides?: Record<string, { enabled: boolean }>;
};

export type UpdateInstanceOverridesResponse = {
	success: boolean;
	message: string;
	overrides: InstanceOverrides;
};

/**
 * Get instance-specific overrides for a template
 */
export async function getInstanceOverrides(
	templateId: string,
	instanceId: string,
): Promise<InstanceOverridesResponse> {
	return await apiRequest<InstanceOverridesResponse>(
		`/api/trash-guides/templates/${templateId}/instance-overrides/${instanceId}`,
	);
}

/**
 * Update instance-specific overrides for a template
 */
export async function updateInstanceOverrides(
	templateId: string,
	instanceId: string,
	payload: UpdateInstanceOverridesPayload,
): Promise<UpdateInstanceOverridesResponse> {
	return await apiRequest<UpdateInstanceOverridesResponse>(
		`/api/trash-guides/templates/${templateId}/instance-overrides/${instanceId}`,
		{
			method: "PUT",
			json: payload,
		},
	);
}

/**
 * Remove instance-specific overrides for a template
 */
export async function deleteInstanceOverrides(
	templateId: string,
	instanceId: string,
): Promise<{ success: boolean; message: string }> {
	return await apiRequest<{ success: boolean; message: string }>(
		`/api/trash-guides/templates/${templateId}/instance-overrides/${instanceId}`,
		{
			method: "DELETE",
		},
	);
}

// ============================================================================
// Deployment Execution Types & Functions
// ============================================================================

export type DeploymentResult = {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	customFormatsCreated: number;
	customFormatsUpdated: number;
	customFormatsSkipped: number;
	errors: string[];
	details?: {
		created: string[];
		updated: string[];
		failed: string[];
	};
};

export type BulkDeploymentResult = {
	templateId: string;
	templateName: string;
	totalInstances: number;
	successfulInstances: number;
	failedInstances: number;
	results: DeploymentResult[];
};

export type ExecuteDeploymentPayload = {
	templateId: string;
	instanceId: string;
};

export type ExecuteDeploymentResponse = {
	success: boolean;
	result: DeploymentResult;
};

export type ExecuteBulkDeploymentPayload = {
	templateId: string;
	instanceIds: string[];
};

export type ExecuteBulkDeploymentResponse = {
	success: boolean;
	result: BulkDeploymentResult;
};

export async function executeDeployment(
	payload: ExecuteDeploymentPayload,
): Promise<ExecuteDeploymentResponse> {
	return await apiRequest<ExecuteDeploymentResponse>(
		"/api/trash-guides/deployment/execute",
		{
			method: "POST",
			json: payload,
		},
	);
}

export async function executeBulkDeployment(
	payload: ExecuteBulkDeploymentPayload,
): Promise<ExecuteBulkDeploymentResponse> {
	return await apiRequest<ExecuteBulkDeploymentResponse>(
		"/api/trash-guides/deployment/execute-bulk",
		{
			method: "POST",
			json: payload,
		},
	);
}

// ============================================================================
// Deployment History Types & Functions
// ============================================================================

export type DeploymentHistoryEntry = {
	id: string;
	instanceId: string;
	templateId: string;
	userId: string;
	deployedAt: string;
	deployedBy: string;
	duration: number | null;
	status: string;
	appliedCFs: number;
	failedCFs: number;
	totalCFs: number;
	conflictsCount: number;
	appliedConfigs: string | null;
	failedConfigs: string | null;
	conflictResolutions: string | null;
	errors: string | null;
	warnings: string | null;
	backupId: string | null;
	canRollback: boolean;
	rolledBack: boolean;
	rolledBackAt: string | null;
	rolledBackBy: string | null;
	deploymentNotes: string | null;
	templateSnapshot: string | null;
	instance?: {
		id: string;
		label: string;
		service: string;
	};
	template?: {
		id: string;
		name: string;
		description: string | null;
		serviceType: string;
	};
	backup?: {
		id: string;
		createdAt: string;
	};
};

export type DeploymentHistoryResponse = {
	success: boolean;
	data: {
		history: DeploymentHistoryEntry[];
		pagination: {
			total: number;
			limit: number;
			offset: number;
			hasMore: boolean;
		};
	};
};

export type DeploymentHistoryDetailResponse = {
	success: boolean;
	data: DeploymentHistoryEntry & {
		appliedConfigs: Array<{ name: string; action: string }>;
		failedConfigs: Array<{ name: string; error?: string }>;
	};
};

export type RollbackResponse = {
	success: boolean;
	message: string;
	data: DeploymentHistoryEntry;
};

/**
 * Get all deployment history (global view)
 */
export async function getAllDeploymentHistory(
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", options.limit.toString());
	if (options?.offset) params.set("offset", options.offset.toString());

	const url = `/api/trash-guides/deployment/history${params.toString() ? `?${params.toString()}` : ""}`;
	return await apiRequest<DeploymentHistoryResponse>(url);
}

/**
 * Get deployment history for a template
 */
export async function getTemplateDeploymentHistory(
	templateId: string,
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", options.limit.toString());
	if (options?.offset) params.set("offset", options.offset.toString());

	const url = `/api/trash-guides/deployment/history/template/${templateId}${params.toString() ? `?${params.toString()}` : ""}`;
	return await apiRequest<DeploymentHistoryResponse>(url);
}

/**
 * Get deployment history for an instance
 */
export async function getInstanceDeploymentHistory(
	instanceId: string,
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", options.limit.toString());
	if (options?.offset) params.set("offset", options.offset.toString());

	const url = `/api/trash-guides/deployment/history/instance/${instanceId}${params.toString() ? `?${params.toString()}` : ""}`;
	return await apiRequest<DeploymentHistoryResponse>(url);
}

/**
 * Get detailed deployment history entry
 */
export async function getDeploymentHistoryDetail(
	historyId: string,
): Promise<DeploymentHistoryDetailResponse> {
	return await apiRequest<DeploymentHistoryDetailResponse>(
		`/api/trash-guides/deployment/history/${historyId}`,
	);
}

/**
 * Rollback a deployment
 */
export async function rollbackDeployment(
	historyId: string,
): Promise<RollbackResponse> {
	return await apiRequest<RollbackResponse>(
		`/api/trash-guides/deployment/history/${historyId}/rollback`,
		{
			method: "POST",
		},
	);
}
