/**
 * Queue Cleaner feature types
 *
 * Re-exports shared types from @arr/shared plus frontend-specific
 * types for API responses, UI state, and component props.
 */

// Re-export shared types for convenience
export type {
	CleanerRule,
	PreviewStatusRule,
	PreviewRule,
	ImportBlockCleanupLevel,
	ImportBlockPatternMode,
	WhitelistType,
	WhitelistPattern,
	CleanerResultItem,
	StrikeInfo,
	CleanerResult,
	// Preview types - imported from shared to avoid duplication
	EnhancedPreviewItem,
	QueueStateSummary,
	EnhancedPreviewResult,
} from "@arr/shared";

// Import types we need to reference in this file
import type {
	CleanerResultItem,
	ImportBlockCleanupLevel,
	ImportBlockPatternMode,
} from "@arr/shared";

// ============================================================================
// Frontend-Specific Types: API Status & Config
// ============================================================================

export interface QueueCleanerStatus {
	schedulerRunning: boolean;
	schedulerHealthy: boolean;
	schedulerLastError: string | null;
	schedulerWarnings?: string[];
	instances: InstanceCleanerStatus[];
}

export interface InstanceCleanerStatus {
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	enabled: boolean;
	dryRunMode: boolean;
	lastRunAt: string | null;
	lastRunItemsCleaned: number;
	lastRunItemsSkipped: number;
	cleanedToday: number;
	skippedToday: number;
	hasConfig: boolean;
}

export interface QueueCleanerConfig {
	id: string;
	instanceId: string;
	enabled: boolean;
	intervalMins: number;
	// Stalled rule
	stalledEnabled: boolean;
	stalledThresholdMins: number;
	// Failed rule
	failedEnabled: boolean;
	// Slow rule
	slowEnabled: boolean;
	slowSpeedThreshold: number;
	slowGracePeriodMins: number;
	// Error patterns rule
	errorPatternsEnabled: boolean;
	errorPatterns: string | null;
	// Strike system
	strikeSystemEnabled: boolean;
	maxStrikes: number;
	strikeDecayHours: number;
	// Seeding timeout (torrent-only)
	seedingTimeoutEnabled: boolean;
	seedingTimeoutHours: number;
	// Estimated completion
	estimatedCompletionEnabled: boolean;
	estimatedCompletionMultiplier: number;
	// Import pending timeout
	importPendingThresholdMins: number;
	// Import block cleanup aggressiveness
	importBlockCleanupLevel: ImportBlockCleanupLevel;
	// Import block pattern matching
	importBlockPatternMode: ImportBlockPatternMode;
	// Custom import block patterns (JSON array of strings)
	importBlockPatterns: string | null;
	// Whitelist
	whitelistEnabled: boolean;
	whitelistPatterns: string | null;
	// Removal options
	removeFromClient: boolean;
	addToBlocklist: boolean;
	searchAfterRemoval: boolean;
	// Change category (torrent-only)
	// Instead of deleting, move torrent to a different category in the client
	changeCategoryEnabled: boolean;
	// Safety settings
	dryRunMode: boolean;
	maxRemovalsPerRun: number;
	minQueueAgeMins: number;
	// State
	lastRunAt: string | null;
	lastRunItemsCleaned: number;
	lastRunItemsSkipped: number;
	createdAt: string;
	updatedAt: string;
}

export interface QueueCleanerConfigWithInstance extends QueueCleanerConfig {
	instanceName: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
}

export interface QueueCleanerConfigUpdate {
	enabled?: boolean;
	intervalMins?: number;
	stalledEnabled?: boolean;
	stalledThresholdMins?: number;
	failedEnabled?: boolean;
	slowEnabled?: boolean;
	slowSpeedThreshold?: number;
	slowGracePeriodMins?: number;
	errorPatternsEnabled?: boolean;
	errorPatterns?: string | null;
	// Strike system
	strikeSystemEnabled?: boolean;
	maxStrikes?: number;
	strikeDecayHours?: number;
	// Seeding timeout (torrent-only)
	seedingTimeoutEnabled?: boolean;
	seedingTimeoutHours?: number;
	// Estimated completion
	estimatedCompletionEnabled?: boolean;
	estimatedCompletionMultiplier?: number;
	// Import pending timeout
	importPendingThresholdMins?: number;
	// Import block cleanup level
	importBlockCleanupLevel?: ImportBlockCleanupLevel;
	// Import block pattern mode
	importBlockPatternMode?: ImportBlockPatternMode;
	// Custom import block patterns (JSON array of strings)
	importBlockPatterns?: string | null;
	// Whitelist
	whitelistEnabled?: boolean;
	whitelistPatterns?: string | null;
	// Removal options
	removeFromClient?: boolean;
	addToBlocklist?: boolean;
	searchAfterRemoval?: boolean;
	// Change category (torrent-only)
	changeCategoryEnabled?: boolean;
	// Safety settings
	dryRunMode?: boolean;
	maxRemovalsPerRun?: number;
	minQueueAgeMins?: number;
}

// ============================================================================
// Frontend-Specific Types: Logs & Activity
// ============================================================================

export interface QueueCleanerLog {
	id: string;
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	itemsCleaned: number;
	itemsSkipped: number;
	itemsWarned: number;
	isDryRun: boolean;
	cleanedItems: CleanerResultItem[] | null;
	skippedItems: CleanerResultItem[] | null;
	warnedItems: CleanerResultItem[] | null;
	/** Indicates if any JSON fields failed to parse - item details may be incomplete */
	hasDataError?: boolean;
	status: "running" | "completed" | "partial" | "skipped" | "error";
	message: string | null;
	durationMs: number | null;
	startedAt: string;
	completedAt: string | null;
}

/** Data quality indicator for API responses */
export interface DataQuality {
	warning: string;
}

export interface InstanceSummary {
	id: string;
	label: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
}

// ============================================================================
// Frontend-Specific Types: Strike Tracking
// ============================================================================

export interface QueueCleanerStrike {
	id: string;
	instanceId: string;
	downloadId: string; // String for consistency with database schema
	downloadTitle: string;
	strikeCount: number;
	lastRule: string;
	lastReason: string;
	firstStrikeAt: string;
	lastStrikeAt: string;
}

// ============================================================================
// Frontend-Specific Types: Statistics
// ============================================================================
// Note: EnhancedPreviewResult is now imported from @arr/shared to maintain
// a single source of truth for preview-related types.

export interface PeriodStats {
	period: string;
	itemsCleaned: number;
	itemsWarned: number;
	runsCompleted: number;
}

export interface StatisticsTotals {
	itemsCleaned: number;
	itemsSkipped: number;
	itemsWarned: number;
	totalRuns: number;
	completedRuns: number;
	errorRuns: number;
	averageDurationMs: number;
	successRate: number;
}

export interface InstanceBreakdown {
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	itemsCleaned: number;
	totalRuns: number;
	lastRunAt: string | null;
}

export interface RecentActivity {
	id: string;
	instanceName: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	itemsCleaned: number;
	itemsSkipped: number;
	status: string;
	isDryRun: boolean;
	startedAt: string;
}

export interface QueueCleanerStatistics {
	daily: PeriodStats[];
	weekly: PeriodStats[];
	totals: StatisticsTotals;
	ruleBreakdown: Record<string, number>;
	instanceBreakdown: InstanceBreakdown[];
	recentActivity: RecentActivity[];
	/** Indicates if some log entries had corrupted data */
	dataQuality?: DataQuality;
}
