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
import type { PlexEvidenceSummary } from "./plex.js";
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

export const CLEANUP_RULE_EXPRESSION_VERSION = 1 as const;
export const CLEANUP_RULE_EXPRESSION_MAX_DEPTH = 8;
export const CLEANUP_RULE_EXPRESSION_MAX_NODES = 100;

export interface CleanupRuleConditionExpression {
	type: "condition";
	ruleType: Exclude<RuleType, "composite">;
	parameters: Record<string, unknown>;
}

export interface CleanupRuleGroupExpression {
	type: "group";
	operator: CompositeOperator;
	children: CleanupRuleExpression[];
}

export interface CleanupRuleNotExpression {
	type: "not";
	child: CleanupRuleExpression;
}

export type CleanupRuleExpression =
	| CleanupRuleConditionExpression
	| CleanupRuleGroupExpression
	| CleanupRuleNotExpression;

export interface VersionedCleanupRuleExpression {
	version: typeof CLEANUP_RULE_EXPRESSION_VERSION;
	root: CleanupRuleExpression;
}

interface ExpressionValidationFailure {
	path: PropertyKey[];
	message: string;
}

/**
 * Iterative validation rejects cyclic programmatic inputs and over-deep JSON
 * deterministically instead of risking a recursive parser stack overflow.
 */
function getExpressionValidationFailure(value: unknown): ExpressionValidationFailure | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { path: [], message: "Expression must be an object" };
	}
	const envelope = value as Record<string, unknown>;
	if (envelope.version !== CLEANUP_RULE_EXPRESSION_VERSION) {
		return {
			path: ["version"],
			message: `Unsupported cleanup rule expression version (expected ${CLEANUP_RULE_EXPRESSION_VERSION})`,
		};
	}
	const envelopeExtra = Object.keys(envelope).find((key) => key !== "version" && key !== "root");
	if (envelopeExtra) {
		return { path: [envelopeExtra], message: `Unexpected expression field "${envelopeExtra}"` };
	}

	const stack: Array<{
		node: unknown;
		path: PropertyKey[];
		depth: number;
		exiting?: boolean;
	}> = [{ node: envelope.root, path: ["root"], depth: 1 }];
	const activePath = new WeakSet<object>();
	let nodeCount = 0;
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current.exiting) {
			if (typeof current.node === "object" && current.node !== null) {
				activePath.delete(current.node);
			}
			continue;
		}
		if (current.depth > CLEANUP_RULE_EXPRESSION_MAX_DEPTH) {
			return {
				path: current.path,
				message: `Expression exceeds maximum depth of ${CLEANUP_RULE_EXPRESSION_MAX_DEPTH}`,
			};
		}
		if (typeof current.node !== "object" || current.node === null || Array.isArray(current.node)) {
			return { path: current.path, message: "Expression node must be an object" };
		}
		if (activePath.has(current.node)) {
			return { path: current.path, message: "Expression cannot contain a cycle" };
		}
		activePath.add(current.node);
		stack.push({ ...current, exiting: true });
		nodeCount++;
		if (nodeCount > CLEANUP_RULE_EXPRESSION_MAX_NODES) {
			return {
				path: current.path,
				message: `Expression exceeds maximum node count of ${CLEANUP_RULE_EXPRESSION_MAX_NODES}`,
			};
		}

		const node = current.node as Record<string, unknown>;
		if (node.type === "condition") {
			const extra = Object.keys(node).find(
				(key) => key !== "type" && key !== "ruleType" && key !== "parameters",
			);
			if (extra) {
				return {
					path: [...current.path, extra],
					message: `Unexpected condition field "${extra}"`,
				};
			}
			if (!ruleTypeSchema.exclude(["composite"]).safeParse(node.ruleType).success) {
				return { path: [...current.path, "ruleType"], message: "Invalid condition rule type" };
			}
			if (
				typeof node.parameters !== "object" ||
				node.parameters === null ||
				Array.isArray(node.parameters)
			) {
				return {
					path: [...current.path, "parameters"],
					message: "Condition parameters must be an object",
				};
			}
			continue;
		}
		if (node.type === "group") {
			const extra = Object.keys(node).find(
				(key) => key !== "type" && key !== "operator" && key !== "children",
			);
			if (extra) {
				return { path: [...current.path, extra], message: `Unexpected group field "${extra}"` };
			}
			if (node.operator !== "AND" && node.operator !== "OR") {
				return {
					path: [...current.path, "operator"],
					message: "Group operator must be AND or OR",
				};
			}
			if (!Array.isArray(node.children) || node.children.length === 0) {
				return {
					path: [...current.path, "children"],
					message: "Groups must contain at least one child",
				};
			}
			for (let i = node.children.length - 1; i >= 0; i--) {
				stack.push({
					node: node.children[i],
					path: [...current.path, "children", i],
					depth: current.depth + 1,
				});
			}
			continue;
		}
		if (node.type === "not") {
			const extra = Object.keys(node).find((key) => key !== "type" && key !== "child");
			if (extra) {
				return { path: [...current.path, extra], message: `Unexpected NOT field "${extra}"` };
			}
			if (!("child" in node)) {
				return { path: [...current.path, "child"], message: "NOT must contain one child" };
			}
			stack.push({
				node: node.child,
				path: [...current.path, "child"],
				depth: current.depth + 1,
			});
			continue;
		}
		return {
			path: [...current.path, "type"],
			message: "Expression node type must be condition, group, or not",
		};
	}
	return null;
}

