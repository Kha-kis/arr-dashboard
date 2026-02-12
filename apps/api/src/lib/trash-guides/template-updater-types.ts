/**
 * Type definitions for the TRaSH Guides Template Updater module.
 *
 * All interfaces are re-exported from `template-updater.ts` (the facade) so
 * existing callers never need to change their import paths.
 */

/**
 * Pending CF Group addition that requires user approval
 */
export interface PendingCFGroupAddition {
	trashId: string;
	name: string;
	groupName: string;
	groupTrashId: string;
	recommendedScore: number;
}

export interface TemplateUpdateInfo {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	hasUserModifications: boolean;
	/** Number of instances with auto-sync enabled for this template */
	autoSyncInstanceCount: number;
	canAutoSync: boolean;
	serviceType: "RADARR" | "SONARR";
	/** CF Group additions that need user approval (for auto-sync strategy) */
	needsApproval?: boolean;
	pendingCFGroupAdditions?: PendingCFGroupAddition[];
	/** True if this template was recently auto-synced (is current, not pending) */
	isRecentlyAutoSynced?: boolean;
	/** Timestamp of the last auto-sync, if isRecentlyAutoSynced is true */
	lastAutoSyncTimestamp?: string;
}

export interface UpdateCheckResult {
	templatesWithUpdates: TemplateUpdateInfo[];
	latestCommit: import("./version-tracker.js").VersionInfo;
	totalTemplates: number;
	outdatedTemplates: number;
}

/**
 * Score conflict when auto-sync can't update a score due to user override
 */
export interface ScoreConflict {
	trashId: string;
	name: string;
	currentScore: number;
	recommendedScore: number;
	userHasOverride: boolean;
}

export interface SyncResult {
	success: boolean;
	templateId: string;
	previousCommit: string | null;
	newCommit: string;
	errors?: string[];
	errorType?: "not_found" | "not_authorized" | "sync_failed";
	mergeStats?: MergeStats;
	/** Score conflicts that couldn't be auto-applied due to user overrides */
	scoreConflicts?: ScoreConflict[];
}

export interface MergeStats {
	customFormatsAdded: number;
	customFormatsRemoved: number;
	customFormatsUpdated: number;
	customFormatsPreserved: number;
	customFormatsDeprecated: number;
	customFormatGroupsAdded: number;
	customFormatGroupsRemoved: number;
	customFormatGroupsUpdated: number;
	customFormatGroupsPreserved: number;
	customFormatGroupsDeprecated: number;
	userCustomizationsPreserved: string[];
	scoresUpdated: number;
	scoresSkippedDueToOverride: number;
	addedCFDetails: Array<{ trashId: string; name: string; score: number }>;
	removedCFDetails: Array<{ trashId: string; name: string }>;
	updatedCFDetails: Array<{ trashId: string; name: string }>;
	deprecatedCFDetails: Array<{ trashId: string; name: string; reason: string }>;
	scoreChangeDetails: Array<{ trashId: string; name: string; oldScore: number; newScore: number }>;
}

export interface MergeResult {
	success: boolean;
	mergedConfig: import("@arr/shared").TemplateConfig;
	stats: MergeStats;
	warnings: string[];
	/** Score conflicts when user has override but recommended score differs */
	scoreConflicts: ScoreConflict[];
}
