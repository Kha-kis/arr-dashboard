import { z } from "zod";
import { getRegexSafetyError, REGEX_MAX_LENGTH } from "./regex-safety.js";

// ============================================================================
// Rule Types
// ============================================================================

export const cleanupRuleTypeSchema = z.enum([
	"age",
	"size",
	"rating",
	"status",
	"unmonitored",
	"genre",
	"year_range",
	"no_file",
	"quality_profile",
	"language",
	// File metadata rules (from cached ARR data blob)
	"video_codec",
	"audio_codec",
	"resolution",
	"hdr_type",
	"custom_format_score",
	"runtime",
	"release_group",
	// Seerr integration rules
	"seerr_requested_by",
	"seerr_request_age",
	"seerr_request_status",
	"seerr_is_4k",
	"seerr_request_modified_age",
	"seerr_modified_by",
	// Tautulli integration rules
	"tautulli_last_watched",
	"tautulli_watch_count",
	"tautulli_watched_by",
	// Plex integration rules
	"plex_last_watched",
	"plex_watch_count",
	"plex_on_deck",
	"plex_user_rating",
	"plex_watched_by",
	// Phase C: New rule types
	"imdb_rating",
	"file_path",
	"seerr_is_requested",
	"seerr_request_count",
	"audio_channels",
	"tag_match",
	// Phase D: Plex metadata rules
	"plex_collection",
	"plex_label",
	"plex_added_at",
	// Phase B: Composite rules
	"composite",
	// Phase 2: Behavior-aware rules
	"plex_episode_completion",
	"user_retention",
	"staleness_score",
	// Phase 3: Advanced automation
	"recently_active",
]);

export type CleanupRuleType = z.infer<typeof cleanupRuleTypeSchema>;

// ============================================================================
// Action & Composite Schemas (Phase A + B)
// ============================================================================

export const cleanupActionSchema = z.enum(["delete", "unmonitor", "delete_files"]);
export type CleanupAction = z.infer<typeof cleanupActionSchema>;

export const compositeOperatorSchema = z.enum(["AND", "OR"]);
export type CompositeOperator = z.infer<typeof compositeOperatorSchema>;

export const conditionSchema = z.object({
	ruleType: cleanupRuleTypeSchema.exclude(["composite"]),
	parameters: z.record(z.string(), z.unknown()),
});
export type Condition = z.infer<typeof conditionSchema>;

// ============================================================================
// Rule Parameter Schemas
// ============================================================================

export const ageRuleParamsSchema = z.object({
	field: z.enum(["arrAddedAt"]).default("arrAddedAt"),
	operator: z.enum(["older_than", "newer_than"]),
	days: z.number().int().min(1),
});

export const sizeRuleParamsSchema = z.object({
	operator: z.enum(["greater_than", "less_than"]),
	sizeGb: z.number().positive(),
});

export const ratingRuleParamsSchema = z.object({
	source: z.enum(["tmdb"]),
	operator: z.enum(["less_than", "greater_than", "unrated"]),
	score: z.number().min(0).max(10).optional(),
});

export const statusRuleParamsSchema = z.object({
	statuses: z.array(z.string().min(1)).min(1),
});

export const unmonitoredRuleParamsSchema = z.object({});

export const genreRuleParamsSchema = z.object({
	operator: z.enum(["includes_any", "excludes_all"]),
	genres: z.array(z.string().min(1)).min(1),
});

export const yearRangeRuleParamsSchema = z
	.object({
		operator: z.enum(["before", "after", "between"]),
		year: z.number().int().optional(),
		yearFrom: z.number().int().optional(),
		yearTo: z.number().int().optional(),
	})
	.refine(
		(data) => {
			if (data.operator === "between")
				return data.yearFrom != null && data.yearTo != null && data.yearFrom <= data.yearTo;
			return data.year != null;
		},
		{ message: "Required fields missing for selected operator" },
	);

export const noFileRuleParamsSchema = z.object({});

