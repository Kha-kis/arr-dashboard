/**
 * Shared Types for TRaSH Guides API Client
 *
 * This file contains types that are shared across multiple modules
 * or are fundamental to the TRaSH Guides integration.
 */

import type {
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
} from "@arr/shared";

// Re-export shared types from @arr/shared for convenience
export type {
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
};

// ============================================================================
// Common Service Types
// ============================================================================

export type ServiceType = "RADARR" | "SONARR";

export type SyncStrategy = "auto" | "manual" | "notify";

// ============================================================================
// Quality Profile Types
// ============================================================================

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

// ============================================================================
// Commit Information
// ============================================================================

export type CommitInfo = {
	commitHash: string;
	commitDate: string;
	author: string;
	message: string;
};
