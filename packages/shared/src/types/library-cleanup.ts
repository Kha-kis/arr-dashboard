/**
 * Library Cleanup — feature-specific types.
 *
 * Generic rule-criteria types (per-rule-type Zod params, the `RuleType`
 * union, condition shape, composite operator, validation maps) live in
 * `./rule-criteria.ts` and are re-exported through the shared barrel.
 * This file owns only the cleanup-specific glue: action enum, the
 * cleanup-rule write/update schemas (which wrap the generic criteria
 * with cleanup-specific filter + execution fields), and the response
 * shapes for the cleanup API surface.
 */

import { z } from "zod";
import { getRegexSafetyError, REGEX_MAX_LENGTH } from "./regex-safety.js";
import {
	type CompositeOperator,
	type Condition,
	compositeOperatorSchema,
	conditionSchema,
	type RuleType,
	ruleTypeSchema,
} from "./rule-criteria.js";

// ============================================================================
// Legacy name aliases (transitional — prefer RuleType / ruleTypeSchema in
// new code). Kept to preserve the existing public surface across the
// codebase while consumers migrate to the generic names.
// ============================================================================

export const cleanupRuleTypeSchema = ruleTypeSchema;
export type CleanupRuleType = RuleType;

// ============================================================================
// Cleanup-specific Action Enum
// ============================================================================

export const cleanupActionSchema = z.enum(["delete", "unmonitor", "delete_files"]);
export type CleanupAction = z.infer<typeof cleanupActionSchema>;

// ============================================================================
// Cleanup Rule Schema — generic criteria + cleanup-specific filters/action
// ============================================================================

const baseCleanupRuleSchema = z.object({
	name: z.string().min(1).max(100),
	enabled: z.boolean().optional().default(true),
	priority: z.number().int().optional().default(0),
	ruleType: ruleTypeSchema,
	parameters: z.record(z.string(), z.unknown()), // Validated per-type at runtime
	serviceFilter: z.array(z.string()).nullable().optional(),
	instanceFilter: z.array(z.string()).nullable().optional(),
	excludeTags: z.array(z.number()).nullable().optional(),
	excludeTitles: z
		.array(
			z
				.string()
				.max(REGEX_MAX_LENGTH)
				.refine((p) => getRegexSafetyError(p) === null, {
					message: "Invalid or unsafe regular expression pattern",
				}),
		)
		.nullable()
		.optional(),
	plexLibraryFilter: z.array(z.string()).nullable().optional(),
	action: cleanupActionSchema.optional().default("delete"),
	operator: compositeOperatorSchema.nullable().optional(),
	conditions: z.array(conditionSchema).nullable().optional(),
	retentionMode: z.boolean().optional().default(false),
	/**
	 * When true, this rule inherits the config-level `rejectionMemoryDays`.
	 * When false, the rule's own `rejectionMemoryDays` field below is used.
	 * Default true preserves inherit-from-global behavior for new rules.
	 */
	useGlobalRejectionMemory: z.boolean().optional().default(true),
	/**
	 * Per-rule override for rejection-memory (issue #474). Only consulted
	 * when `useGlobalRejectionMemory` is false. Semantics:
	 *   0     = off  (no memory)
	 *   N > 0 = remember rejection for N days
	 *   null  = remember forever (until manually cleared)
	 */
	rejectionMemoryDays: z.number().int().min(0).max(36500).nullable().optional(),
});

export const createCleanupRuleSchema = baseCleanupRuleSchema.superRefine((data, ctx) => {
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
});

export const updateCleanupRuleSchema = baseCleanupRuleSchema.partial().superRefine((data, ctx) => {
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
});

export const reorderRulesSchema = z.object({
	ruleIds: z.array(z.string().min(1)).min(1),
});

