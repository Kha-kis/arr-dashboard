/**
 * TRaSH Guides Integration Types
 *
 * Types for TRaSH Guides configuration management including:
 * - Cache management
 * - Templates
 * - Sync operations
 * - Backups and rollback
 * - User custom formats
 */

import { z } from "zod";

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
	CF_INCLUDES: "CF_INCLUDES", // MkDocs include files shared across CF descriptions
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
 * Custom Format Specification
 */
export interface CustomFormatSpecification {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
}

/**
 * Custom Format from TRaSH Guides
 */
export interface TrashCustomFormat {
	trash_id: string;
	name: string;
	/** @deprecated Use trash_scores instead. Legacy field for backwards compatibility. */
	score?: number;
	/**
	 * Score mapping by profile score set (e.g., "default", "sqp-1", "anime-radarr").
	 * This is the authoritative source for CF scores in modern TRaSH Guides data.
	 */
	trash_scores?: Record<string, number>;
	trash_description?: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: CustomFormatSpecification[];
	// Optional metadata for instance-sourced CFs (not from TRaSH Guides)
	_source?: "instance" | "trash" | "user_created";
	_instanceId?: string;
	_instanceCFId?: number;
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
 *
 * CF Group Application Logic (quality_profiles):
 * - `include`: (NEW - TRaSH Guides PR #2590) Explicitly lists profiles that SHOULD receive this CF group
 * - `exclude`: (LEGACY) Lists profiles that should NOT receive this CF group
 *
 * Priority: If `include` is present, use include semantics. Otherwise, fall back to exclude semantics.
 * This provides backward compatibility during the TRaSH Guides transition period.
 */
export interface TrashCustomFormatGroup {
	trash_id: string;
	name: string;
	trash_description?: string; // TRaSH's guidance text (HTML format)
	default?: string | boolean; // If "true" or true, this CF Group is enabled by default for applicable profiles
	required?: boolean; // If true, this CF Group cannot be disabled (always required)
	custom_formats: Array<GroupCustomFormat | string>; // Can be objects or trash_id strings
	quality_profiles?: {
		/**
		 * NEW (TRaSH Guides PR #2590): Profiles that SHOULD receive this CF group.
		 * If present, only these profiles get this CF group (include semantics).
		 * Maps profile name → trash_id
		 */
		include?: Record<string, string>;
		/**
		 * LEGACY: Profiles that should NOT receive this CF group.
		 * Only used if `include` is not present (exclude semantics).
		 * Maps profile name → trash_id
		 * @deprecated Will be removed once TRaSH Guides fully migrates to include semantics
		 */
		exclude?: Record<string, string>;
		score?: number; // Recommended score
	};
}

/**
 * Helper function to determine if a CF Group applies to a quality profile.
 *
 * Supports both new `include` semantics (TRaSH Guides PR #2590) and legacy `exclude` semantics.
 *
 * Logic:
 * 1. If `include` is present: CF group applies ONLY to profiles listed in include
 * 2. If `include` is absent: CF group applies to ALL profiles EXCEPT those in exclude
 *
 * @param group - The CF Group to check
 * @param profileTrashId - The trash_id of the quality profile
 * @returns true if the CF group should be applied to this profile
 */
export function isCFGroupApplicableToProfile(
	group: TrashCustomFormatGroup,
	profileTrashId: string
): boolean {
	const qualityProfiles = group.quality_profiles;

	// No quality_profiles restriction - applies to all profiles
	if (!qualityProfiles) {
		return true;
	}

	// NEW: Include semantics (TRaSH Guides PR #2590)
	// If include is present, only apply to explicitly listed profiles
	if (qualityProfiles.include) {
		return Object.values(qualityProfiles.include).includes(profileTrashId);
	}

	// LEGACY: Exclude semantics
	// Apply to all profiles EXCEPT those in the exclude list
	if (qualityProfiles.exclude) {
		return !Object.values(qualityProfiles.exclude).includes(profileTrashId);
	}

	// No include or exclude - applies to all profiles
	return true;
}

/**
 * Single quality entry within a TRaSH Quality Size preset.
 * Defines file size limits (in GB per hour of content) for one quality tier.
 */
export interface TrashQualitySizeQuality {
	quality: string; // e.g., "HDTV-720p", "Bluray-1080p"
	min: number; // Minimum file size
	preferred: number; // Preferred file size
	max: number; // Maximum file size
}

/**
 * Quality Size preset from TRaSH Guides.
 * Each preset contains min/preferred/max file size settings for all quality tiers.
 *
 * Available presets:
 * - Radarr: movie, anime, sqp-streaming, sqp-uhd
 * - Sonarr: series, anime
 */
export interface TrashQualitySize {
	trash_id: string; // Unique preset identifier
	type: string; // e.g., "movie", "series", "anime", "sqp-streaming", "sqp-uhd"
	qualities: TrashQualitySizeQuality[];
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

/**
 * MkDocs include file content.
 * These files are referenced by CF descriptions using --8<-- "path" syntax.
 * Stored separately and resolved on the frontend to avoid excessive API calls.
 */
export interface TrashCFInclude {
	path: string; // Full path (e.g., "includes/cf-descriptions/apply-10000.md")
	content: string; // Cleaned content (HTML comments removed)
	fetchedAt: string;
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

/**
 * GitHub API rate limit status
 */
export type GitHubRateLimitStatus = "ok" | "warning" | "critical" | "unknown";

/**
 * GitHub API rate limit response
 */
export interface GitHubRateLimitResponse {
	status: GitHubRateLimitStatus;
	/** Maximum requests per hour */
	limit?: number;
	/** Remaining requests in current window */
	remaining?: number;
	/** ISO timestamp when rate limit resets */
	resetAt?: string;
	/** Seconds until rate limit resets */
	secondsUntilReset?: number;
	/** ISO timestamp of last rate limit update */
	lastUpdated?: string;
	/** Whether using authenticated requests (higher limits) */
	isAuthenticated?: boolean;
	/** Human-readable status message */
	message: string;
}

// ============================================================================
// Sync Metrics Types
// ============================================================================

/**
 * Type of sync operation for metrics tracking
 */
export type SyncOperationType = "sync" | "deployment" | "rollback" | "template_update";

/**
 * Metrics for a single operation type
 */
export interface SyncOperationMetric {
	count: number;
	successCount: number;
	failureCount: number;
	lastRun: string | null;
	lastSuccess: string | null;
	lastFailure: string | null;
	totalDurationMs: number;
	avgDurationMs: number;
	minDurationMs: number;
	maxDurationMs: number;
}

/**
 * Recent error information
 */
export interface SyncErrorMetric {
	message: string;
	count: number;
	lastOccurred: string;
	operationType: SyncOperationType;
}

/**
 * Complete sync metrics snapshot
 */
export interface SyncMetricsSnapshot {
	/** Server uptime in seconds */
	uptime: number;
	/** ISO timestamp when metrics collection started */
	startedAt: string;
	/** Metrics by operation type */
	operations: Record<SyncOperationType, SyncOperationMetric>;
	/** Recent errors (limited to last 20) */
	recentErrors: SyncErrorMetric[];
	/** Aggregate totals */
	totals: {
		totalOperations: number;
		successRate: number;
		avgDurationMs: number;
	};
}

// ============================================================================
// Template Types
// ============================================================================

/**
 * Origin of a custom format in a template
 * - "trash_sync": Added automatically during TRaSH Guides sync
 * - "user_added": Manually added by user in template editor
 * - "imported": Added via template import
 */
export type CFOrigin = "trash_sync" | "user_added" | "imported";

/**
 * Custom Format with user customizations
 *
 * Score Resolution Priority (used by deployment and display):
 * 1. scoreOverride - User's explicit override (always wins)
 * 2. originalConfig.trash_scores[scoreSet] - TRaSH score for the profile's score set
 * 3. originalConfig.trash_scores.default - TRaSH default score
 * 4. 0 - Final fallback
 */
export interface TemplateCustomFormat {
	trashId: string;
	name: string;
	/**
	 * @deprecated Since v2.5.0 - Vestigial field, no longer set during template creation/update.
	 * Will be removed in v3.0.0. Use scoreOverride for user overrides or
	 * originalConfig.trash_scores[scoreSet] for TRaSH-recommended scores.
	 * Migration: Safe to ignore - field is not read by any code paths.
	 */
	score?: number;
	scoreOverride?: number; // User-defined score override
	conditionsEnabled: Record<string, boolean>; // Which conditions are enabled
	originalConfig: TrashCustomFormat; // Original TRaSH config with trash_scores
	// Origin tracking (for controlling deletion behavior)
	origin?: CFOrigin; // undefined = legacy (treat as "trash_sync")
	addedAt?: string; // ISO timestamp when CF was added to template
	// Deprecation tracking (CF no longer in TRaSH Guides)
	deprecated?: boolean; // true if CF was removed from TRaSH Guides upstream
	deprecatedAt?: string; // ISO timestamp when CF was marked deprecated
	deprecatedReason?: string; // e.g., "Removed from TRaSH Guides as of commit abc123"
}

/**
 * Custom Format Group in template
 */
export interface TemplateCustomFormatGroup {
	trashId: string;
	name: string;
	enabled: boolean;
	originalConfig: TrashCustomFormatGroup;
	// Origin tracking (mirrors TemplateCustomFormat)
	origin?: CFOrigin;
	addedAt?: string;
	deprecated?: boolean;
	deprecatedAt?: string;
	deprecatedReason?: string;
}

/**
 * Template sync settings
 */
export interface TemplateSyncSettings {
	/**
	 * Whether to delete CFs that are removed from TRaSH Guides.
	 * - false (default): Mark deprecated but keep in template (Recyclarr-style conservative)
	 * - true: Delete CFs that are no longer in TRaSH (only affects origin="trash_sync")
	 * Note: User-added CFs are NEVER deleted regardless of this setting.
	 */
	deleteRemovedCFs?: boolean;
}

// ============================================================================
// Quality Customization Types
// ============================================================================

/**
 * A single quality definition for template configuration
 * Used when a quality is not part of a group
 */
export interface TemplateQualityItem {
	/** Internal ID for ordering and cutoff reference */
	id: string;
	/** Quality name (must match *arr quality name for deployment) */
	name: string;
	/** Whether this quality is enabled/wanted */
	allowed: boolean;
	/** Optional source info (e.g., "bluray", "webdl", "webrip") */
	source?: string;
	/** Optional resolution (e.g., 1080, 2160) */
	resolution?: number;
}

/**
 * A quality group containing multiple qualities
 * Groups are treated as equivalent - any quality in the group satisfies the requirement
 */
export interface TemplateQualityGroup {
	/** Internal ID for ordering and cutoff reference */
	id: string;
	/** Group display name (e.g., "WEB 1080p", "Bluray-1080p") */
	name: string;
	/** Whether this entire group is enabled/wanted */
	allowed: boolean;
	/** Qualities within this group */
	qualities: Array<{
		name: string;
		source?: string;
		resolution?: number;
	}>;
}

/**
 * Union type for quality items - can be single quality or group
 */
export type TemplateQualityEntry =
	| { type: "quality"; item: TemplateQualityItem }
	| { type: "group"; group: TemplateQualityGroup };

/**
 * Custom quality configuration for templates
 * Allows power users to customize quality ordering, grouping, and preferences
 */
export interface CustomQualityConfig {
	/**
	 * Whether the user has customized qualities or is using TRaSH/instance defaults
	 * - false: Use default quality items from TRaSH profile or cloned instance
	 * - true: Use the custom items defined below
	 */
	useCustomQualities: boolean;

	/**
	 * Custom quality items (ordered from lowest to highest preference)
	 * In Radarr/Sonarr, items at the bottom of the list are most preferred
	 */
	items: TemplateQualityEntry[];

	/**
	 * The cutoff quality/group ID
	 * Upgrades will stop once this quality level is reached
	 */
	cutoffId?: string;

	/**
	 * Timestamp when qualities were last customized
	 */
	customizedAt?: string;

	/**
	 * Origin of the base quality configuration
	 * - "trash_profile": Started from TRaSH Guides profile
	 * - "instance_clone": Started from cloned instance profile
	 * - "manual": Manually created from scratch
	 * - "instance": Per-instance override (overrides template default)
	 */
	origin?: "trash_profile" | "instance_clone" | "manual" | "instance";
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
	// Sync behavior settings
	syncSettings?: TemplateSyncSettings;
	// Custom quality configuration (power user feature)
	customQualityConfig?: CustomQualityConfig;
}

/**
 * Phase 5.3: Complete quality profile data from *arr instance
 * This allows templates to be full quality profile clones
 */
export interface CompleteQualityProfile {
	// Source information
	sourceInstanceId: string; // Instance this was imported from
	sourceInstanceLabel?: string; // Friendly name of source instance
	sourceProfileId: number; // *arr quality profile ID
	sourceProfileName: string; // Original profile name
	importedAt: string; // When it was imported

	// Quality definitions
	upgradeAllowed: boolean;
	cutoff: number; // Quality ID
	cutoffQuality?: {
		id: number;
		name: string;
		source?: string; // Optional - may not be resolved from all sources
		resolution?: number; // Optional - may not be resolved from all sources
	};

	// Quality items with ordering
	items: Array<{
		quality?: {
			id: number;
			name: string;
			source?: string;
			resolution?: number;
		};
		items?: Array<{
			id: number;
			name: string;
			source?: string;
			resolution?: number;
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
 * Auto-sync change log entry - records changes made during automatic template synchronization.
 * Captures detailed change data from MergeStats for frontend display and audit trail.
 */
export interface AutoSyncChangeLogEntry {
	/** Entry type discriminator for changelog polymorphism */
	changeType: "auto_sync";
	/** ISO 8601 timestamp of when the sync occurred */
	timestamp: string;
	/** TRaSH Guides commit hash before sync */
	fromCommitHash: string | null;
	/** TRaSH Guides commit hash after sync */
	toCommitHash: string;

	/** Custom formats that were added during sync */
	customFormatsAdded: Array<{
		trashId: string;
		name: string;
		score: number;
	}>;
	/** Custom formats that were removed during sync (no longer in TRaSH Guides) */
	customFormatsRemoved: Array<{
		trashId: string;
		name: string;
	}>;
	/** Custom formats whose specifications were updated */
	customFormatsUpdated: Array<{
		trashId: string;
		name: string;
	}>;

	/** Score changes applied during sync */
	scoreChanges: Array<{
		trashId: string;
		name: string;
		oldScore: number;
		newScore: number;
	}>;

	/** Summary statistics mirroring MergeStats for quick overview */
	summaryStats: {
		customFormatsAdded: number;
		customFormatsRemoved: number;
		customFormatsUpdated: number;
		customFormatsPreserved: number;
		customFormatGroupsAdded: number;
		customFormatGroupsRemoved: number;
		customFormatGroupsUpdated: number;
		customFormatGroupsPreserved: number;
		scoresUpdated: number;
		scoresSkippedDueToOverride: number;
		userCustomizationsPreserved: string[];
	};
}

/**
 * Phase 3: Instance-specific overrides for a template
 * Allows per-instance customization while keeping template as the default
 */
export interface TemplateInstanceOverride {
	instanceId: string;
	/** CF score overrides - CF trash_id → score */
	cfScoreOverrides?: Record<string, number>;
	/** CF selection overrides - CF trash_id → { enabled } */
	cfSelectionOverrides?: Record<string, { enabled: boolean }>;
	/** CF condition overrides - CF trash_id → condition name → enabled */
	conditionOverrides?: Record<string, Record<string, boolean>>;
	/**
	 * Quality configuration override for this instance
	 * If set, this instance uses this config instead of template default
	 * If undefined, instance uses template's customQualityConfig
	 */
	qualityConfigOverride?: CustomQualityConfig;
	lastModifiedAt: string;
	lastModifiedBy: string;
}

/**
 * Instance quality override status for UI display
 * Helps the frontend show which instances have overrides
 */
export interface InstanceQualityOverrideStatus {
	instanceId: string;
	instanceLabel: string;
	/** Whether this instance has a quality config override */
	hasOverride: boolean;
	/** Source of the effective quality config */
	effectiveConfigSource: "template_default" | "instance_override";
	/** The cutoff name (for display) */
	cutoffName?: string;
	/** When the override was last modified */
	lastModifiedAt?: string;
}

/**
 * Helper to get effective quality config for an instance
 * Returns instance override if set, otherwise returns template default
 */
export function getEffectiveQualityConfig(
	template: TrashTemplate,
	instanceId: string
): { config: CustomQualityConfig | undefined; source: "template_default" | "instance_override" } {
	const override = template.instanceOverrides?.[instanceId]?.qualityConfigOverride;
	if (override) {
		return { config: override, source: "instance_override" };
	}
	return { config: template.config.customQualityConfig, source: "template_default" };
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
 * Custom upstream repository configuration for TRaSH Guides.
 * Allows users to point at a fork that follows the same directory structure
 * as the official TRaSH-Guides/Guides repo.
 *
 * When a custom repo is configured, it **replaces** the official upstream
 * entirely (forks already contain all official CFs plus custom additions).
 */
export interface TrashRepoConfig {
	owner: string;   // GitHub owner, e.g., "TRaSH-Guides"
	name: string;    // Repository name, e.g., "Guides"
	branch: string;  // Branch name, e.g., "master" or "main"
}

/**
 * Default TRaSH Guides repository configuration.
 * Used when no custom repo is configured by the user.
 */
export const DEFAULT_TRASH_REPO: TrashRepoConfig = {
	owner: "TRaSH-Guides",
	name: "Guides",
	branch: "master",
};

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
	customRepoOwner?: string | null;
	customRepoName?: string | null;
	customRepoBranch?: string | null;
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
	customRepoOwner?: string | null;
	customRepoName?: string | null;
	customRepoBranch?: string | null;
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
		templatesNeedingApproval: number; // Templates with CF Group additions needing user approval
		templatesWithScoreConflicts: number; // Templates where score updates were skipped due to user overrides
		templatesWithAutoStrategy: number;
		templatesWithNotifyStrategy: number;
		cachesRefreshed: number;
		cachesFailed: number;
		qualitySizeAutoSynced: number;
		qualitySizeUpdatesPending: number;
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
	currentSpecifications?: CustomFormatSpecification[];
	newSpecifications?: CustomFormatSpecification[];
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
 * Suggested CF addition from CF Group or Quality Profile
 */
export interface SuggestedCFAddition {
	trashId: string;
	name: string;
	recommendedScore: number;
	source: "cf_group" | "quality_profile";
	sourceGroupName?: string; // Name of CF Group if source is cf_group
	sourceProfileName?: string; // Name of Quality Profile if source is quality_profile
	specifications: CustomFormatSpecification[];
}

/**
 * Suggested score change from Quality Profile
 */
export interface SuggestedScoreChange {
	trashId: string;
	name: string;
	currentScore: number;
	recommendedScore: number;
	scoreSet: string; // e.g., "default", "sqp-1-1080p"
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
	// Suggested additions (Option 2) - shown separately from main diff
	suggestedAdditions?: SuggestedCFAddition[];
	suggestedScoreChanges?: SuggestedScoreChange[];
	/**
	 * True when the template is already at the target version and
	 * the diff was reconstructed from historical changelog data.
	 * Frontend can use this to show "Last sync changes" instead of "Pending changes".
	 */
	isHistorical?: boolean;
	/** Timestamp of the historical sync, if isHistorical is true */
	historicalSyncTimestamp?: string;
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

	// Existing deployment settings (if previously deployed)
	existingSyncStrategy?: "auto" | "manual" | "notify";

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

// ============================================================================
// Standalone Custom Format Deployment Types
// ============================================================================

/**
 * A standalone custom format deployment record
 * Tracks CFs deployed via the Custom Formats tab (outside of templates)
 */
export interface StandaloneCFDeployment {
	id: string;
	cfTrashId: string;
	cfName: string;
	instanceId: string;
	instanceLabel: string;
	serviceType: "RADARR" | "SONARR";
	commitHash: string;
	deployedAt: string;
}

/**
 * Standalone CF update check result
 * Indicates a CF that has been updated in TRaSH Guides since deployment
 */
export interface StandaloneCFUpdate {
	cfTrashId: string;
	cfName: string;
	instanceId: string;
	instanceLabel: string;
	serviceType: string;
	deployedCommitHash: string;
	currentCommitHash: string;
}

/**
 * Response from standalone CF updates check endpoint
 */
export interface StandaloneCFUpdatesResponse {
	success: boolean;
	hasUpdates: boolean;
	updates: StandaloneCFUpdate[];
	totalDeployed: number;
	outdatedCount: number;
	message?: string;
}

/**
 * Response from standalone deployments list endpoint
 */
export interface StandaloneCFDeploymentsResponse {
	success: boolean;
	deployments: StandaloneCFDeployment[];
	count: number;
}

// ============================================================================
// User Custom Formats
// User-created or imported custom formats for TRaSH Guides templates
// ============================================================================

/**
 * Zod schema for creating a user custom format
 */
export const createUserCustomFormatSchema = z.object({
	name: z.string().min(1, "Name is required").max(200),
	serviceType: z.enum(["RADARR", "SONARR"]),
	description: z.string().max(2000).optional(),
	includeCustomFormatWhenRenaming: z.boolean().default(false),
	specifications: z.array(z.object({
		name: z.string().min(1),
		implementation: z.string().min(1),
		negate: z.boolean().default(false),
		required: z.boolean().default(false),
		fields: z.record(z.string(), z.unknown()).default({}),
	})).min(1, "At least one specification is required"),
	defaultScore: z.number().int().default(0),
});

export type CreateUserCustomFormatInput = z.infer<typeof createUserCustomFormatSchema>;

/**
 * Zod schema for updating a user custom format
 */
export const updateUserCustomFormatSchema = createUserCustomFormatSchema.partial().extend({
	name: z.string().min(1).max(200).optional(),
});

export type UpdateUserCustomFormatInput = z.infer<typeof updateUserCustomFormatSchema>;

/**
 * Zod schema for importing CFs from JSON (Sonarr/Radarr export format)
 */
export const importUserCFFromJsonSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
	customFormats: z.array(z.object({
		name: z.string().min(1),
		includeCustomFormatWhenRenaming: z.boolean().optional(),
		specifications: z.array(z.object({
			name: z.string(),
			implementation: z.string(),
			negate: z.boolean().optional(),
			required: z.boolean().optional(),
			fields: z.union([
				z.record(z.string(), z.unknown()),
				z.array(z.object({ name: z.string(), value: z.unknown() })),
			]).optional(),
		})).optional(),
	})).min(1, "At least one custom format is required"),
	defaultScore: z.number().int().optional().default(0),
});

export type ImportUserCFFromJsonInput = z.infer<typeof importUserCFFromJsonSchema>;

/**
 * Zod schema for importing CFs from a connected instance
 */
export const importUserCFFromInstanceSchema = z.object({
	instanceId: z.string().min(1),
	cfIds: z.array(z.number().int()).min(1, "At least one CF ID is required"),
	defaultScore: z.number().int().optional().default(0),
});

export type ImportUserCFFromInstanceInput = z.infer<typeof importUserCFFromInstanceSchema>;

/**
 * User Custom Format response type (from API)
 */
export interface UserCustomFormat {
	id: string;
	name: string;
	serviceType: "RADARR" | "SONARR";
	description: string | null;
	includeCustomFormatWhenRenaming: boolean;
	specifications: CustomFormatSpecification[];
	defaultScore: number;
	sourceInstanceId: string | null;
	sourceCFId: number | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Response from user custom formats list endpoint
 */
export interface UserCustomFormatsResponse {
	success: boolean;
	customFormats: UserCustomFormat[];
	count: number;
}

/**
 * Response from user custom format import operations
 */
export interface UserCFImportResponse {
	success: boolean;
	created: string[];
	skipped: string[];
	failed: Array<{ name: string; error: string }>;
}
