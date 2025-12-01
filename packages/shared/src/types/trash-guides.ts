/**
 * TRaSH Guides Integration Types
 *
 * Types for TRaSH Guides configuration management including:
 * - Cache management
 * - Templates
 * - Sync operations
 * - Backups and rollback
 */

// ============================================================================
// Enums and Constants
// ============================================================================

export const TRASH_CONFIG_TYPES = {
	CUSTOM_FORMATS: "CUSTOM_FORMATS",
	CF_GROUPS: "CF_GROUPS",
	QUALITY_SIZE: "QUALITY_SIZE",
	NAMING: "NAMING",
	QUALITY_PROFILES: "QUALITY_PROFILES",
	CF_DESCRIPTIONS: "CF_DESCRIPTIONS",
} as const;

export type TrashConfigType = (typeof TRASH_CONFIG_TYPES)[keyof typeof TRASH_CONFIG_TYPES];

export const TRASH_SYNC_TYPES = {
	MANUAL: "MANUAL",
	SCHEDULED: "SCHEDULED",
} as const;

export type TrashSyncType = (typeof TRASH_SYNC_TYPES)[keyof typeof TRASH_SYNC_TYPES];

export const TRASH_SYNC_STATUS = {
	SUCCESS: "SUCCESS",
	PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
	FAILED: "FAILED",
	IN_PROGRESS: "IN_PROGRESS",
	CANCELLED: "CANCELLED",
} as const;

export type TrashSyncStatus = (typeof TRASH_SYNC_STATUS)[keyof typeof TRASH_SYNC_STATUS];

export const TRASH_SCHEDULE_FREQUENCY = {
	DAILY: "DAILY",
	WEEKLY: "WEEKLY",
	MONTHLY: "MONTHLY",
} as const;

export type TrashScheduleFrequency =
	(typeof TRASH_SCHEDULE_FREQUENCY)[keyof typeof TRASH_SCHEDULE_FREQUENCY];

// ============================================================================
// TRaSH API Response Types (from GitHub)
// ============================================================================

/**
 * Custom Format from TRaSH Guides
 */
export interface TrashCustomFormat {
	trash_id: string;
	name: string;
	score?: number; // Default score from TRaSH Guides
	includeCustomFormatWhenRenaming?: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate: boolean;
		required: boolean;
		fields: Record<string, unknown>;
	}>;
}

/**
 * Custom Format within a CF Group
 */
export interface GroupCustomFormat {
	name: string;
	trash_id: string;
	required: boolean; // If true, user cannot individually toggle this CF (bundled with group)
	default?: string | boolean; // If "true" or true, this CF is pre-checked when required=false
}

/**
 * Custom Format Group from TRaSH Guides
 */
export interface TrashCustomFormatGroup {
	trash_id: string;
	name: string;
	trash_description?: string; // TRaSH's guidance text (HTML format)
	default?: string | boolean; // If "true" or true, this CF Group is enabled by default for applicable profiles
	required?: boolean; // If true, this CF Group cannot be disabled (always required)
	custom_formats: Array<GroupCustomFormat | string>; // Can be objects or trash_id strings
	quality_profiles?: {
		exclude?: Record<string, string>; // profile name → trash_id
		score?: number; // Recommended score
	};
}

/**
 * Quality Size Settings from TRaSH Guides
 */
export interface TrashQualitySize {
	type: string;
	preferred?: boolean;
	min?: number;
	max?: number;
}

/**
 * Naming Scheme from TRaSH Guides
 */
export interface TrashNamingScheme {
	type: "movie" | "series";
	standard?: string;
	folder?: string;
	season_folder?: string;
}

/**
 * Quality Profile from TRaSH Guides
 */
export interface TrashQualityProfile {
	trash_id: string;
	name: string;
	trash_score_set?: string;
	trash_description?: string;
	group?: number;
	upgradeAllowed: boolean;
	cutoff: string;
	minFormatScore?: number;
	cutoffFormatScore?: number;
	minUpgradeFormatScore?: number;
	language?: string;
	items: Array<{
		name: string;
		allowed: boolean;
		items?: string[];
	}>;
	formatItems?: Record<string, string>; // Custom Format name -> trash_id mapping
}

/**
 * Custom Format Description from TRaSH Guides
 * Parsed from markdown files in includes/cf-descriptions/
 */
