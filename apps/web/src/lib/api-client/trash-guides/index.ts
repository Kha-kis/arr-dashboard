/**
 * TRaSH Guides API Client
 *
 * Modular API client for TRaSH Guides integration.
 * This barrel file re-exports all functions and types for backward compatibility.
 *
 * Modules:
 * - cache.ts           - Cache status, refresh, rate limits
 * - profiles.ts        - Quality profile operations, overrides, cloning
 * - updates.ts         - Template updates, syncing, scheduler
 * - deployment.ts      - Deployment preview, execution, history
 * - quality-size.ts    - Quality size preset management
 * - settings.ts        - TRaSH Guides settings, custom repo configuration
 * - custom-formats.ts  - Custom format browsing, deployment, user CFs
 * - sync.ts            - Sync validation, execution, progress, history
 * - templates.ts       - Template CRUD, export/import, stats
 */

// ============================================================================
// Shared Types
// ============================================================================

export type {
	// Core types from @arr/shared
	TrashCacheStatus,
	TrashCacheEntry,
	CustomQualityConfig,
	TrashConfigType,
	GitHubRateLimitResponse,
	SyncMetricsSnapshot,
	DeploymentPreview,
	CustomFormatDeploymentItem,
	CustomFormatConflict,
	DeploymentAction,
	ConflictType,
	ConflictResolution,
	TemplateImportOptions,
	TrashTemplate,
	// Common types
	ServiceType,
	SyncStrategy,
	QualityProfileSummary,
	QualityProfilesResponse,
	CommitInfo,
} from "./types";

// ============================================================================
// Cache Module
// ============================================================================

export {
	fetchCacheStatus,
	refreshCache,
	fetchGitHubRateLimit,
	fetchSyncMetrics,
	fetchCacheEntries,
	deleteCacheEntry,
} from "./cache";

export type {
	TrashCacheStatusResponse,
	RefreshCachePayload,
	RefreshCacheResponse,
} from "./cache";

// ============================================================================
// Profiles Module
// ============================================================================

export {
	// Quality profile operations
	fetchQualityProfiles,
	fetchQualityProfileDetails,
	importQualityProfile,
	updateQualityProfileTemplate,
	// Instance override operations
	getQualityProfileOverrides,
	promoteOverrideToTemplate,
	deleteQualityProfileOverride,
	bulkDeleteQualityProfileOverrides,
	updateQualityProfileScores,
	// Cloned profile operations
	createClonedProfileTemplate,
	validateClonedCFs,
	matchProfileToTrash,
} from "./profiles";

export type {
	// Import/export types
	ImportQualityProfilePayload,
	UpdateQualityProfileTemplatePayload,
	ImportQualityProfileResponse,
	// Instance override types
	InstanceOverride,
	GetOverridesResponse,
	PromoteOverridePayload,
	PromoteOverrideResponse,
	DeleteOverrideResponse,
	BulkDeleteOverridesPayload,
	BulkDeleteOverridesResponse,
	// Score update types
	ScoreUpdate,
	UpdateProfileScoresPayload,
	UpdateProfileScoresResponse,
	// Cloned profile types
	CreateClonedTemplatePayload,
	// CF validation types
	MatchConfidence,
	CFMatchDetails,
	CFMatchResult,
	CFValidationSummary,
	CFValidationResponse,
	ValidateCFsPayload,
	// Profile matching types
	RecommendedCF,
	ProfileMatchResult,
	MatchProfilePayload,
} from "./profiles";

// ============================================================================
// Updates Module
// ============================================================================

export {
	checkForUpdates,
	getTemplatesNeedingAttention,
	syncTemplate,
	processAutoUpdates,
	getLatestVersion,
	getSchedulerStatus,
	triggerUpdateCheck,
	getTemplateDiff,
} from "./updates";

export type {
	// Template update types
	TemplateUpdateInfo,
	UpdateCheckResponse,
	TemplateAttention,
	AttentionResponse,
	// Sync types
	SyncTemplatePayload,
	SyncMergeStats,
	SyncScoreConflict,
	SyncTemplateResponse,
	ProcessAutoUpdatesResponse,
	LatestVersionResponse,
	// Scheduler types
	SchedulerStats,
	SchedulerStatusResponse,
	TriggerCheckResponse,
	// Diff types
	TemplateDiffSummary,
	CustomFormatDiffItem,
	CustomFormatGroupDiffItem,
	SuggestedCFAddition,
	SuggestedScoreChange,
	TemplateDiffResult,
	TemplateDiffResponse,
} from "./updates";

// ============================================================================
// Deployment Module
// ============================================================================