export const updateCleanupConfigSchema = z.object({
	enabled: z.boolean().optional(),
	intervalHours: z.number().int().min(1).max(168).optional(), // 1h to 1 week
	dryRunMode: z.boolean().optional(),
	maxRemovalsPerRun: z.number().int().min(1).max(100).optional(),
	requireApproval: z.boolean().optional(),
	/**
	 * Phase 2.2: when true, cleanup proposals exclude items currently seeding
	 * via qui (LibraryCache.torrentState IN ['seeding', 'downloading']).
	 * Default false for backward compatibility — operators with qui can opt in
	 * to honor seeding obligations. No-op when no qui instance is configured.
	 */
	respectQuiSeeding: z.boolean().optional(),
	/**
	 * Issue #474: Global default for how long a rejected cleanup proposal
	 * suppresses re-proposal of the same item. Per-rule overrides on
	 * `LibraryCleanupRule` take precedence when set. Semantics:
	 *   0     = off  (no memory; rejected items get re-proposed next run — pre-#474 behavior)
	 *   N > 0 = remember rejection for N days, then item can be re-proposed
	 *   null  = remember forever (never re-propose unless cleared)
	 */
	rejectionMemoryDays: z.number().int().min(0).max(36500).nullable().optional(),
});

export type CreateCleanupRule = z.infer<typeof createCleanupRuleSchema>;
export type UpdateCleanupRule = z.infer<typeof updateCleanupRuleSchema>;
export type UpdateCleanupConfig = z.infer<typeof updateCleanupConfigSchema>;

// ============================================================================
// Approval Queue Types
// ============================================================================

