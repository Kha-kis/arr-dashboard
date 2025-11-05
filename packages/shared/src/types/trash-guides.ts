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
 * Custom Format Group from TRaSH Guides
 */
export interface TrashCustomFormatGroup {
	trash_id: string;
	name: string;
	custom_formats: string[]; // Array of trash_id references
	quality_profiles?: Array<{
		name: string;
		score?: number;
		except?: string[]; // Quality profile names to exclude
	}>;
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
	data: TrashCustomFormat[] | TrashCustomFormatGroup[] | TrashQualitySize[] | TrashNamingScheme[];
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
	qualitySize?: TrashQualitySize[];
	naming?: TrashNamingScheme[];
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
}

/**
 * Create template request
 */
export interface CreateTemplateRequest {
	name: string;
	description?: string;
	serviceType: "RADARR" | "SONARR";
	config: TemplateConfig;
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