export const cleanupRuleExpressionSchema = z
	.unknown()
	.superRefine((value, ctx) => {
		const failure = getExpressionValidationFailure(value);
		if (failure) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: failure.message,
				path: failure.path,
			});
		}
	})
	.transform((value) => value as VersionedCleanupRuleExpression);

export function isVersionedCleanupRuleExpression(
	value: unknown,
): value is VersionedCleanupRuleExpression {
	return cleanupRuleExpressionSchema.safeParse(value).success;
}

/** Convert every supported rule representation to the evaluator language. */
export function normalizeCleanupRuleExpression(input: {
	ruleType: RuleType | string;
	parameters: Record<string, unknown>;
	operator?: CompositeOperator | string | null;
	conditions?: readonly Condition[] | null;
	expression?: VersionedCleanupRuleExpression | null;
}): VersionedCleanupRuleExpression | null {
	if (input.expression) {
		const parsed = cleanupRuleExpressionSchema.safeParse(input.expression);
		return parsed.success ? parsed.data : null;
	}
	if (input.operator === "AND" || input.operator === "OR") {
		if (!input.conditions?.length) return null;
		const normalized = {
			version: CLEANUP_RULE_EXPRESSION_VERSION,
			root: {
				type: "group",
				operator: input.operator,
				children: input.conditions.map((condition) => ({
					type: "condition",
					ruleType: condition.ruleType,
					parameters: condition.parameters,
				})),
			},
		} satisfies VersionedCleanupRuleExpression;
		const parsed = cleanupRuleExpressionSchema.safeParse(normalized);
		return parsed.success ? parsed.data : null;
	}
	if (input.ruleType === "composite") return null;
	const parsedType = ruleTypeSchema.exclude(["composite"]).safeParse(input.ruleType);
	if (!parsedType.success) return null;
	const normalized = {
		version: CLEANUP_RULE_EXPRESSION_VERSION,
		root: {
			type: "condition",
			ruleType: parsedType.data,
			parameters: input.parameters,
		},
	} satisfies VersionedCleanupRuleExpression;
	const parsed = cleanupRuleExpressionSchema.safeParse(normalized);
	return parsed.success ? parsed.data : null;
}

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
	operator: compositeOperatorSchema.nullable().optional(),
	// Legacy composites normalize to one implicit group node plus one node per
	// condition, so 99 children is the largest representation within the
	// shared 100-node AST budget.
	conditions: z
		.array(conditionSchema)
		.max(
			CLEANUP_RULE_EXPRESSION_MAX_NODES - 1,
			`Legacy composite rules can contain at most ${CLEANUP_RULE_EXPRESSION_MAX_NODES - 1} conditions`,
		)
		.nullable()
		.optional(),
	expression: cleanupRuleExpressionSchema.nullable().optional(),
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
	action?: CleanupAction | string | null;
	scanMediaServerAfterDelete?: boolean | null;
	ruleType?: RuleType | string | null;
	parameters?: Record<string, unknown> | null;
	operator?: CompositeOperator | string | null;
	conditions?: readonly unknown[] | null;
	expression?: VersionedCleanupRuleExpression | null;
}

/** True when any supported rule representation contains an IMDb condition. */
export function cleanupRuleRequiresRadarrRatings(rule: CleanupRuleScopeInput): boolean {
	if (rule.ruleType === "imdb_rating") return true;

	if (rule.expression) {
		const parsed = cleanupRuleExpressionSchema.safeParse(rule.expression);
		if (!parsed.success) return false;
		const stack: CleanupRuleExpression[] = [parsed.data.root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.type === "condition") {
				if (node.ruleType === "imdb_rating") return true;
			} else if (node.type === "group") {
				stack.push(...node.children);
			} else {
				stack.push(node.child);
			}
		}
	}

	return (
		rule.conditions?.some(
			(condition) =>
				typeof condition === "object" &&
				condition !== null &&
				"ruleType" in condition &&
				condition.ruleType === "imdb_rating",
		) ?? false
	);
}

function getImdbRatingServiceValidationError(rule: CleanupRuleScopeInput): string | null {
	if (!cleanupRuleRequiresRadarrRatings(rule)) return null;
	if (!rule.serviceFilter || rule.serviceFilter.length === 0) return null;
	if (rule.serviceFilter.length === 1 && rule.serviceFilter[0]?.toUpperCase() === "RADARR") {
		return null;
	}
	return "IMDb rating cleanup rules can target Radarr only";
}

/**
 * Episode cleanup deliberately starts with the one rule shape for which a
 * positive per-episode Plex witness can be evaluated without inferring
 * unwatched/absent state from an incomplete cache.
 */
