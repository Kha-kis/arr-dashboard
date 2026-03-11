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
	CommitInfo,
	ConflictResolution,
	ConflictType,
	CustomFormatConflict,
	CustomFormatDeploymentItem,
	CustomQualityConfig,
	DeploymentAction,
	DeploymentPreview,
	GitHubRateLimitResponse,
	QualityProfileSummary,
	QualityProfilesResponse,
	// Common types
	ServiceType,
	SyncMetricsSnapshot,
	SyncStrategy,
	TemplateImportOptions,
	TrashCacheEntry,
	// Core types from @arr/shared
	TrashCacheStatus,
	TrashConfigType,
	TrashTemplate,
} from "./types";

// ============================================================================
// Cache Module
// ============================================================================

export type {
	RefreshCachePayload,
	RefreshCacheResponse,
	TrashCacheStatusResponse,
} from "./cache";
export {
	deleteCacheEntry,
	fetchCacheEntries,
	fetchCacheHealth,
	fetchCacheStatus,
	fetchGitHubRateLimit,
	fetchSyncMetrics,
	refreshCache,
} from "./cache";

// ============================================================================
// Profiles Module
// ============================================================================

export type {
	BulkDeleteOverridesPayload,
	BulkDeleteOverridesResponse,
	CFMatchDetails,
	CFMatchResult,
	CFValidationResponse,
	CFValidationSummary,
	// Cloned profile types
	CreateClonedTemplatePayload,
	DeleteOverrideResponse,
	GetOverridesResponse,
	// Import/export types
	ImportQualityProfilePayload,
	ImportQualityProfileResponse,
	// Instance override types
	InstanceOverride,
	// CF validation types
	MatchConfidence,
	MatchProfilePayload,
	ProfileMatchResult,
	PromoteOverridePayload,
	PromoteOverrideResponse,
	// Profile matching types
	RecommendedCF,
	// Score update types
	ScoreUpdate,
	UpdateProfileScoresPayload,
	UpdateProfileScoresResponse,
	UpdateQualityProfileTemplatePayload,
	ValidateCFsPayload,
} from "./profiles";
export {
	bulkDeleteQualityProfileOverrides,
	// Cloned profile operations
	createClonedProfileTemplate,
	deleteQualityProfileOverride,
	fetchQualityProfileDetails,
	// Quality profile operations
	fetchQualityProfiles,
	// Instance override operations
	getQualityProfileOverrides,
	importQualityProfile,
	matchProfileToTrash,
	promoteOverrideToTemplate,
	updateQualityProfileScores,
	updateQualityProfileTemplate,
	validateClonedCFs,
} from "./profiles";

// ============================================================================
// Updates Module
// ============================================================================

export type {
	AttentionResponse,
	CustomFormatDiffItem,
	CustomFormatGroupDiffItem,
	LatestVersionResponse,
	ProcessAutoUpdatesResponse,
	// Scheduler types
	SchedulerStats,
	SchedulerStatusResponse,
	SuggestedCFAddition,
	SuggestedScoreChange,
	SyncMergeStats,
	SyncScoreConflict,
	// Sync types
	SyncTemplatePayload,
	SyncTemplateResponse,
	TemplateAttention,
	TemplateDiffResponse,
	TemplateDiffResult,
	// Diff types
	TemplateDiffSummary,
	// Template update types
	TemplateUpdateInfo,
	TriggerCheckResponse,
	UpdateCheckResponse,
} from "./updates";
export {
	checkForUpdates,
	getLatestVersion,
	getSchedulerStatus,
	getTemplateDiff,
	getTemplatesNeedingAttention,
	processAutoUpdates,
	syncTemplate,
	triggerUpdateCheck,
} from "./updates";

// ============================================================================
// Deployment Module
// ============================================================================

export type {
	BulkDeploymentResult,
	BulkUpdateSyncStrategyPayload,
	BulkUpdateSyncStrategyResponse,
	DeploymentHistoryDetailResponse,
	// History types
	DeploymentHistoryEntry,
	DeploymentHistoryResponse,
	DeploymentPreviewRequest,
	// Preview types
	DeploymentPreviewResponse,
	// Execution types
	DeploymentResult,
	// Enhanced import types
	EnhancedImportTemplatePayload,
	EnhancedImportTemplateResponse,
	ExecuteBulkDeploymentPayload,
	ExecuteBulkDeploymentResponse,
	ExecuteDeploymentPayload,
	ExecuteDeploymentResponse,
	GetInstanceOverridesResponse,
	// Override types
	InstanceOverrides,
	InstanceOverridesResponse,
	TemplateInstanceOverride,
	UndeployResponse,
	// Unlink types
	UnlinkTemplatePayload,
	UnlinkTemplateResponse,
	UpdateInstanceOverridesPayload,
	UpdateInstanceOverridesResponse,
	// Sync strategy types
	UpdateSyncStrategyPayload,
	UpdateSyncStrategyResponse,
} from "./deployment";
export {
	bulkUpdateSyncStrategy,
	deleteDeploymentHistory,
	deleteInstanceOverrides,
	executeBulkDeployment,
	// Deployment execution
	executeDeployment,
	// History
	getAllDeploymentHistory,
	getDeploymentHistoryDetail,
	// Preview & overrides
	getDeploymentPreview,
	getInstanceDeploymentHistory,
	getInstanceOverrides,
	getTemplateDeploymentHistory,
	// Enhanced import
	importEnhancedTemplate,
	undeployDeployment,
	// Unlink
	unlinkTemplateFromInstance,
	updateInstanceOverrides,
	// Sync strategy
	updateSyncStrategy,
} from "./deployment";

