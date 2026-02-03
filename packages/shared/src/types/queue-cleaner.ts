import { z } from "zod";

// ============================================================================
// Rule Types
// ============================================================================

/** All possible cleaner rule types that trigger actions */
export const cleanerRuleSchema = z.enum([
	"stalled",
	"failed",
	"slow",
	"error_pattern",
	"seeding_timeout",
	"import_pending",
	"import_blocked",
	"whitelisted",
]);

export type CleanerRule = z.infer<typeof cleanerRuleSchema>;

/** Preview-specific status types (not actionable rules) */
export const previewStatusRuleSchema = z.enum(["healthy", "too_young"]);

export type PreviewStatusRule = z.infer<typeof previewStatusRuleSchema>;

/** All possible rule types in preview results */
export const previewRuleSchema = z.union([cleanerRuleSchema, previewStatusRuleSchema]);

export type PreviewRule = z.infer<typeof previewRuleSchema>;

// ============================================================================
// Configuration Types
// ============================================================================

/** Import block cleanup aggressiveness levels */
export const importBlockCleanupLevelSchema = z.enum(["safe", "moderate", "aggressive"]);

export type ImportBlockCleanupLevel = z.infer<typeof importBlockCleanupLevelSchema>;

/** Import block pattern matching modes */
export const importBlockPatternModeSchema = z.enum(["defaults", "include", "exclude"]);

export type ImportBlockPatternMode = z.infer<typeof importBlockPatternModeSchema>;

/** Whitelist pattern types */
export const whitelistTypeSchema = z.enum(["tracker", "tag", "category", "title"]);

export type WhitelistType = z.infer<typeof whitelistTypeSchema>;

/** Whitelist pattern structure */
export const whitelistPatternSchema = z.object({
	type: whitelistTypeSchema,
	pattern: z.string().min(1),
});

export type WhitelistPattern = z.infer<typeof whitelistPatternSchema>;

// ============================================================================
// Result Types
// ============================================================================

/** Result item representing a queue item that was (or would be) cleaned/skipped/warned */
export const cleanerResultItemSchema = z.object({
	id: z.number(),
	title: z.string(),
	reason: z.string(),
	rule: cleanerRuleSchema,
	strikeCount: z.number().optional(),
	maxStrikes: z.number().optional(),
});

export type CleanerResultItem = z.infer<typeof cleanerResultItemSchema>;

/** Strike info for items being warned */
export const strikeInfoSchema = z.object({
	currentStrikes: z.number(),
	maxStrikes: z.number(),
	wouldTriggerRemoval: z.boolean(),
});

export type StrikeInfo = z.infer<typeof strikeInfoSchema>;

/** Enhanced preview item with detailed context for the preview modal */
export const enhancedPreviewItemSchema = z.object({
	id: z.number(),
	title: z.string(),
	action: z.enum(["remove", "warn", "skip", "whitelist"]),
	rule: previewRuleSchema,
	reason: z.string(),
	detailedReason: z.string(),
	queueAge: z.number(),
	size: z.number().optional(),
	sizeleft: z.number().optional(),
	progress: z.number().min(0).max(100).optional(),
	protocol: z.string().optional(),
	indexer: z.string().optional(),
	downloadClient: z.string().optional(),
	status: z.string().optional(),
	downloadId: z.string().optional(),
	strikeInfo: strikeInfoSchema.optional(),
});

export type EnhancedPreviewItem = z.infer<typeof enhancedPreviewItemSchema>;

/** Queue state summary for the preview modal */
export const queueStateSummarySchema = z.object({
	totalItems: z.number(),
	downloading: z.number(),
	paused: z.number(),
	queued: z.number(),
	seeding: z.number(),
	importPending: z.number(),
	failed: z.number(),
});

export type QueueStateSummary = z.infer<typeof queueStateSummarySchema>;

/** Cleaner execution result */
export const cleanerResultSchema = z.object({
	itemsCleaned: z.number(),
	itemsSkipped: z.number(),
	itemsWarned: z.number(),
	cleanedItems: z.array(cleanerResultItemSchema),
	skippedItems: z.array(cleanerResultItemSchema),
	warnedItems: z.array(cleanerResultItemSchema),
	isDryRun: z.boolean(),
	status: z.enum(["completed", "partial", "skipped", "error"]),
	message: z.string(),
});