export function getCleanupRuleScopeValidationError(rule: CleanupRuleScopeInput): string | null {
	const imdbServiceError = getImdbRatingServiceValidationError(rule);
	if (imdbServiceError) return imdbServiceError;
	if (
		rule.scanMediaServerAfterDelete === true &&
		(rule.retentionMode === true || rule.action === "unmonitor")
	) {
		return "Media-server scans can only follow delete or delete-files cleanup rules";
	}

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

export const createCleanupRuleSchema = baseCleanupRuleSchema.superRefine((data, ctx) => {
	if (
		data.ruleType === "composite" &&
		data.expression == null &&
		(data.operator == null || !data.conditions?.length)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules require an expression or an operator with conditions",
			path: ["ruleType"],
		});
	}
	if (
		data.ruleType !== "composite" &&
		(data.operator != null || data.conditions != null || data.expression != null)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Only composite rules can contain conditions or expressions",
			path: ["ruleType"],
		});
	}
	if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Composite rules must have at least one condition",
			path: ["conditions"],
		});
	}
	if (data.expression != null && (data.operator != null || data.conditions != null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Use either expression or legacy operator/conditions fields, not both",
			path: ["expression"],
		});
	}
	if (data.expression != null && data.ruleType !== "composite") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Recursive expressions require ruleType "composite"',
			path: ["ruleType"],
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
});

export const updateCleanupRuleSchema = baseCleanupRuleSchema
	.partial()
	// Zod 4 preserves inner defaults through `partial()`. Every default-bearing
	// create field must therefore be replaced with a plain optional schema here
	// so an omitted PUT field preserves the stored value.
	.extend({
		enabled: z.boolean().optional(),
		priority: z.number().int().optional(),
		targetScope: cleanupTargetScopeSchema.optional(),
		action: cleanupActionSchema.optional(),
		scanMediaServerAfterDelete: z.boolean().optional(),
		retentionMode: z.boolean().optional(),
		useGlobalRejectionMemory: z.boolean().optional(),
	})
	.superRefine((data, ctx) => {
		if (data.operator != null && (!data.conditions || data.conditions.length === 0)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Composite rules must have at least one condition",
				path: ["conditions"],
			});
		}
		if (data.expression != null && (data.operator != null || data.conditions != null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Use either expression or legacy operator/conditions fields, not both",
				path: ["expression"],
			});
		}
		if (data.expression != null && data.ruleType !== undefined && data.ruleType !== "composite") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Recursive expressions require ruleType "composite"',
				path: ["ruleType"],
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
	operator: CompositeOperator | null;
	conditions: Condition[] | null;
	expression?: VersionedCleanupRuleExpression | null;
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
	trigger: string;
	latestOutcome: string;
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
	tautulliUsers: string[];
	plexUsers: string[];
	plexLibraries: string[];
	plexCollections: string[];
	plexLabels: string[];
	jellyfinUsers: string[];
	jellyfinLibraries: string[];
	arrTags: Array<{ id: number; label: string }>;
	hasPlex: boolean;
	hasTautulli: boolean;
	hasJellyfin: boolean;
	/** Present only when Plex is configured; distinguishes unavailable values from an empty set. */
	plexEvidence?: PlexEvidenceSummary;
}

/** Preview result: items that would be flagged by current rules */
/**
 * Cached qUI observation shown in cleanup previews. These values are
 * informational snapshots from the last cache sync, never deletion
 * authorization. Destructive cleanup with qUI protection enabled obtains a
 * complete, fresh qUI view again at the physical-file mutation boundary.
 *
 *  - `seeding`         — the cached torrent state was active.
 *  - `paused_or_error` — the cached torrent state was paused or errored.
 *  - `not_in_qui`      — a complete sync across every enabled qUI found no
 *                        matching torrent for this infoHash.
 *  - `no_signal`       — no complete, fresh qUI observation is available.
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
	/** Cached qUI observation (Phase 3.3). See CleanupQuiStatus comment. */
	quiStatus: CleanupQuiStatus;
	/** Identifies qUI preview evidence as a non-authoritative cache snapshot. */
	quiStatusSource?: "cached" | null;
	/** ISO timestamp for the cache row that supplied `quiStatus`, when available. */
	quiStatusObservedAt?: string | null;
	/** Whether this target belongs to the exact next run or is being held back. */
	selectionStatus?: "selected" | "deferred" | "blocked" | "in_flight";
	/** The configured mutation; preview does not claim the mutation will succeed. */
	plannedAction?: "delete" | "unmonitor" | "delete_files";
	/** True when this row is a durable retry attempt rather than a fresh rule match. */
	isRetryAttempt?: boolean;
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
		deferredInFlightTarget?: number;
		deferredDuplicateTarget?: number;
		inFlight: number;
		/** Overlapping subset of selectedFresh, not an additional candidate count. */
		blocked: number;
		retryStateUnavailable: number;
		retryState?: "complete" | "unavailable";
		total: number;
	};
	display?: {
		shown: number;
		hidden: number;
		limit: number;
		/** True only when every result row is included in this response. */
		complete: boolean;
	};
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
	tautulli: PrefetchSourceStatus;
	plex: PrefetchSourceStatus;
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