export const qualityProfileRuleParamsSchema = z.object({
	profileNames: z.array(z.string().min(1)).min(1),
});

export const languageRuleParamsSchema = z.object({
	operator: z.enum(["includes_any", "excludes_all"]),
	languages: z.array(z.string().min(1)).min(1),
});

export const seerrRequestedByParamsSchema = z.object({
	userNames: z.array(z.string().min(1)).min(1),
});

export const seerrRequestAgeParamsSchema = z.object({
	operator: z.enum(["older_than", "newer_than"]),
	days: z.number().int().min(1),
});

export const seerrRequestStatusParamsSchema = z.object({
	statuses: z.array(z.enum(["pending", "approved", "declined", "failed", "completed"])).min(1),
});

// ── File Metadata Rule Params ────────────────────────────────────────

export const videoCodecRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not"]),
	codecs: z.array(z.string().min(1)).min(1),
});

export const audioCodecRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not"]),
	codecs: z.array(z.string().min(1)).min(1),
});

export const resolutionRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not"]),
	resolutions: z.array(z.string().min(1)).min(1),
});

export const hdrTypeRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not", "none"]),
	types: z.array(z.string().min(1)).optional(), // optional when operator is "none"
});

export const customFormatScoreRuleParamsSchema = z.object({
	operator: z.enum(["greater_than", "less_than"]),
	score: z.number().int(),
});

export const runtimeRuleParamsSchema = z.object({
	operator: z.enum(["greater_than", "less_than"]),
	minutes: z.number().int().min(0),
});

export const releaseGroupRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not"]),
	groups: z.array(z.string().min(1)).min(1),
});

// ── Enhanced Seerr Rule Params ───────────────────────────────────────

export const seerrIs4kParamsSchema = z.object({
	is4k: z.boolean(),
});

export const seerrRequestModifiedAgeParamsSchema = z.object({
	operator: z.enum(["older_than", "newer_than"]),
	days: z.number().int().min(1),
});

export const seerrModifiedByParamsSchema = z.object({
	userNames: z.array(z.string().min(1)).min(1),
});

// ── Tautulli Rule Params ─────────────────────────────────────────────

export const tautulliLastWatchedParamsSchema = z.object({
	operator: z.enum(["older_than", "never"]),
	days: z.number().int().min(1).optional(), // optional when operator is "never"
});

export const tautulliWatchCountParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than"]),
	count: z.number().int().min(0),
});

export const tautulliWatchedByParamsSchema = z.object({
	operator: z.enum(["includes_any", "excludes_all"]),
	userNames: z.array(z.string().min(1)).min(1),
});

// ── Plex Rule Params ────────────────────────────────────────────────

export const plexLastWatchedParamsSchema = z.object({
	operator: z.enum(["older_than", "never"]),
	days: z.number().int().min(1).optional(), // optional when operator is "never"
});

export const plexWatchCountParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than"]),
	count: z.number().int().min(0),
});

export const plexOnDeckParamsSchema = z.object({
	isDeck: z.boolean(), // true = IS on deck, false = is NOT on deck
});

export const plexUserRatingParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than", "unrated"]),
	rating: z.number().min(0).max(10).optional(), // optional when operator is "unrated"
});

export const plexWatchedByParamsSchema = z.object({
	operator: z.enum(["includes_any", "excludes_all"]),
	userNames: z.array(z.string().min(1)).min(1),
});

// ── Phase C: New Rule Parameter Schemas ──────────────────────────────

export const imdbRatingRuleParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than", "unrated"]),
	score: z.number().min(0).max(10).optional(),
});

export const filePathRuleParamsSchema = z.object({
	operator: z.enum(["matches", "not_matches"]),
	pattern: z
		.string()
		.min(1)
		.max(REGEX_MAX_LENGTH)
		.refine((p) => getRegexSafetyError(p) === null, {
			message:
				"Invalid or unsafe regular expression (nested quantifiers, backreferences, or excessive repetition are not allowed)",
		}),
	field: z.enum(["path", "rootFolderPath"]).default("path"),
});