export interface TrashCFDescription {
	cfName: string; // File name (e.g., "hdr", "dv-hdr10plus")
	displayName: string; // Human-readable name (extracted from markdown title)
	description: string; // HTML content (markdown converted to HTML)
	rawMarkdown: string; // Original markdown for reference
	fetchedAt: string; // Timestamp when description was fetched
}

// ============================================================================
// Cache Types
// ============================================================================

/**
 * Cache entry for TRaSH Guides data
 */
export interface TrashCacheEntry {
	id: string;
	serviceType: "RADARR" | "SONARR";
	configType: TrashConfigType;
	data: TrashCustomFormat[] | TrashCustomFormatGroup[] | TrashQualitySize[] | TrashNamingScheme[] | TrashQualityProfile[] | TrashCFDescription[];
	version: number;
	fetchedAt: string;
	lastCheckedAt: string;
	updatedAt: string;
}

/**
 * Cache status response
 */
export interface TrashCacheStatus {
	serviceType: "RADARR" | "SONARR";
	configType: TrashConfigType;
	version: number;
	lastFetched: string;
	lastChecked: string;
	itemCount: number;
	isStale: boolean;
}

// ============================================================================
// Template Types
// ============================================================================

/**
 * Custom Format with user customizations
 */
export interface TemplateCustomFormat {
	trashId: string;
	name: string;
	score?: number; // Current score (either from scoreOverride or originalConfig.score)
	scoreOverride?: number; // User-defined score
	conditionsEnabled: Record<string, boolean>; // Which conditions are enabled
	originalConfig: TrashCustomFormat; // Original TRaSH config
}

/**
 * Custom Format Group in template
 */
export interface TemplateCustomFormatGroup {
	trashId: string;
	name: string;
	enabled: boolean;
	originalConfig: TrashCustomFormatGroup;
}

/**
 * Template configuration data
 */
export interface TemplateConfig {
	customFormats: TemplateCustomFormat[];
	customFormatGroups: TemplateCustomFormatGroup[];
	qualityProfile?: {
		upgradeAllowed?: boolean;
		cutoff?: string; // Quality name like "Remux 1080p"
		items?: Array<{
			name: string;
			allowed: boolean;
			items?: string[]; // Nested quality names
		}>;
		minFormatScore?: number;
		cutoffFormatScore?: number;
		minUpgradeFormatScore?: number;
		trash_score_set?: string; // Score set to use for CF scores (e.g., "default", "sqp-1-1080p")
		language?: string; // Language name from TRaSH Guides (e.g., "Original")
	};
	qualitySize?: TrashQualitySize[];
	naming?: TrashNamingScheme[];
	// Phase 5.3: Complete quality profile settings (imported from *arr instance)
	completeQualityProfile?: CompleteQualityProfile;
}

/**
 * Phase 5.3: Complete quality profile data from *arr instance
 * This allows templates to be full quality profile clones
 */
export interface CompleteQualityProfile {
	// Source information
	sourceInstanceId: string; // Instance this was imported from
	sourceProfileId: number; // *arr quality profile ID
	sourceProfileName: string; // Original profile name
	importedAt: string; // When it was imported

	// Quality definitions
	upgradeAllowed: boolean;
	cutoff: number; // Quality ID
	cutoffQuality?: {
		id: number;
		name: string;
		source: string;
		resolution: number;
	};

	// Quality items with ordering
	items: Array<{
		quality?: {
			id: number;
			name: string;
			source: string;
			resolution: number;
		};
		items?: Array<{
			id: number;
			name: string;
			source: string;
			resolution: number;
			allowed: boolean;
		}>;
		allowed: boolean;
		id?: number;
		name?: string;
	}>;

	// Format scores (minimum thresholds)
	minFormatScore: number;
	cutoffFormatScore: number;
	minUpgradeFormatScore?: number;

	// Language settings (if applicable)
	language?: {
		id: number;
		name: string;
	};
	languages?: Array<{
		id: number;
		name: string;
		allowed: boolean;
	}>;
}

/**
 * Phase 3: Change log entry for template modifications
 */
