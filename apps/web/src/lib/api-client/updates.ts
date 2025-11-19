import { apiRequest } from "./base";

// ============================================================================
// Response Types
// ============================================================================

export interface CommitInfo {
	commitHash: string;
	commitDate: string;
	message?: string;
}

export interface TemplateUpdateInfo {
	templateId: string;
	templateName: string;
	currentCommit: string;
	latestCommit: string;
	behindBy: number;
	hasUserModifications: boolean;
	canAutoSync: boolean;
	lastSyncedAt?: string;
}

export interface TemplateUpdatesResponse {
	templatesWithUpdates: TemplateUpdateInfo[];
	latestCommit: CommitInfo;
	summary: {
		total: number;
		outdated: number;
		upToDate: number;
	};
}

export interface TemplateNeedingAttention {
	templateId: string;
	templateName: string;
	reason: "has_modifications" | "sync_failed" | "conflict_detected";
	currentCommit: string;
	latestCommit: string;
	lastAttemptedSyncAt?: string;
	errorMessage?: string;
}

export interface AttentionResponse {
	templates: TemplateNeedingAttention[];
	count: number;
}

export interface SyncTemplateResponse {
	success: boolean;
	template: {
		id: string;
		name: string;
		previousCommit: string;
		newCommit: string;
		changesApplied: string[];
	};
	message?: string;
}

export interface AutoSyncResponse {
	processed: number;
	synced: number;
	failed: number;
	results: {
		templateId: string;
		templateName: string;
		success: boolean;
		errorMessage?: string;
	}[];
}

export interface TemplateDiff {
	templateId: string;
	templateName: string;
	currentCommit: string;
	targetCommit: string;
	changes: {
		type: "added" | "removed" | "modified";
		category: "custom_format" | "cf_group" | "score" | "specification";
		item: string;
		before?: any;
		after?: any;
		description: string;
	}[];
	summary: {
		additions: number;
		removals: number;
		modifications: number;
	};
}

export interface TemplateDiffResponse {
	diff: TemplateDiff;
}

export interface LatestVersionResponse {
	commit: CommitInfo;
	lastCheckedAt: string;
}

export interface SchedulerStatusResponse {
	isRunning: boolean;
	nextCheckAt: string;
	lastCheckAt?: string;
	lastCheckResult?: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesNeedingAttention: number;
	};
}

export interface TriggerCheckResponse {
	triggered: boolean;
	message: string;
}

// ============================================================================
// API Client Functions
// ============================================================================

/**
 * Check for available template updates
 */
export async function checkTemplateUpdates(): Promise<TemplateUpdatesResponse> {
	return await apiRequest<TemplateUpdatesResponse>("/api/trash-guides/updates");
}

/**
 * Get templates needing manual attention
 */
export async function getTemplatesNeedingAttention(): Promise<AttentionResponse> {
	return await apiRequest<AttentionResponse>("/api/trash-guides/updates/attention");
}

/**
 * Sync template to latest or target commit
 */
export async function syncTemplate(
	templateId: string,
	targetCommit?: string,
): Promise<SyncTemplateResponse> {
	return await apiRequest<SyncTemplateResponse>(`/api/trash-guides/updates/${templateId}/sync`, {
		method: "POST",
		json: { targetCommit },
	});
}

/**
 * Process auto-sync for eligible templates
 */
export async function processAutoSync(): Promise<AutoSyncResponse> {
	return await apiRequest<AutoSyncResponse>("/api/trash-guides/updates/process-auto", {
		method: "POST",
	});
}

/**
 * Get diff between template's current version and target commit
 */
export async function getTemplateDiff(
	templateId: string,
	targetCommit?: string,
): Promise<TemplateDiffResponse> {
	const params = new URLSearchParams();
	if (targetCommit) {
		params.append("targetCommit", targetCommit);
	}

	const url = `/api/trash-guides/updates/${templateId}/diff${params.toString() ? `?${params.toString()}` : ""}`;
	return await apiRequest<TemplateDiffResponse>(url);
}

/**
 * Get latest TRaSH Guides version
 */
export async function getLatestVersion(): Promise<LatestVersionResponse> {
	return await apiRequest<LatestVersionResponse>("/api/trash-guides/updates/version/latest");
}

/**
 * Get scheduler status
 */
export async function getSchedulerStatus(): Promise<SchedulerStatusResponse> {
	return await apiRequest<SchedulerStatusResponse>("/api/trash-guides/updates/scheduler/status");
}

/**
 * Trigger manual update check
 */
export async function triggerUpdateCheck(): Promise<TriggerCheckResponse> {
	return await apiRequest<TriggerCheckResponse>("/api/trash-guides/updates/scheduler/trigger", {
		method: "POST",
	});
}