export const seerrIsRequestedParamsSchema = z.object({
	isRequested: z.boolean(),
});

export const seerrRequestCountParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than", "equals"]),
	count: z.number().int().min(0),
});

export const audioChannelsRuleParamsSchema = z.object({
	operator: z.enum(["is", "is_not", "greater_than", "less_than"]),
	channels: z.number().min(1).max(20),
});

export const tagMatchRuleParamsSchema = z.object({
	operator: z.enum(["includes_any", "excludes_all"]),
	tagIds: z.array(z.number()).min(1),
});

// ── Phase D: Plex Metadata Rule Parameter Schemas ───────────────────

export const plexCollectionRuleParamsSchema = z.object({
	operator: z.enum(["in", "not_in"]),
	collections: z.array(z.string().min(1)).min(1),
});

export const plexLabelRuleParamsSchema = z.object({
	operator: z.enum(["has_any", "has_none"]),
	labels: z.array(z.string().min(1)).min(1),
});

export const plexAddedAtParamsSchema = z.object({
	operator: z.enum(["older_than", "newer_than"]),
	days: z.number().int().min(1),
});

// ── Phase 2: Behavior-Aware Rule Parameter Schemas ───────────────────

export const plexEpisodeCompletionParamsSchema = z.object({
	operator: z.enum(["less_than", "greater_than"]),
	percentage: z.number().min(0).max(100),
	minSeason: z.number().int().min(1).optional(),
});

export const userRetentionParamsSchema = z.object({
	operator: z.enum(["watched_by_none", "watched_by_all", "watched_by_count"]),
	userNames: z.array(z.string().min(1)).optional(),
	minUsers: z.number().int().min(1).optional(),
	source: z.enum(["plex", "tautulli", "either"]).default("plex"),
});

export const stalenessScoreParamsSchema = z.object({
	operator: z.enum(["greater_than"]),
	threshold: z.number().min(0).max(100),
	weights: z
		.object({
			daysSinceLastWatch: z.number().min(0).max(1).default(0.3),
			inverseWatchCount: z.number().min(0).max(1).default(0.2),
			notOnDeck: z.number().min(0).max(1).default(0.1),
			lowUserRating: z.number().min(0).max(1).default(0.15),
			lowTmdbRating: z.number().min(0).max(1).default(0.15),
			sizeOnDisk: z.number().min(0).max(1).default(0.1),
		})
		.optional(),
});

// ── Phase 3: Advanced Automation Rule Parameter Schemas ──────────────

export const recentlyActiveParamsSchema = z.object({
	protectionDays: z.number().int().min(1).max(365),
	requireActivity: z.boolean().default(true),
});

// ── Type Exports ─────────────────────────────────────────────────────

