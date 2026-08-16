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
import { type RuleDocument, ruleDocumentSchema } from "../rules/grammar.js";
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

export const cleanupTargetScopeSchema = z.enum(["series", "episode"]);
export type CleanupTargetScope = z.infer<typeof cleanupTargetScopeSchema>;

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
	targetScope: cleanupTargetScopeSchema.optional().default("series"),
	action: cleanupActionSchema.optional().default("delete"),
	scanMediaServerAfterDelete: z.boolean().optional().default(false),
	scanMediaServerInstanceIds: z
		.array(z.string().trim().min(1).max(128))
		.max(50)
		.optional()
		.default([]),
	operator: compositeOperatorSchema.nullable().optional(),
	conditions: z.array(conditionSchema).nullable().optional(),
	/** Recursive v1 criteria, persisted in the existing conditions column. */
	expression: ruleDocumentSchema.nullable().optional(),
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

interface CleanupRuleScopeInput {
	targetScope?: CleanupTargetScope | null;
	serviceFilter?: string[] | null;
	plexLibraryFilter?: string[] | null;
	retentionMode?: boolean | null;
	ruleType?: RuleType | string | null;
	parameters?: Record<string, unknown> | null;
	operator?: CompositeOperator | string | null;
	conditions?: readonly unknown[] | null;
	expression?: RuleDocument | null;
}

interface CleanupMediaServerScanInput {
	action?: CleanupAction | string | null;
	retentionMode?: boolean | null;
	scanMediaServerAfterDelete?: boolean | null;
	scanMediaServerInstanceIds?: readonly string[] | null;
}

export function getCleanupMediaServerScanValidationError(
	rule: CleanupMediaServerScanInput,
): string | null {
	const instanceIds = rule.scanMediaServerInstanceIds ?? [];
	if (rule.scanMediaServerAfterDelete !== true) {
		return instanceIds.length > 0
			? "Media-server instance selection must be empty when post-delete scanning is disabled"
			: null;
	}
	if (rule.retentionMode === true) {
		return "Media-server scans cannot be enabled on retention rules";
	}
	if (rule.action !== "delete" && rule.action !== "delete_files") {
		return "Media-server scans require a delete or delete-files action";
	}
	if (instanceIds.length === 0) {
		return "Media-server scans require at least one media-server instance";
	}
	if (new Set(instanceIds).size !== instanceIds.length) {
		return "Media-server instance selection cannot contain duplicates";
	}
	return null;
}

/**
 * Episode cleanup deliberately starts with the one rule shape for which a
 * positive per-episode Plex witness can be evaluated without inferring
 * unwatched or absent state from an incomplete cache.
 */
export function getCleanupRuleScopeValidationError(rule: CleanupRuleScopeInput): string | null {
	if ((rule.targetScope ?? "series") !== "episode") return null;

	if (rule.serviceFilter?.length !== 1 || rule.serviceFilter[0]?.toUpperCase() !== "SONARR") {
		return "Episode-scoped cleanup rules must target Sonarr only";
	}
	if (rule.retentionMode === true) {
		return "Episode-scoped cleanup rules cannot use retention mode";
	}
	if ((rule.plexLibraryFilter?.length ?? 0) > 0) {
		return "Episode-scoped cleanup rules cannot use a Plex library filter";
	}
	if (
		rule.ruleType === "composite" ||
		rule.operator != null ||
		(rule.conditions?.length ?? 0) > 0 ||
		rule.expression != null
	) {
		return "Episode-scoped cleanup rules cannot be composite";
	}
	if (rule.ruleType !== "plex_watch_count") {
		return "Episode-scoped cleanup rules must use Plex watch count";
	}
	if (rule.parameters?.operator !== "greater_than") {
		return "Episode-scoped Plex watch count rules must use greater than";
	}

	return null;
}

