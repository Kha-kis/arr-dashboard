/**
 * Deployment API Operations
 *
 * API functions for TRaSH Guides template deployment including
 * previews, execution, history, and rollback operations.
 */

import { apiRequest } from "../base";
import { buildQueryUrl } from "../../build-query-url";
import type {
	CustomQualityConfig,
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
	SyncStrategy,
	TemplateImportOptions,
	TrashTemplate,
} from "./types";

// Re-export deployment types from shared for convenience
export type {
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
};

// ============================================================================
// Deployment Preview Types
// ============================================================================

export type DeploymentPreviewResponse = {
	success: boolean;
	data: DeploymentPreview;
};

export type DeploymentPreviewRequest = {
	templateId: string;
	instanceId: string;
};

// ============================================================================
// Instance Override Types
// ============================================================================

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
	qualityConfigOverride?: CustomQualityConfig | null; // null to clear the override
};

export type TemplateInstanceOverride = {
	instanceId: string;
	cfScoreOverrides?: Record<string, number>;
	cfSelectionOverrides?: Record<string, { enabled: boolean }>;
	qualityConfigOverride?: CustomQualityConfig;
	lastModifiedAt: string;
	lastModifiedBy: string;
};

export type UpdateInstanceOverridesResponse = {
	success: boolean;
	message: string;
	overrides: InstanceOverrides | TemplateInstanceOverride;
};

export type GetInstanceOverridesResponse = {
	templateId: string;
	instanceId: string;
	overrides: TemplateInstanceOverride;
};

// ============================================================================
// Deployment Execution Types
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
	syncStrategy?: SyncStrategy;
	/** Conflict resolutions: trashId -> resolution (use_template, keep_existing) */
	conflictResolutions?: Record<string, ConflictResolution>;
};

export type ExecuteDeploymentResponse = {
	success: boolean;
	result: DeploymentResult;
};

export type ExecuteBulkDeploymentPayload = {
	templateId: string;
	instanceIds: string[];
	syncStrategy?: SyncStrategy;
	/** Per-instance sync strategies - overrides global syncStrategy for specific instances */
	instanceSyncStrategies?: Record<string, SyncStrategy>;
};

export type ExecuteBulkDeploymentResponse = {
	success: boolean;
	result: BulkDeploymentResult;
};

// ============================================================================
// Sync Strategy Types
// ============================================================================

export type UpdateSyncStrategyPayload = {
	templateId: string;
	instanceId: string;
	syncStrategy: SyncStrategy;
};

export type UpdateSyncStrategyResponse = {
	success: boolean;
	message: string;
	data: {
		templateId: string;
		instanceId: string;
		syncStrategy: SyncStrategy;
	};
};

export type BulkUpdateSyncStrategyPayload = {
	templateId: string;
	syncStrategy: SyncStrategy;
};

export type BulkUpdateSyncStrategyResponse = {
	success: boolean;
	message: string;
	data: {
		templateId: string;
		syncStrategy: SyncStrategy;
		updatedCount: number;
	};
};

// ============================================================================
// Unlink Types
// ============================================================================

export type UnlinkTemplatePayload = {
	templateId: string;
	instanceId: string;
};

export type UnlinkTemplateResponse = {
	success: boolean;
	message: string;
	data: {
		templateId: string;
		instanceId: string;
		templateName: string;
		instanceName: string;
	};
};

// ============================================================================
// Deployment History Types
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

export type UndeployResponse = {
	success: boolean;
	message: string;
	data: {
		deleted: number;
		skippedShared: string[];
		skippedSharedCount: number;
		notFound: string[];
		notFoundCount: number;
		errors: string[];
		totalInTemplate: number;
	};
};

// ============================================================================
// Enhanced Template Import Types
// ============================================================================

export type EnhancedImportTemplatePayload = {
	jsonData: string;
	options: TemplateImportOptions;
};

export type EnhancedImportTemplateResponse = {
	success: boolean;
	template: TrashTemplate;
	message: string;
};

// ============================================================================
// API Functions - Preview & Overrides
// ============================================================================

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