export type AgeRuleParams = z.infer<typeof ageRuleParamsSchema>;
export type SizeRuleParams = z.infer<typeof sizeRuleParamsSchema>;
export type RatingRuleParams = z.infer<typeof ratingRuleParamsSchema>;
export type StatusRuleParams = z.infer<typeof statusRuleParamsSchema>;
export type UnmonitoredRuleParams = z.infer<typeof unmonitoredRuleParamsSchema>;
export type GenreRuleParams = z.infer<typeof genreRuleParamsSchema>;
export type YearRangeRuleParams = z.infer<typeof yearRangeRuleParamsSchema>;
export type NoFileRuleParams = z.infer<typeof noFileRuleParamsSchema>;
export type QualityProfileRuleParams = z.infer<typeof qualityProfileRuleParamsSchema>;
export type LanguageRuleParams = z.infer<typeof languageRuleParamsSchema>;
export type VideoCodecRuleParams = z.infer<typeof videoCodecRuleParamsSchema>;
export type AudioCodecRuleParams = z.infer<typeof audioCodecRuleParamsSchema>;
export type ResolutionRuleParams = z.infer<typeof resolutionRuleParamsSchema>;
export type HdrTypeRuleParams = z.infer<typeof hdrTypeRuleParamsSchema>;
export type CustomFormatScoreRuleParams = z.infer<typeof customFormatScoreRuleParamsSchema>;
export type RuntimeRuleParams = z.infer<typeof runtimeRuleParamsSchema>;
export type ReleaseGroupRuleParams = z.infer<typeof releaseGroupRuleParamsSchema>;
export type SeerrRequestedByParams = z.infer<typeof seerrRequestedByParamsSchema>;
export type SeerrRequestAgeParams = z.infer<typeof seerrRequestAgeParamsSchema>;
export type SeerrRequestStatusParams = z.infer<typeof seerrRequestStatusParamsSchema>;
export type SeerrIs4kParams = z.infer<typeof seerrIs4kParamsSchema>;
export type SeerrRequestModifiedAgeParams = z.infer<typeof seerrRequestModifiedAgeParamsSchema>;
export type SeerrModifiedByParams = z.infer<typeof seerrModifiedByParamsSchema>;
export type TautulliLastWatchedParams = z.infer<typeof tautulliLastWatchedParamsSchema>;
export type TautulliWatchCountParams = z.infer<typeof tautulliWatchCountParamsSchema>;
export type TautulliWatchedByParams = z.infer<typeof tautulliWatchedByParamsSchema>;
export type PlexLastWatchedParams = z.infer<typeof plexLastWatchedParamsSchema>;
export type PlexWatchCountParams = z.infer<typeof plexWatchCountParamsSchema>;
export type PlexOnDeckParams = z.infer<typeof plexOnDeckParamsSchema>;
export type PlexUserRatingParams = z.infer<typeof plexUserRatingParamsSchema>;
export type PlexWatchedByParams = z.infer<typeof plexWatchedByParamsSchema>;
export type ImdbRatingRuleParams = z.infer<typeof imdbRatingRuleParamsSchema>;
export type FilePathRuleParams = z.infer<typeof filePathRuleParamsSchema>;
export type SeerrIsRequestedParams = z.infer<typeof seerrIsRequestedParamsSchema>;
export type SeerrRequestCountParams = z.infer<typeof seerrRequestCountParamsSchema>;
export type AudioChannelsRuleParams = z.infer<typeof audioChannelsRuleParamsSchema>;
export type TagMatchRuleParams = z.infer<typeof tagMatchRuleParamsSchema>;
export type PlexCollectionRuleParams = z.infer<typeof plexCollectionRuleParamsSchema>;
export type PlexLabelRuleParams = z.infer<typeof plexLabelRuleParamsSchema>;
export type PlexAddedAtParams = z.infer<typeof plexAddedAtParamsSchema>;
export type PlexEpisodeCompletionParams = z.infer<typeof plexEpisodeCompletionParamsSchema>;
export type UserRetentionParams = z.infer<typeof userRetentionParamsSchema>;
export type StalenessScoreParams = z.infer<typeof stalenessScoreParamsSchema>;
export type RecentlyActiveParams = z.infer<typeof recentlyActiveParamsSchema>;

// ============================================================================
// Configuration Types
// ============================================================================