function validateCleanupExpression(
	data: {
		ruleType?: RuleType;
		operator?: CompositeOperator | null;
		conditions?: Condition[] | null;
		expression?: RuleDocument | null;
	},
	ctx: z.RefinementCtx,
	requireCompositeRuleType: boolean,
): void {
	if (data.expression == null) return;
	if (data.ruleType !== "composite" && (requireCompositeRuleType || data.ruleType !== undefined)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Recursive cleanup expressions must use ruleType composite",
			path: ["ruleType"],
		});
	}
	if (data.operator != null) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Cleanup rules cannot mix expression with operator",
			path: ["operator"],
		});
	}
	if (data.conditions != null) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Cleanup rules cannot mix expression with conditions",
			path: ["conditions"],
		});
	}
}

export const createCleanupRuleSchema = baseCleanupRuleSchema.superRefine((data, ctx) => {
	validateCleanupExpression(data, ctx, true);
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
	const scopeError = getCleanupRuleScopeValidationError(data);
	if (scopeError) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: scopeError,
			path: ["targetScope"],
		});
	}
	const scanError = getCleanupMediaServerScanValidationError(data);
	if (scanError) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: scanError,
			path: ["scanMediaServerAfterDelete"],
		});
	}
});

export const updateCleanupRuleSchema = baseCleanupRuleSchema
	.partial()
	// Zod 4 preserves inner defaults through `partial()`. A PATCH/PUT body
	// that omits targetScope must not silently rewrite an existing episode
	// rule back to series scope.
	.extend({
		targetScope: cleanupTargetScopeSchema.optional(),
		action: cleanupActionSchema.optional(),
		retentionMode: z.boolean().optional(),
		scanMediaServerAfterDelete: z.boolean().optional(),
		scanMediaServerInstanceIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
	})
	.superRefine((data, ctx) => {
		validateCleanupExpression(data, ctx, false);
		if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Composite rules must have at least one condition",
				path: ["conditions"],
			});
		}
		if (
			data.scanMediaServerAfterDelete !== undefined &&
			data.scanMediaServerInstanceIds !== undefined
		) {
			const scanError = getCleanupMediaServerScanValidationError(data);
			if (scanError) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: scanError,
					path: ["scanMediaServerAfterDelete"],
				});
			}
		}
		if (data.targetScope === "episode" && data.expression != null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Episode-scoped cleanup rules cannot be composite",
				path: ["targetScope"],
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
	targetScope: CleanupTargetScope;
	action: string;
	scanMediaServerAfterDelete: boolean;
	scanMediaServerInstanceIds: string[];
	operator: CompositeOperator | null;
	conditions: Condition[] | null;
	expression: RuleDocument | null;
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
	targetScope: CleanupTargetScope;
	arrEpisodeId: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	/** Structured series title. `title` remains the series title for compatibility. */
	seriesTitle?: string | null;
	episodeTitle?: string | null;
	title: string;
	matchedRuleId: string;
	matchedRuleName: string;
	reason: string;
	action: string;
	scanMediaServerAfterDelete: boolean;
	scanMediaServerInstanceIds: string[];
	mediaServerScans: CleanupMediaServerScanResponse[];
	sizeOnDisk: string; // BigInt serialized as string
	year: number | null;
	rating: number | null;
	status: string;
	lastExecutionError: string | null;
	reviewedAt: string | null;
	executedAt: string | null;
	createdAt: string;
	expiresAt: string;
}

export type CleanupMediaServerScanStatus =
	| "pending"
	| "triggering"
	| "triggered"
	| "skipped"
	| "failed"
	| "ambiguous";