export {
	// Preview & overrides
	getDeploymentPreview,
	getInstanceOverrides,
	updateInstanceOverrides,
	deleteInstanceOverrides,
	// Deployment execution
	executeDeployment,
	executeBulkDeployment,
	// Sync strategy
	updateSyncStrategy,
	bulkUpdateSyncStrategy,
	// Unlink
	unlinkTemplateFromInstance,
	// History
	getAllDeploymentHistory,
	getTemplateDeploymentHistory,
	getInstanceDeploymentHistory,
	getDeploymentHistoryDetail,
	undeployDeployment,
	deleteDeploymentHistory,
	// Enhanced import
	importEnhancedTemplate,
} from "./deployment";

export type {
	// Preview types
	DeploymentPreviewResponse,
	DeploymentPreviewRequest,
	// Override types
	InstanceOverrides,
	InstanceOverridesResponse,
	UpdateInstanceOverridesPayload,
	TemplateInstanceOverride,
	UpdateInstanceOverridesResponse,
	GetInstanceOverridesResponse,
	// Execution types
	DeploymentResult,
	BulkDeploymentResult,
	ExecuteDeploymentPayload,
	ExecuteDeploymentResponse,
	ExecuteBulkDeploymentPayload,
	ExecuteBulkDeploymentResponse,
	// Sync strategy types
	UpdateSyncStrategyPayload,
	UpdateSyncStrategyResponse,
	BulkUpdateSyncStrategyPayload,
	BulkUpdateSyncStrategyResponse,
	// Unlink types
	UnlinkTemplatePayload,
	UnlinkTemplateResponse,
	// History types
	DeploymentHistoryEntry,
	DeploymentHistoryResponse,
	DeploymentHistoryDetailResponse,
	UndeployResponse,
	// Enhanced import types
	EnhancedImportTemplatePayload,
	EnhancedImportTemplateResponse,
} from "./deployment";

// ============================================================================
// Custom Formats Module
// ============================================================================

export {
	fetchCustomFormatsList,
	fetchCFDescriptionsList,
	fetchCFIncludesList,
	deployCustomFormat,
	deployMultipleCustomFormats,
	fetchUserCustomFormats,
	createUserCustomFormat,
	updateUserCustomFormat,
	deleteUserCustomFormat,
	importUserCFsFromJson,
	importUserCFsFromInstance,
	deployUserCustomFormats,
} from "./custom-formats";

export type {
	CustomFormat,
	CFDescription,
	CustomFormatsListResponse,
	CFDescriptionsListResponse,
	CFInclude,
	CFIncludesListResponse,
	DeployCustomFormatRequest,
	DeployMultipleCustomFormatsRequest,
	DeployCustomFormatResponse,
	DeployMultipleCustomFormatsResponse,
	UserCustomFormat,
	UserCustomFormatsResponse,
	UserCFImportResponse,
	CreateUserCFRequest,
	ImportUserCFFromJsonRequest,
	ImportUserCFFromInstanceRequest,
	DeployUserCFsRequest,
} from "./custom-formats";

// ============================================================================
// Sync Module
// ============================================================================

export {
	validateSync,
	executeSync,
	getSyncProgress,
	getSyncHistory,
	getSyncDetail,
	rollbackSync,
	createSyncProgressStream,
} from "./sync";

export type {
	SyncValidationRequest,
	ConflictInfo,
	ValidationResult,
	SyncExecuteRequest,
	SyncError,
	SyncResult,
	SyncProgressStatus,
	SyncProgress,
	SyncHistoryItem,
	SyncHistoryResponse,
	SyncDetail,
	RollbackResult,
} from "./sync";

// ============================================================================
// Templates Module
// ============================================================================

export {
	fetchTemplates,
	fetchTemplate,
	createTemplate,
	updateTemplate,
	deleteTemplate,
	duplicateTemplate,
	exportTemplate,
	importTemplate,
	fetchTemplateStats,
} from "./templates";

export type {
	TemplateListResponse,
	TemplateResponse,
	TemplateInstanceInfo,
	TemplateStatsResponse,
	DeleteTemplateResponse,
} from "./templates";

// ============================================================================
// Quality Size Module
// ============================================================================

export {
	fetchQualitySizePresets,
	getQualitySizePreview,
	fetchQualitySizeMapping,
	applyQualitySize,
	updateQualitySizeSyncStrategy,
} from "./quality-size";

export type {
	QualitySizePresetsResponse,
	QualitySizeComparison,
	QualitySizePreviewResponse,
	QualitySizeMappingResponse,
	ApplyQualitySizePayload,
	ApplyQualitySizeResponse,
	UpdateSyncStrategyPayload as QualitySizeUpdateSyncStrategyPayload,
	UpdateSyncStrategyResponse as QualitySizeUpdateSyncStrategyResponse,
} from "./quality-size";

// ============================================================================
// Settings Module
// ============================================================================

export {
	fetchTrashSettings,
	updateTrashSettings,
	testCustomRepo,
	resetToOfficialRepo,
} from "./settings";

export type {
	TrashSettingsResponse,
	UpdateTrashSettingsPayload,
	UpdateTrashSettingsResponse,
	TestRepoPayload,
	TestRepoResponse,
	ResetRepoResponse,
} from "./settings";
