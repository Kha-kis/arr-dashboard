/**
 * Queue Cleaner Feature Constants (Frontend)
 *
 * Re-exports shared constants from @arr/shared plus
 * frontend-specific constants for UI configuration.
 */

// Re-export all shared constants and types
export {
	// Types
	type CleanerRule,
	type PreviewStatusRule,
	type PreviewRule,
	type ImportBlockCleanupLevel,
	type ImportBlockPatternMode,
	type WhitelistType,
	type WhitelistPattern,
	// Schemas (for validation if needed)
	cleanerRuleSchema,
	previewStatusRuleSchema,
	previewRuleSchema,
	importBlockCleanupLevelSchema,
	importBlockPatternModeSchema,
	whitelistTypeSchema,
	whitelistPatternSchema,
	// Constants - Intervals
	MIN_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	DEFAULT_INTERVAL_MINS,
	// Constants - Stalled
	MIN_STALLED_THRESHOLD_MINS,
	MAX_STALLED_THRESHOLD_MINS,
	DEFAULT_STALLED_THRESHOLD_MINS,
	// Constants - Slow
	MIN_SLOW_SPEED_THRESHOLD,
	MAX_SLOW_SPEED_THRESHOLD,
	DEFAULT_SLOW_SPEED_THRESHOLD,
	MIN_SLOW_GRACE_PERIOD_MINS,
	MAX_SLOW_GRACE_PERIOD_MINS,
	DEFAULT_SLOW_GRACE_PERIOD_MINS,
	// Constants - Safety
	MIN_MAX_REMOVALS,
	MAX_MAX_REMOVALS,
	DEFAULT_MAX_REMOVALS,
	MIN_QUEUE_AGE_MINS,
	MAX_QUEUE_AGE_MINS,
	DEFAULT_QUEUE_AGE_MINS,
	// Constants - Strikes
	MIN_MAX_STRIKES,
	MAX_MAX_STRIKES,
	DEFAULT_MAX_STRIKES,
	MIN_STRIKE_DECAY_HOURS,
	MAX_STRIKE_DECAY_HOURS,
	DEFAULT_STRIKE_DECAY_HOURS,
	// Constants - Seeding
	MIN_SEEDING_TIMEOUT_HOURS,
	MAX_SEEDING_TIMEOUT_HOURS,
	DEFAULT_SEEDING_TIMEOUT_HOURS,
	// Constants - Estimated
	MIN_ESTIMATED_MULTIPLIER,
	MAX_ESTIMATED_MULTIPLIER,
	DEFAULT_ESTIMATED_MULTIPLIER,
	// Constants - Import Pending
	MIN_IMPORT_PENDING_MINS,
	MAX_IMPORT_PENDING_MINS,
	DEFAULT_IMPORT_PENDING_MINS,
	// Constants - Defaults
	DEFAULT_IMPORT_BLOCK_CLEANUP_LEVEL,
	DEFAULT_IMPORT_BLOCK_PATTERN_MODE,
} from "@arr/shared";

// ============================================================================
// Frontend-Only Constants
// ============================================================================

/**
 * Whitelist types with UI labels for dropdowns/selects
 */
export const WHITELIST_TYPES = [
	{ value: "tracker" as const, label: "Tracker/Indexer" },
	{ value: "tag" as const, label: "Tag" },
	{ value: "category" as const, label: "Category" },
	{ value: "title" as const, label: "Title" },
];

// === REFRESH INTERVALS ===

/** Status refresh interval (30 seconds) */
export const STATUS_REFRESH_INTERVAL = 30000;

/** Logs refresh interval (60 seconds) */
export const LOGS_REFRESH_INTERVAL = 60000;

/** Logs refresh interval when runs are active (5 seconds) */
export const LOGS_ACTIVE_REFRESH_INTERVAL = 5000;