export interface CleanupMediaServerScanResponse {
	id: string;
	instanceId: string;
	instanceLabel: string | null;
	service: "PLEX" | "JELLYFIN" | "EMBY";
	status: CleanupMediaServerScanStatus;
	attemptCount: number;
	plannedSectionCount: number | null;
	completedSectionCount: number;
	lastError: string | null;
	nextAttemptAt: string | null;
	triggeredAt: string | null;
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

export interface CleanupAuditEventResponse {
	id: string;
	actionId: string;
	correlationId: string;
	sequence: number;
	eventType: string;
	outcome: "info" | "success" | "blocked" | "failed";
	trigger: "scheduled" | "manual" | "approval" | "retry" | "recovery";
	actorType: "operator" | "scheduler" | "system";
	actorId: string | null;
	approvalId: string | null;
	runLogId: string | null;
	reason: string;
	evidence: Record<string, unknown> | null;
	details: Record<string, unknown> | null;
	createdAt: string;
}

export interface CleanupAuditTimelineResponse {
	actionId: string;
	instanceId: string;
	arrItemId: number;
	itemType: string;
	targetScope: "series" | "episode";
	arrEpisodeId: number | null;
	title: string;
	ruleId: string | null;
	ruleName: string | null;
	action: string;
	trigger: CleanupAuditEventResponse["trigger"];
	latestOutcome: CleanupAuditEventResponse["outcome"];
	actionableReason: string;
	startedAt: string;
	updatedAt: string;
	eventCount: number;
	eventsTruncated: boolean;
	olderEventsCursor: string | null;
	events: CleanupAuditEventResponse[];
}

export interface PaginatedCleanupAuditTimelines {
	items: CleanupAuditTimelineResponse[];
	total: number;
	page: number;
	pageSize: number;
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
	mediaServerInstances: Array<{
		id: string;
		label: string;
		service: "PLEX" | "JELLYFIN" | "EMBY";
	}>;
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

export interface CleanupProviderEvidenceSource {
	service: "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";
	identityKind: string;
	identityFingerprint: string;
	connectionGeneration: number;
	identityGeneration: number;
	cacheType: string;
	completedAt: string;
	itemCount: number;
	verifiedAt: string;
	statusFingerprint: string;
	rowFingerprint: string;
	fingerprint: string;
}

/** Sanitized, deterministic provider authority attached to cleanup decisions. */
export interface CleanupProviderEvidence {
	version: 1;
	dependencies: string[];
	fingerprint: string;
	sources: CleanupProviderEvidenceSource[];
}

export interface CleanupPreviewItem {
	instanceId: string;
	instanceLabel: string | null;
	arrItemId: number;
	itemType: string;
	targetScope?: CleanupTargetScope;
	arrEpisodeId?: number | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	/** Structured series title. `title` remains the series title for compatibility. */
	seriesTitle?: string | null;
	episodeTitle?: string | null;
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
	/** Null means durable retry storage was unavailable and the count is unknown. */
	pendingRetryCount?: number | null;
	/** True only when durable retry ownership and all selection counts are trustworthy. */
	selectionCountsComplete: boolean;
	items: CleanupPreviewItem[];
	selection?: {
		selectedFresh: number;
		selectedRetries: number;
		deferredBudget: number;
		deferredApproval: number;
		deferredRetryFairness: number;
		deferredInFlightTarget: number;
		deferredDuplicateTarget: number;
		inFlight: number;
		blocked: number;
		retryStateUnavailable: number;
		retryState: "complete" | "unavailable";
		total: number;
	};
	display?: { shown: number; hidden: number; limit: number; complete: boolean };
	prefetchHealth?: PrefetchHealthStatus;
	warnings?: string[];
	providerEvidence?: CleanupProviderEvidence;
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
	arrEpisodeId?: number;
}

export const cleanupExplainRequestSchema = z.object({
	instanceId: z.string().min(1),
	arrItemId: z.number().int().min(1),
	arrEpisodeId: z.number().int().min(1).optional(),
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
		| "scope_filter"
		| "evidence_unavailable"
		| "unsupported_rule"
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
		targetScope?: "series" | "episode";
		arrEpisodeId?: number;
		seasonNumber?: number;
		episodeNumber?: number;
		episodeTitle?: string | null;
	};
	results: CleanupExplainResult[];
	retentionProtected: boolean;
	providerEvidence?: CleanupProviderEvidence;
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