/**
 * Get instance-specific overrides for a template
 */
export async function getInstanceOverrides(
	templateId: string,
	instanceId: string,
): Promise<GetInstanceOverridesResponse> {
	return await apiRequest<GetInstanceOverridesResponse>(
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
// API Functions - Deployment Execution
// ============================================================================

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
// API Functions - Sync Strategy
// ============================================================================

/**
 * Update sync strategy for an existing deployment
 */
export async function updateSyncStrategy(
	payload: UpdateSyncStrategyPayload,
): Promise<UpdateSyncStrategyResponse> {
	return await apiRequest<UpdateSyncStrategyResponse>(
		"/api/trash-guides/deployment/sync-strategy",
		{
			method: "PATCH",
			json: payload,
		},
	);
}

/**
 * Update sync strategy for all instances of a template at once
 */
export async function bulkUpdateSyncStrategy(
	payload: BulkUpdateSyncStrategyPayload,
): Promise<BulkUpdateSyncStrategyResponse> {
	return await apiRequest<BulkUpdateSyncStrategyResponse>(
		"/api/trash-guides/deployment/sync-strategy-bulk",
		{
			method: "PATCH",
			json: payload,
		},
	);
}

// ============================================================================
// API Functions - Unlink
// ============================================================================

/**
 * Remove a template from a single instance (unlink without deleting the template)
 * This removes the deployment mapping but keeps Custom Formats on the instance
 */
export async function unlinkTemplateFromInstance(
	payload: UnlinkTemplatePayload,
): Promise<UnlinkTemplateResponse> {
	return await apiRequest<UnlinkTemplateResponse>(
		"/api/trash-guides/deployment/unlink",
		{
			method: "DELETE",
			json: payload,
		},
	);
}

// ============================================================================
// API Functions - Deployment History
// ============================================================================

/**
 * Get all deployment history (global view)
 */
export async function getAllDeploymentHistory(
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const url = buildQueryUrl("/api/trash-guides/deployment/history", {
		limit: options?.limit,
		offset: options?.offset,
	});
	return await apiRequest<DeploymentHistoryResponse>(url);
}

/**
 * Get deployment history for a template
 */
export async function getTemplateDeploymentHistory(
	templateId: string,
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const url = buildQueryUrl(`/api/trash-guides/deployment/history/template/${templateId}`, {
		limit: options?.limit,
		offset: options?.offset,
	});
	return await apiRequest<DeploymentHistoryResponse>(url);
}

/**
 * Get deployment history for an instance
 */
export async function getInstanceDeploymentHistory(
	instanceId: string,
	options?: { limit?: number; offset?: number },
): Promise<DeploymentHistoryResponse> {
	const url = buildQueryUrl(`/api/trash-guides/deployment/history/instance/${instanceId}`, {
		limit: options?.limit,
		offset: options?.offset,
	});
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
 * Undeploy - remove Custom Formats deployed by a specific deployment
 * Only removes CFs unique to this template (not shared with other templates)
 */
export async function undeployDeployment(
	historyId: string,
): Promise<UndeployResponse> {
	return await apiRequest<UndeployResponse>(
		`/api/trash-guides/deployment/history/${historyId}/undeploy`,
		{
			method: "POST",
		},
	);
}

/**
 * Delete a deployment history entry
 */
export async function deleteDeploymentHistory(
	historyId: string,
): Promise<{ success: boolean; message: string }> {
	return await apiRequest<{ success: boolean; message: string }>(
		`/api/trash-guides/deployment/history/${historyId}`,
		{
			method: "DELETE",
		},
	);
}

// ============================================================================
// API Functions - Enhanced Import
// ============================================================================

/**
 * Import template with validation and conflict resolution options
 */
export async function importEnhancedTemplate(
	payload: EnhancedImportTemplatePayload,
): Promise<EnhancedImportTemplateResponse> {
	return await apiRequest<EnhancedImportTemplateResponse>(
		"/api/trash-guides/sharing/import",
		{
			method: "POST",
			json: payload,
		},
	);
}