export interface TemplateChangeLogEntry {
	timestamp: string;
	userId: string;
	action: "created" | "updated" | "synced" | "deployed";
	changes: {
		field: string;
		oldValue?: unknown;
		newValue?: unknown;
	}[];
	note?: string;
}

/**
 * Phase 3: Instance-specific overrides for a template
 */
export interface TemplateInstanceOverride {
	instanceId: string;
	cfScoreOverrides?: Record<string, number>; // CF trash_id → score
	cfSelectionOverrides?: Record<string, boolean>; // CF trash_id → enabled
	conditionOverrides?: Record<string, Record<string, boolean>>; // CF trash_id → condition name → enabled
	lastModifiedAt: string;
	lastModifiedBy: string;
}

/**
 * TRaSH Template
 */
export interface TrashTemplate {
	id: string;
	userId: string;
	name: string;
	description?: string;
	serviceType: "RADARR" | "SONARR";
	config: TemplateConfig;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string;

	// Source Quality Profile Information
	sourceQualityProfileTrashId?: string; // TRaSH quality profile trash_id this template was created from
	sourceQualityProfileName?: string; // TRaSH quality profile name (e.g., "HD Bluray + WEB")

	// Phase 3: Versioning & Metadata
	trashGuidesCommitHash?: string; // TRaSH Guides commit hash at time of import
	trashGuidesVersion?: string; // Semantic version if available
	importedAt: string;
	lastSyncedAt?: string; // Last time template was synced with TRaSH Guides

	// Phase 3: Customization Tracking
	hasUserModifications: boolean; // True if user has modified scores/selections
	modifiedFields?: string[]; // Array: ["scores", "cf_selections", "conditions"]
	lastModifiedAt?: string;
	lastModifiedBy?: string; // userId who made last modification

	// Phase 3: Change History (optional, for audit trail)
	changeLog?: TemplateChangeLogEntry[];

	// Phase 3: Instance-specific Overrides
	instanceOverrides?: Record<string, TemplateInstanceOverride>;
}

/**
 * Create template request
 */
export interface CreateTemplateRequest {
	name: string;
	description?: string;
	serviceType: "RADARR" | "SONARR";
	config: TemplateConfig;
	sourceQualityProfileTrashId?: string; // TRaSH quality profile trash_id this template was created from
	sourceQualityProfileName?: string; // TRaSH quality profile name (e.g., "HD Bluray + WEB")
	trashGuidesCommitHash?: string; // TRaSH Guides commit hash at time of import for version tracking
}

/**
 * Update template request
 */
export interface UpdateTemplateRequest {
	name?: string;
	description?: string;
	config?: TemplateConfig;
}

// ============================================================================
// Sync Operation Types
// ============================================================================

/**
 * Conflict detected during sync
 */
export interface SyncConflict {
	configType: TrashConfigType;
	trashId: string;
	name: string;
	existingConfig: Record<string, unknown>;
	trashConfig: Record<string, unknown>;
	recommendation: "USE_TRASH" | "KEEP_EXISTING" | "MANUAL_REVIEW";
	reason: string;
	impact: "LOW" | "MEDIUM" | "HIGH";
}

/**
 * Sync validation result
 */
export interface SyncValidationResult {
	valid: boolean;
	conflicts: SyncConflict[];
	errors: Array<{
		code: string;
		message: string;
		field?: string;
	}>;
	warnings: Array<{
		message: string;
	}>;
}

/**
 * Sync conflict resolution
 */
export interface SyncConflictResolution {
	trashId: string;
	action: "USE_TRASH" | "KEEP_EXISTING" | "SKIP";
}

/**
 * Sync execution request
 */
export interface ExecuteSyncRequest {
	instanceId: string;
	templateId?: string;
	configsToApply?: {
		customFormats?: string[]; // Array of trash_ids
		customFormatGroups?: string[];
	};
	conflictResolutions: SyncConflictResolution[];
	createBackup: boolean;
}

/**
 * Sync progress update
 */
export interface SyncProgress {
	syncId: string;
	status: TrashSyncStatus;
	currentStep: string;
	progress: number; // 0-100
	totalConfigs: number;
	appliedConfigs: number;
	failedConfigs: number;
	skippedConfigs: number;
}

/**
 * Failed config detail
 */
export interface FailedConfigDetail {
	trashId: string;
	name: string;
	error: string;
	retryable: boolean;
}

