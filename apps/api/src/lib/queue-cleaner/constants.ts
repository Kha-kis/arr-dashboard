/**
 * Queue Cleaner Feature Constants
 *
 * Re-exports shared types and constants from @arr/shared,
 * plus backend-specific keyword arrays for detection logic.
 */

// Re-export all shared types and constants
export {
	// Types
	type CleanerRule,
	type PreviewStatusRule,
	type PreviewRule,
	type ImportBlockCleanupLevel,
	type ImportBlockPatternMode,
	type WhitelistType,
	type WhitelistPattern,
	type CleanerResultItem,
	type StrikeInfo,
	type EnhancedPreviewItem,
	type QueueStateSummary,
	type CleanerResult,
	type EnhancedPreviewResult,
	type PreviewConfigSnapshot,
	// Schemas (for validation)
	cleanerRuleSchema,
	previewStatusRuleSchema,
	previewRuleSchema,
	importBlockCleanupLevelSchema,
	importBlockPatternModeSchema,
	whitelistTypeSchema,
	whitelistPatternSchema,
	cleanerResultItemSchema,
	strikeInfoSchema,
	enhancedPreviewItemSchema,
	queueStateSummarySchema,
	cleanerResultSchema,
	enhancedPreviewResultSchema,
	previewConfigSnapshotSchema,
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
// Backend-Only Constants
// ============================================================================

/** Cooldown between manual cleans of the same instance (2 minutes) */
export const MANUAL_CLEAN_COOLDOWN_MINS = 2;

/** Maximum execution duration for a single clean run (5 minutes) */
export const MAX_CLEAN_DURATION_MS = 5 * 60 * 1000;

/** Scheduler tick interval (60 seconds) */
export const SCHEDULER_TICK_MS = 60 * 1000;

// ============================================================================
// Detection Keyword Arrays (Backend-Only)
// ============================================================================

/** Keywords in statusMessages that indicate a stalled download */
export const STALL_KEYWORDS = [
	"stalled",
	"no seeds",
	"no seeders",
	"not seeding",
	"dead torrent",
	"timed out",
	"timeout",
	"no connections",
	"metadata",
	"queued for checking",
] as const;

/** Keywords in statusMessages/errorMessage that indicate a failed download */
export const FAILURE_KEYWORDS = [
	"failed",
	"failure",
	"import failed",
	"importfailed",
	"error",
	"cannot be imported",
	"could not be imported",
	"not a valid",
	"disk space",
	"permission denied",
	"access denied",
] as const;

/**
 * Import blocked keywords categorized by cleanup safety level.
 *
 * SAFE_TO_CLEAN: Redundant or unwanted downloads - safe to remove automatically
 * NEEDS_REVIEW: User might have intent - warn but don't auto-remove unless aggressive
 * TECHNICAL_ISSUE: Might be fixable - skip unless user explicitly enables
 */

/** Downloads that are redundant or don't match quality requirements - SAFE to auto-clean */
export const IMPORT_BLOCKED_SAFE_KEYWORDS = [
	// Redundant - content already exists
	"already exists",
	"already in library",
	"duplicate",
	// Quality mismatch - doesn't meet user's profile
	"quality not wanted",
	"not wanted in",
	"cutoff already met",
	"not an upgrade",
	// Invalid content - not usable
	"sample only",
	"sample file",
	"no files found",
	"no video files",
	"bad nfo",
] as const;

/** Downloads that might have user intent - WARN but consider cleaning */
export const IMPORT_BLOCKED_REVIEW_KEYWORDS = [
	// User might want to manually choose files
	"manual import",
	"manual interaction",
	// Partial/incomplete - might be intentional
	"missing expected",
	"expected files",
] as const;

/** Technical issues that might be fixable - DON'T auto-clean */
export const IMPORT_BLOCKED_TECHNICAL_KEYWORDS = [
	// Archive issues - might need right tools
	"unpack required",
	"unpacking failed",
	"rar required",
	"password protected",
] as const;

/** Combined list for backward compatibility */
export const IMPORT_BLOCKED_KEYWORDS = [
	...IMPORT_BLOCKED_SAFE_KEYWORDS,
	...IMPORT_BLOCKED_REVIEW_KEYWORDS,
	...IMPORT_BLOCKED_TECHNICAL_KEYWORDS,
] as const;

/** Keywords indicating import is pending but may resolve itself - SKIP these */
export const IMPORT_PENDING_RECOVERABLE_KEYWORDS = [
	"extracting",
	"unpacking",
	"processing",
	"copying",
	"moving",
	"importing",
	"scanning",
] as const;

/** Supported whitelist pattern types */
export const WHITELIST_TYPES = ["tracker", "tag", "category", "title"] as const;

// ============================================================================
// Auto-Import Constants (Backend-Only)
// ============================================================================

/** Minimum number of auto-import attempts before giving up */
export const MIN_AUTO_IMPORT_ATTEMPTS = 1;

/** Maximum number of auto-import attempts before giving up */
export const MAX_AUTO_IMPORT_ATTEMPTS = 5;

/** Default number of auto-import attempts */
export const DEFAULT_AUTO_IMPORT_ATTEMPTS = 2;

/** Minimum cooldown between auto-import attempts on same item (minutes) */
export const MIN_AUTO_IMPORT_COOLDOWN_MINS = 5;

/** Maximum cooldown between auto-import attempts on same item (minutes) */
export const MAX_AUTO_IMPORT_COOLDOWN_MINS = 240;

/** Default cooldown between auto-import attempts (minutes) */
export const DEFAULT_AUTO_IMPORT_COOLDOWN_MINS = 30;

/**
 * Status patterns that are SAFE for auto-import.
 * These patterns indicate the item is ready and likely to import successfully.
 *
 * Common scenarios:
 * - Radarr: "Found matching movie via grab history, but release was matched to movie by ID. Manual Import required."
 * - Sonarr: "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible."
 * - General: Items waiting for user confirmation but file is correctly identified
 */
export const AUTO_IMPORT_SAFE_KEYWORDS = [
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
export const AUTO_IMPORT_NEVER_KEYWORDS = [
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