export type CleanerResult = z.infer<typeof cleanerResultSchema>;

/** Config snapshot included in preview results */
export const previewConfigSnapshotSchema = z.object({
	dryRunMode: z.boolean(),
	strikeSystemEnabled: z.boolean(),
	maxStrikes: z.number(),
	maxRemovalsPerRun: z.number(),
});

export type PreviewConfigSnapshot = z.infer<typeof previewConfigSnapshotSchema>;

/** Enhanced dry-run preview result returned by the preview endpoint */
export const enhancedPreviewResultSchema = z.object({
	// Instance metadata
	instanceId: z.string(),
	instanceLabel: z.string(),
	instanceService: z.enum(["sonarr", "radarr"]),
	instanceReachable: z.boolean(),
	/** Error message when instance is unreachable (for user diagnostics) */
	errorMessage: z.string().optional(),
	// Queue state
	queueSummary: queueStateSummarySchema,
	// Preview counts
	wouldRemove: z.number(),
	wouldWarn: z.number(),
	wouldSkip: z.number(),
	// Enhanced items with detailed reasoning
	previewItems: z.array(enhancedPreviewItemSchema),
	// Rule breakdown
	ruleSummary: z.record(z.string(), z.number()),
	// Timestamps
	previewGeneratedAt: z.string(),
	// Config snapshot for context
	configSnapshot: previewConfigSnapshotSchema,
});

export type EnhancedPreviewResult = z.infer<typeof enhancedPreviewResultSchema>;

// ============================================================================
// Constants
// ============================================================================

// Check interval limits (in minutes)
export const MIN_INTERVAL_MINS = 5;
export const MAX_INTERVAL_MINS = 1440;
export const DEFAULT_INTERVAL_MINS = 30;

// Stalled threshold limits (in minutes)
export const MIN_STALLED_THRESHOLD_MINS = 10;
export const MAX_STALLED_THRESHOLD_MINS = 1440;
export const DEFAULT_STALLED_THRESHOLD_MINS = 60;

// Slow download limits
export const MIN_SLOW_SPEED_THRESHOLD = 10;
export const MAX_SLOW_SPEED_THRESHOLD = 10000;
export const DEFAULT_SLOW_SPEED_THRESHOLD = 100;

export const MIN_SLOW_GRACE_PERIOD_MINS = 5;
export const MAX_SLOW_GRACE_PERIOD_MINS = 1440;
export const DEFAULT_SLOW_GRACE_PERIOD_MINS = 30;

// Safety limits
export const MIN_MAX_REMOVALS = 1;
export const MAX_MAX_REMOVALS = 100;
export const DEFAULT_MAX_REMOVALS = 10;

export const MIN_QUEUE_AGE_MINS = 1;
export const MAX_QUEUE_AGE_MINS = 60;
export const DEFAULT_QUEUE_AGE_MINS = 5;

// Strike system limits
export const MIN_MAX_STRIKES = 2;
export const MAX_MAX_STRIKES = 10;
export const DEFAULT_MAX_STRIKES = 3;

export const MIN_STRIKE_DECAY_HOURS = 1;
export const MAX_STRIKE_DECAY_HOURS = 168; // 7 days
export const DEFAULT_STRIKE_DECAY_HOURS = 24;

// Seeding timeout limits
export const MIN_SEEDING_TIMEOUT_HOURS = 1;
export const MAX_SEEDING_TIMEOUT_HOURS = 720; // 30 days
export const DEFAULT_SEEDING_TIMEOUT_HOURS = 72; // 3 days

// Estimated completion limits
export const MIN_ESTIMATED_MULTIPLIER = 1.5;
export const MAX_ESTIMATED_MULTIPLIER = 10;
export const DEFAULT_ESTIMATED_MULTIPLIER = 2.0;

// Import pending limits
export const MIN_IMPORT_PENDING_MINS = 5;
export const MAX_IMPORT_PENDING_MINS = 1440; // 24 hours
export const DEFAULT_IMPORT_PENDING_MINS = 60;

// Import block cleanup defaults
export const DEFAULT_IMPORT_BLOCK_CLEANUP_LEVEL: ImportBlockCleanupLevel = "safe";
export const DEFAULT_IMPORT_BLOCK_PATTERN_MODE: ImportBlockPatternMode = "defaults";