/**
 * Sync history record
 */
export interface TrashSyncHistory {
	id: string;
	instanceId: string;
	instanceName: string;
	templateId?: string;
	templateName?: string;
	userId: string;
	syncType: TrashSyncType;
	status: TrashSyncStatus;
	startedAt: string;
	completedAt?: string;
	duration?: number;
	configsApplied: number;
	configsFailed: number;
	configsSkipped: number;
	appliedConfigs: string[]; // Array of trash_ids
	failedConfigs: FailedConfigDetail[];
	backupId?: string;
	rolledBack: boolean;
	rolledBackAt?: string;
}

// ============================================================================
// Backup Types
// ============================================================================

/**
 * Backup snapshot
 */
export interface TrashBackup {
	id: string;
	instanceId: string;
	instanceName: string;
	userId: string;
	backupData: {
		customFormats: Record<string, unknown>[];
		customFormatGroups?: Record<string, unknown>[];
		qualityProfiles?: Record<string, unknown>[];
		timestamp: string;
	};
	createdAt: string;
	expiresAt?: string;
}

/**
 * Rollback request
 */
export interface RollbackRequest {
	syncId: string;
	backupId: string;
}

// ============================================================================
// Schedule Types
// ============================================================================

/**
 * Sync schedule
 */
export interface TrashSyncSchedule {
	id: string;
	instanceId?: string;
	instanceName?: string;
	templateId?: string;
	templateName?: string;
	userId: string;
	enabled: boolean;
	frequency: TrashScheduleFrequency;
	lastRunAt?: string;
	nextRunAt?: string;
	autoApply: boolean;
	notifyUser: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Create schedule request
 */
export interface CreateScheduleRequest {
	instanceId?: string;
	templateId?: string;
	frequency: TrashScheduleFrequency;
	autoApply: boolean;
	notifyUser: boolean;
}

/**
 * Update schedule request
 */
export interface UpdateScheduleRequest {
	enabled?: boolean;
	frequency?: TrashScheduleFrequency;
	autoApply?: boolean;
	notifyUser?: boolean;
}

// ============================================================================
// Settings Types
// ============================================================================

/**
 * User TRaSH Guides settings
 */
export interface TrashSettings {
	id: string;
	userId: string;
	checkFrequency: number; // hours
	autoRefreshCache: boolean;
	notifyOnUpdates: boolean;
	notifyOnSyncFail: boolean;
	backupRetention: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * Update settings request
 */
export interface UpdateTrashSettingsRequest {
	checkFrequency?: number;
	autoRefreshCache?: boolean;
	notifyOnUpdates?: boolean;
	notifyOnSyncFail?: boolean;
	backupRetention?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Paginated list response
 */
export interface PaginatedResponse<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
}

/**
 * Generic API error response
 */
export interface TrashApiError {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

// ============================================================================
// Update Scheduler Types
// ============================================================================

/**
 * Scheduler statistics and status
 */
export interface SchedulerStats {
	isRunning: boolean;
	lastCheckAt?: string;
	nextCheckAt?: string;
	lastCheckResult?: {
		templatesChecked: number;
		templatesOutdated: number;
		templatesAutoSynced: number;
		templatesNeedingAttention: number;
		templatesWithAutoStrategy: number;
		templatesWithNotifyStrategy: number;
		cachesRefreshed: number;
		cachesFailed: number;
		errors: string[];
	};
}

// ============================================================================
// Template Diff Types
// ============================================================================

export type DiffChangeType = "added" | "removed" | "modified" | "unchanged";

/**
 * Custom Format diff detail
 */
export interface CustomFormatDiff {
	trashId: string;
	name: string;
	changeType: DiffChangeType;
	currentScore?: number;
	newScore?: number;
	currentSpecifications?: any[];
	newSpecifications?: any[];
	hasSpecificationChanges: boolean;
}

/**
 * Custom Format Group diff detail
 */
export interface CustomFormatGroupDiff {
	trashId: string;
	name: string;
	changeType: DiffChangeType;
	customFormatDiffs: CustomFormatDiff[];
}

/**
 * Template diff comparison result
 */
export interface TemplateDiffResult {
	templateId: string;
	templateName: string;
	currentCommit: string | null;
	latestCommit: string;
	summary: {
		totalChanges: number;
		addedCFs: number;
		removedCFs: number;
		modifiedCFs: number;
		unchangedCFs: number;
	};
	customFormatDiffs: CustomFormatDiff[];
	customFormatGroupDiffs: CustomFormatGroupDiff[];
	hasUserModifications: boolean;
}

/**
 * Template diff request
 */
export interface GetTemplateDiffRequest {
	templateId: string;
	targetCommit?: string; // Optional - defaults to latest
}

/**
 * Template diff response
 */
export interface GetTemplateDiffResponse {
	success: boolean;
	data: TemplateDiffResult;
}

/**
 * Merge strategy for template sync
 */
export type MergeStrategy = "keep_custom" | "sync_new" | "smart_merge";

/**
 * Sync with merge strategy payload
 */
export interface SyncTemplateMergePayload {
	templateId: string;
	targetCommitHash?: string;
	strategy: MergeStrategy;
}

// ============================================================================
// Deployment Preview Types (Phase 4)
// ============================================================================

/**
 * Conflict type for deployment preview
 */
export type ConflictType = "score_mismatch" | "specification_mismatch" | "name_conflict";

/**
 * Conflict resolution strategy
 */
export type ConflictResolution = "use_template" | "keep_existing" | "merge" | "manual";

/**
 * Custom Format action for deployment
 */
export type DeploymentAction = "create" | "update" | "delete" | "skip";

/**
 * Custom Format conflict detail
 */
export interface CustomFormatConflict {
	cfTrashId: string;
	cfName: string;
	conflictType: ConflictType;
	templateValue: unknown;
	instanceValue: unknown;
	suggestedResolution: ConflictResolution;
	resolution?: ConflictResolution; // User's chosen resolution
}

/**
 * Custom Format deployment item
 */
export interface CustomFormatDeploymentItem {
	trashId: string;
	name: string;
	action: DeploymentAction;
	defaultScore: number; // Original score from the template (TRaSH Guides default)
	instanceOverrideScore?: number; // Instance-specific override score (if set)
	scoreOverride: number; // Final effective score (instanceOverrideScore ?? defaultScore)
	templateData: unknown; // Full CF data from template
	instanceData?: unknown; // Existing CF data from instance (if update/conflict)
	conflicts: CustomFormatConflict[];
	hasConflicts: boolean;
}

/**
 * Unmatched Custom Format from instance
 * CFs that exist in the instance but couldn't be matched to a trash_id
 */
export interface UnmatchedCustomFormat {
	instanceId: number; // The CF's ID in the *arr instance
	name: string; // The CF's name
	reason: string; // Why it couldn't be matched (e.g., "No trash_id found in specifications or name pattern")
}

/**
 * Deployment preview result
 */
export interface DeploymentPreview {
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceLabel: string;
	instanceServiceType: "RADARR" | "SONARR";

