/**
 * Updates API Operations
 *
 * API functions for TRaSH Guides template update system including
 * update checking, template syncing, and scheduler management.
 */

import { apiRequest } from "../base";
import type { ServiceType, CommitInfo } from "./types";

// ============================================================================
// Template Update Types
// ============================================================================

export type TemplateUpdateInfo = {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
	autoSyncInstanceCount: number;
	canAutoSync: boolean;
	serviceType: ServiceType;
	/** True if this template was recently auto-synced (is current, not pending) */
	isRecentlyAutoSynced?: boolean;
	/** Timestamp of the last auto-sync, if isRecentlyAutoSynced is true */
	lastAutoSyncTimestamp?: string;
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

// ============================================================================
// Sync Types
// ============================================================================

export type SyncTemplatePayload = {
	targetCommitHash?: string;
	strategy?: "replace" | "merge" | "keep_custom";
	/** Explicitly control whether to apply score updates. If not set, derived from strategy. */
	applyScoreUpdates?: boolean;
};

export type SyncMergeStats = {
	customFormatsAdded: number;
	customFormatsRemoved: number;
	customFormatsUpdated: number;
	customFormatsPreserved: number;
	scoresUpdated: number;
	scoresSkippedDueToOverride: number;
};

export type SyncScoreConflict = {
	trashId: string;
	name: string;
	currentScore: number;
	recommendedScore: number;
	userHasOverride: boolean;
};

export type SyncTemplateResponse = {
	success: boolean;
	data: {
		templateId: string;
		previousCommit: string | null;
		newCommit: string;
		message: string;
		mergeStats?: SyncMergeStats;
		scoreConflicts?: SyncScoreConflict[];
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

// ============================================================================
// Scheduler Types
// ============================================================================

export type SchedulerStats = {
	isRunning: boolean;
	autoSyncEnabled: boolean;
	lastCheckAt?: string;
	nextCheckAt?: string;
	lastCheckResult?: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesNeedingAttention: number;
		templatesNeedingApproval: number; // Templates with CF Group additions needing user approval
		templatesWithScoreConflicts: number; // Templates where score updates were skipped due to user overrides
		templatesWithAutoStrategy: number;
		templatesWithNotifyStrategy: number;
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
	completedAt: string;
	result: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesNeedingAttention: number;
		templatesNeedingApproval: number; // Templates with CF Group additions needing user approval
		templatesWithScoreConflicts: number; // Templates where score updates were skipped due to user overrides
		templatesWithAutoStrategy: number;
		templatesWithNotifyStrategy: number;
		cachesRefreshed: number;
		cachesFailed: number;
		errors: string[];
	} | null;
};

// ============================================================================
// Template Diff Types
// ============================================================================

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

export type SuggestedCFAddition = {
	trashId: string;
	name: string;
	recommendedScore: number;
	source: "cf_group" | "quality_profile";
	sourceGroupName?: string;
	sourceProfileName?: string;
	specifications: unknown[];
};

export type SuggestedScoreChange = {
	trashId: string;
	name: string;
	currentScore: number;
	recommendedScore: number;
	scoreSet: string;
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
	suggestedAdditions?: SuggestedCFAddition[];
	suggestedScoreChanges?: SuggestedScoreChange[];
	/**
	 * True when the template is already at the target version and
	 * the diff was reconstructed from historical changelog data.
	 * Frontend can use this to show "Recently Applied Changes" instead of "Pending Changes".
	 */
	isHistorical?: boolean;
	/** Timestamp of the historical sync, if isHistorical is true */
	historicalSyncTimestamp?: string;
};

export type TemplateDiffResponse = {
	success: boolean;
	data: TemplateDiffResult;
};

// ============================================================================
// API Functions
// ============================================================================

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

// Re-export CommitInfo for convenience
export type { CommitInfo };