const baseCleanupRuleSchema = z.object({
	name: z.string().min(1).max(100),
	enabled: z.boolean().optional().default(true),
	priority: z.number().int().optional().default(0),
	ruleType: cleanupRuleTypeSchema,
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
	ruleType: CleanupRuleType;
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
	tautulliUsers: string[];
	plexUsers: string[];
	plexLibraries: string[];
	plexCollections: string[];
	plexLabels: string[];
	arrTags: Array<{ id: number; label: string }>;
	hasPlex: boolean;
	hasTautulli: boolean;
}

/** Preview result: items that would be flagged by current rules */
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

// ============================================================================
// Rule Parameter Validation Map
// ============================================================================

/** Map of rule type → its Zod parameter schema, used for write-time validation */
export const ruleParamSchemaMap: Record<string, z.ZodType> = {
	age: ageRuleParamsSchema,
	size: sizeRuleParamsSchema,
	rating: ratingRuleParamsSchema,
	status: statusRuleParamsSchema,
	unmonitored: unmonitoredRuleParamsSchema,
	genre: genreRuleParamsSchema,
	year_range: yearRangeRuleParamsSchema,
	no_file: noFileRuleParamsSchema,
	quality_profile: qualityProfileRuleParamsSchema,
	language: languageRuleParamsSchema,
	video_codec: videoCodecRuleParamsSchema,
	audio_codec: audioCodecRuleParamsSchema,
	resolution: resolutionRuleParamsSchema,
	hdr_type: hdrTypeRuleParamsSchema,
	custom_format_score: customFormatScoreRuleParamsSchema,
	runtime: runtimeRuleParamsSchema,
	release_group: releaseGroupRuleParamsSchema,
	seerr_requested_by: seerrRequestedByParamsSchema,
	seerr_request_age: seerrRequestAgeParamsSchema,
	seerr_request_status: seerrRequestStatusParamsSchema,
	seerr_is_4k: seerrIs4kParamsSchema,
	seerr_request_modified_age: seerrRequestModifiedAgeParamsSchema,
	seerr_modified_by: seerrModifiedByParamsSchema,
	seerr_is_requested: seerrIsRequestedParamsSchema,
	seerr_request_count: seerrRequestCountParamsSchema,
	tautulli_last_watched: tautulliLastWatchedParamsSchema,
	tautulli_watch_count: tautulliWatchCountParamsSchema,
	tautulli_watched_by: tautulliWatchedByParamsSchema,
	plex_last_watched: plexLastWatchedParamsSchema,
	plex_watch_count: plexWatchCountParamsSchema,
	plex_on_deck: plexOnDeckParamsSchema,
	plex_user_rating: plexUserRatingParamsSchema,
	plex_watched_by: plexWatchedByParamsSchema,
	plex_collection: plexCollectionRuleParamsSchema,
	plex_label: plexLabelRuleParamsSchema,
	plex_added_at: plexAddedAtParamsSchema,
	imdb_rating: imdbRatingRuleParamsSchema,
	file_path: filePathRuleParamsSchema,
	audio_channels: audioChannelsRuleParamsSchema,
	tag_match: tagMatchRuleParamsSchema,
	plex_episode_completion: plexEpisodeCompletionParamsSchema,
	user_retention: userRetentionParamsSchema,
	staleness_score: stalenessScoreParamsSchema,
	recently_active: recentlyActiveParamsSchema,
};

/**
 * Data source each rule type depends on.
 * Rules whose data source fails should be skipped to avoid false matches.
 */
export type DataSourceDependency = "seerr" | "tautulli" | "plex" | null;

export const ruleDataSourceMap: Record<string, DataSourceDependency> = {
	seerr_requested_by: "seerr",
	seerr_request_age: "seerr",
	seerr_request_status: "seerr",
	seerr_is_4k: "seerr",
	seerr_request_modified_age: "seerr",
	seerr_modified_by: "seerr",
	seerr_is_requested: "seerr",
	seerr_request_count: "seerr",
	tautulli_last_watched: "tautulli",
	tautulli_watch_count: "tautulli",
	tautulli_watched_by: "tautulli",
	plex_last_watched: "plex",
	plex_watch_count: "plex",
	plex_on_deck: "plex",
	plex_user_rating: "plex",
	plex_watched_by: "plex",
	plex_collection: "plex",
	plex_label: "plex",
	plex_added_at: "plex",
	plex_episode_completion: "plex",
	user_retention: null, // Dynamic: depends on params.source (plex, tautulli, or either)
	staleness_score: "plex", // Uses multiple sources; plex is the primary
	recently_active: "plex", // Checks Plex on-deck/watch status
};