	// Deployment statistics
	summary: {
		totalItems: number;
		newCustomFormats: number;
		updatedCustomFormats: number;
		deletedCustomFormats: number;
		skippedCustomFormats: number;
		totalConflicts: number;
		unresolvedConflicts: number;
		unmatchedCustomFormats: number; // CFs in instance that couldn't be matched to a trash_id
	};

	// Deployment items
	customFormats: CustomFormatDeploymentItem[];

	// Unmatched CFs in instance (couldn't extract trash_id)
	unmatchedCustomFormats: UnmatchedCustomFormat[];

	// Instance state
	canDeploy: boolean; // False if instance unreachable or conflicts unresolved
	requiresConflictResolution: boolean;
	instanceReachable: boolean;
	instanceVersion?: string;

	// Warnings
	warnings: string[];
}

/**
 * Deployment preview request
 */
export interface GetDeploymentPreviewRequest {
	templateId: string;
	instanceId: string;
}

// ============================================================================
// Phase 5: Bulk Score Management Types
// ============================================================================

/**
 * Score for a custom format in a specific template
 */
export interface TemplateScore {
	templateId: string;
	templateName: string; // User's custom template name
	qualityProfileName: string; // TRaSH quality profile name (e.g., "HD Bluray + WEB")
	scoreSet: string; // Score set used by this template (e.g., "sqp-1-1080p")
	currentScore: number; // Current score in template (may be overridden)
	defaultScore: number; // Original TRaSH Guides score for this score set
	isModified: boolean; // True if currentScore !== defaultScore
	isTemplateManaged?: boolean; // True if this quality profile is managed by a TRaSH template
}

/**
 * Custom Format score entry for bulk management
 * Shows one CF with scores across all templates that use it
 */
export interface CustomFormatScoreEntry {
	trashId: string;
	name: string;
	serviceType: "RADARR" | "SONARR";