// ============================================================================
// Custom Formats Module
// ============================================================================

export type {
	CFDescription,
	CFDescriptionsListResponse,
	CFInclude,
	CFIncludesListResponse,
	CreateUserCFRequest,
	CustomFormat,
	CustomFormatsListResponse,
	DeployCustomFormatRequest,
	DeployCustomFormatResponse,
	DeployMultipleCustomFormatsRequest,
	DeployMultipleCustomFormatsResponse,
	DeployUserCFsRequest,
	ImportUserCFFromInstanceRequest,
	ImportUserCFFromJsonRequest,
	UserCFImportResponse,
	UserCustomFormat,
	UserCustomFormatsResponse,
} from "./custom-formats";
export {
	createUserCustomFormat,
	deleteUserCustomFormat,
	deployCustomFormat,
	deployMultipleCustomFormats,
	deployUserCustomFormats,
	fetchCFDescriptionsList,
	fetchCFIncludesList,
	fetchCustomFormatsList,
	fetchUserCustomFormats,
	importUserCFsFromInstance,
	importUserCFsFromJson,
	updateUserCustomFormat,
} from "./custom-formats";

// ============================================================================
// Sync Module
// ============================================================================

export type {
	ConflictInfo,
	RollbackResult,
	SyncDetail,
	SyncError,
	SyncExecuteRequest,
	SyncHistoryItem,
	SyncHistoryResponse,
	SyncProgress,
	SyncProgressStatus,
	SyncResult,
	SyncValidationRequest,
	ValidationResult,
} from "./sync";
export {
	createSyncProgressStream,
	executeSync,
	getSyncDetail,
	getSyncHistory,
	getSyncProgress,
	rollbackSync,
	validateSync,
} from "./sync";

// ============================================================================
// Templates Module
// ============================================================================

export type {
	DeleteTemplateResponse,
	TemplateInstanceInfo,
	TemplateListResponse,
	TemplateResponse,
	TemplateStatsResponse,
} from "./templates";
export {
	createTemplate,
	deleteTemplate,
	duplicateTemplate,
	exportTemplate,
	fetchTemplate,
	fetchTemplateStats,
	fetchTemplates,
	importTemplate,
	updateTemplate,
} from "./templates";

// ============================================================================
// Quality Size Module
// ============================================================================

export type {
	ApplyQualitySizePayload,
	ApplyQualitySizeResponse,
	QualitySizeComparison,
	QualitySizeMappingResponse,
	QualitySizePresetsResponse,
	QualitySizePreviewResponse,
	UpdateSyncStrategyPayload as QualitySizeUpdateSyncStrategyPayload,
	UpdateSyncStrategyResponse as QualitySizeUpdateSyncStrategyResponse,
} from "./quality-size";
export {
	applyQualitySize,
	fetchQualitySizeMapping,
	fetchQualitySizePresets,
	getQualitySizePreview,
	updateQualitySizeSyncStrategy,
} from "./quality-size";

// ============================================================================
// Naming Module
// ============================================================================

export type {
	NamingApplyApiResponse,
	NamingApplyPayload,
	NamingConfigApiResponse,
	NamingConfigCreatePayload,
	NamingConfigDeleteResponse,
	NamingConfigSaveResponse,
	NamingPreviewApiResponse,
	NamingPreviewPayload,
	NamingPresetsApiResponse,
} from "./naming";
export {
	applyNaming,
	deleteNamingConfig,
	fetchNamingConfig,
	fetchNamingPresets,
	getNamingPreview,
	saveNamingConfig,
} from "./naming";

// ============================================================================
// Settings Module
// ============================================================================

export type {
	ResetRepoResponse,
	SupplementaryReportConfigEntry,
	SupplementaryReportResponse,
	TestRepoPayload,
	TestRepoResponse,
	TrashSettingsResponse,
	UpdateTrashSettingsPayload,
	UpdateTrashSettingsResponse,
} from "./settings";
export {
	fetchSupplementaryReport,
	fetchTrashSettings,
	resetToOfficialRepo,
	testCustomRepo,
	updateTrashSettings,
} from "./settings";
