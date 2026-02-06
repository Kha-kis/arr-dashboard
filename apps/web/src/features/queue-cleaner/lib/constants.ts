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
	// Constants - Auto-Import
	MIN_AUTO_IMPORT_ATTEMPTS,
	MAX_AUTO_IMPORT_ATTEMPTS,
	DEFAULT_AUTO_IMPORT_ATTEMPTS,
	MIN_AUTO_IMPORT_COOLDOWN_MINS,
	MAX_AUTO_IMPORT_COOLDOWN_MINS,
	DEFAULT_AUTO_IMPORT_COOLDOWN_MINS,
	// Constants - Defaults
	DEFAULT_IMPORT_BLOCK_CLEANUP_LEVEL,
	DEFAULT_IMPORT_BLOCK_PATTERN_MODE,
} from "@arr/shared";

// ============================================================================
// Frontend-Only Constants
// ============================================================================

/**
 * Status patterns that are SAFE for auto-import.
 * These patterns indicate the item is ready and likely to import successfully.
 *
 * Common scenarios:
 * - Radarr: "Found matching movie via grab history, but release was matched to movie by ID"
 * - Sonarr: "Found matching series via grab history, but release was matched to series by ID"
 * - General: Items waiting for user confirmation but file is correctly identified
 */
export const AUTO_IMPORT_SAFE_PATTERNS = [
	// Direct import requests
	"waiting for import",
	"import pending",
	"manual import required",
	"manual import",
	"waiting for manual",
	// ID-matched items (file correctly identified via grab history)
	"matched to series by id",
	"matched to movie by id",
	"matched to artist by id",
	"matched to album by id",
	"matched to book by id",
	// Grab history match (indicates proper tracking)
	"via grab history",
] as const;

/**
 * Status patterns that should NEVER be auto-imported.
 * These will always fail or cause problems if imported.
 */
export const AUTO_IMPORT_NEVER_PATTERNS = [
	// Content doesn't exist or is unusable
	"no video files",
	"no files found",
	"no files",
	"sample only",
	"sample file",
	// Extraction/unpacking issues - can't import until resolved
	"password protected",
	"unpack required",
	"rar required",
	"unpacking failed",
	"extraction failed",
	// Quality rejection - ARR explicitly doesn't want this content
	"quality not wanted",
	"not an upgrade",
	"cutoff already met",
	"not wanted in",
	// Already exists - import would fail anyway
	"already exists",
	"already in library",
	"duplicate",
	// Path issues
	"path does not exist",
	"file not found",
] as const;

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