	// Scores across all templates using this CF
	templateScores: TemplateScore[]; // One entry per template using this CF

	// Metadata
	hasAnyModifications: boolean; // True if ANY template has a modified score
	groupName?: string; // CF Group this CF belongs to (if any)
	groupTrashId?: string;
}

/**
 * Bulk score management filters
 */
export interface BulkScoreFilters {
	instanceId?: string; // Specific instance to view scores for
	templateIds?: string[];
	groupTrashIds?: string[];
	search?: string; // Search by CF name
	modifiedOnly?: boolean; // Only show user-modified scores
	sortBy?: "name" | "score" | "templateName" | "groupName";
	sortOrder?: "asc" | "desc";
}

/**
 * Bulk score update operation
 */
export interface BulkScoreUpdate {
	targetTrashIds: string[]; // CF trash_ids to update
	targetTemplateIds?: string[]; // Templates to update (if not specified, all templates with these CFs)
	targetScoreSets?: string[]; // Specific score sets to update (if not specified, update all score sets)
	newScore: number;
	resetToDefault?: boolean; // If true, reset to TRaSH Guides default instead of newScore
}

/**
 * Bulk score copy operation
 */
export interface BulkScoreCopy {
	sourceTemplateId: string;
	targetTemplateIds: string[];
	cfTrashIds?: string[]; // Specific CFs to copy (if not specified, copy all)
	overwriteModified?: boolean; // Whether to overwrite user-modified scores in target templates
}

/**
 * Bulk score reset operation
 */
export interface BulkScoreReset {
	templateIds: string[];
	cfTrashIds?: string[]; // Specific CFs to reset (if not specified, reset all)
	resetModificationsFlag?: boolean; // Whether to also reset hasUserModifications flag
}

/**
 * Bulk score export format
 */
export interface BulkScoreExport {
	version: string;
	exportedAt: string;
	serviceType: "RADARR" | "SONARR";
	templates: Array<{
		templateId: string;
		templateName: string;
		scores: Record<string, number>; // CF trash_id → score
	}>;
}

/**
 * Bulk score import operation
 */
export interface BulkScoreImport {
	data: BulkScoreExport;
	targetTemplateIds?: string[]; // Templates to import into (if not specified, create new or match by name)
	overwriteExisting?: boolean;
	createMissing?: boolean; // Create templates that don't exist
}

/**
 * Bulk score management response
 */
export interface BulkScoreManagementResponse {
	success: boolean;
	message: string;
	affectedTemplates: number;
	affectedCustomFormats: number;
	details?: {
		templatesUpdated: string[]; // Template IDs
		customFormatsUpdated: string[]; // CF trash_ids
		errors?: string[];
	};
}

// ============================================================================
// Template Instance Deployment Types
// ============================================================================

/**
 * Sync strategy type for template deployments
 * - auto: Automatically apply TRaSH updates to this instance
 * - manual: User must manually trigger sync
 * - notify: Notify user of updates but don't auto-apply
 */
export type SyncStrategyType = "auto" | "manual" | "notify";

/**
 * Template to Instance deployment mapping
 * Tracks which templates are deployed to which instances with sync preferences
 */
export interface TemplateInstanceDeployment {
	id: string;
	templateId: string;
	instanceId: string;
	qualityProfileId: number;
	qualityProfileName: string;
	syncStrategy: SyncStrategyType;
	createdAt: string;
	updatedAt: string;
	lastSyncedAt: string;
}

/**
 * Request to deploy a template to an instance
 */
export interface DeployTemplateToInstanceRequest {
	templateId: string;
	instanceId: string;
	qualityProfileName: string;
	syncStrategy: SyncStrategyType;
}

/**
 * Request to update deployment settings for an instance
 */
export interface UpdateDeploymentSettingsRequest {
	syncStrategy: SyncStrategyType;
}