export const approvalActionSchema = z.enum(["approved", "rejected"]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const BULK_APPROVAL_MAX_IDS = 100;

export const bulkApprovalSchema = z.object({
	ids: z.array(z.string()).min(1).max(BULK_APPROVAL_MAX_IDS),
	action: approvalActionSchema,
});

export type BulkApproval = z.infer<typeof bulkApprovalSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface CleanupRuleResponse {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	ruleType: RuleType;
	parameters: Record<string, unknown>;
	serviceFilter: string[] | null;
	instanceFilter: string[] | null;
	excludeTags: number[] | null;
	excludeTitles: string[] | null;
	plexLibraryFilter: string[] | null;
	action: string;
	operator: CompositeOperator | null;
	conditions: Condition[] | null;
	retentionMode: boolean;
	/** Issue #474: when true, rule inherits config's rejectionMemoryDays. */
	useGlobalRejectionMemory: boolean;
	/** Issue #474: per-rule override; 0 = off, N>0 = days, null = forever. */
	rejectionMemoryDays: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface CleanupConfigResponse {
	id: string;
	enabled: boolean;
	intervalHours: number;
	lastRunAt: string | null;
	nextRunAt: string | null;
	dryRunMode: boolean;
	maxRemovalsPerRun: number;
	requireApproval: boolean;
	respectQuiSeeding: boolean;
	/** Issue #474: global default for rejection-memory; 0 = off, N>0 = days, null = forever. */
	rejectionMemoryDays: number | null;
	rules: CleanupRuleResponse[];
}

export interface CleanupApprovalResponse {
	id: string;
	instanceId: string;
	instanceLabel: string | null;
	arrItemId: number;
	itemType: string;
	title: string;
	matchedRuleId: string;
	matchedRuleName: string;
	reason: string;
	action: string;
	sizeOnDisk: string; // BigInt serialized as string
	year: number | null;
	rating: number | null;
	status: string;
	reviewedAt: string | null;
	executedAt: string | null;
	createdAt: string;
	expiresAt: string;
}

export interface CleanupLogResponse {
	id: string;
	isDryRun: boolean;
	status: string;
	itemsEvaluated: number;
	itemsFlagged: number;
	itemsRemoved: number;
	itemsUnmonitored: number;
	itemsFilesDeleted: number;
	itemsSkipped: number;
	details: Array<Record<string, unknown>> | null;
	error: string | null;
	durationMs: number | null;
	startedAt: string;
	completedAt: string | null;
}

/** Distinct field values extracted from the user's library cache */
export interface CleanupFieldOptionsResponse {
	videoCodecs: string[];
	audioCodecs: string[];
	resolutions: string[];
	hdrTypes: string[];
	releaseGroups: string[];
	plexUsers: string[];
	plexLibraries: string[];
	plexCollections: string[];
	plexLabels: string[];
	jellyfinUsers: string[];
	jellyfinLibraries: string[];
	arrTags: Array<{ id: number; label: string }>;
	hasPlex: boolean;
	hasJellyfin: boolean;
}

/** Preview result: items that would be flagged by current rules */
/**
 * qui-derived deletion-safety hint (Phase 3.3). Surfaces in the cleanup
 * preview so operators can see "qui says this is safe to delete" alongside
 * arr-dashboard's own staleness reasons. Three states:
 *  - `seeding`         — torrent is currently uploading; deletion will
 *                        break the seed. Highest "do not delete" weight.
 *  - `paused_or_error` — torrent state is paused/errored; deletion ends
 *                        an already-stopped session. Lower priority signal.
 *  - `not_in_qui`      — qui has no torrent matching this item's infoHash
 *                        (user removed it from qBit, or it never existed).
 *                        HIGHEST-trust "safe to delete" signal: the file
 *                        on disk is not tracked by any active torrent.
 *  - `no_signal`       — no infoHash backfilled for this item yet, or
 *                        no qui configured. Render nothing.
 */
export type CleanupQuiStatus = "seeding" | "paused_or_error" | "not_in_qui" | "no_signal";

export interface CleanupPreviewItem {
	instanceId: string;
	instanceLabel: string | null;
	arrItemId: number;
	itemType: string;
	title: string;
	matchedRuleName: string;
	reason: string;
	action: string;
	sizeOnDisk: string;
	year: number | null;
	rating: number | null;
	/** qui-derived safety hint (Phase 3.3). See CleanupQuiStatus comment. */
	quiStatus: CleanupQuiStatus;
}

export interface CleanupPreviewResponse {
	totalEvaluated: number;
	totalFlagged: number;
	items: CleanupPreviewItem[];
	prefetchHealth?: PrefetchHealthStatus;
	warnings?: string[];
}

// ============================================================================
// Health & Observability Types
// ============================================================================

export type PrefetchSourceStatus = "ok" | "failed" | "skipped";

export interface PrefetchHealthStatus {
	seerr: PrefetchSourceStatus;
	plex: PrefetchSourceStatus;
	jellyfin: PrefetchSourceStatus;
}

export interface CleanupStatusResponse {
	lastRunAt: string | null;
	lastResult: "completed" | "partial" | "error" | null;
	lastErrorMessage: string | null;
	prefetchHealth: PrefetchHealthStatus | null;
	nextRunAt: string | null;
	enabled: boolean;
	pendingApprovals: number;
}

// ============================================================================
// Explain Types
// ============================================================================

export interface CleanupExplainRequest {
	instanceId: string;
	arrItemId: number;
}

export const cleanupExplainRequestSchema = z.object({
	instanceId: z.string().min(1),
	arrItemId: z.number().int().min(1),
});

export interface CleanupExplainResult {
	ruleId: string;
	ruleName: string;
	matched: boolean;
	reason: string | null;
	filteredBy:
		| "service_filter"
		| "instance_filter"
		| "tag_exclusion"
		| "title_exclusion"
		| "disabled"
		| null;
	retentionMode: boolean;
}

export interface CleanupExplainResponse {
	item: {
		title: string;
		year: number | null;
		instanceId: string;
		itemType: string;
	};
	results: CleanupExplainResult[];
	retentionProtected: boolean;
}

// ============================================================================
// Statistics Types
// ============================================================================

export interface CleanupStatisticsResponse {
	period: { since: string; until: string };
	totalRuns: number;
	successfulRuns: number;
	partialRuns: number;
	failedRuns: number;
	totalItemsEvaluated: number;
	totalItemsFlagged: number;
	totalItemsRemoved: number;
	totalItemsUnmonitored: number;
	totalFilesDeleted: number;
	ruleEffectiveness: Array<{
		ruleId: string;
		ruleName: string;
		matchCount: number;
	}>;
	approvalFunnel: {
		pending: number;
		approved: number;
		rejected: number;
		expired: number;
	};
}
