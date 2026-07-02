import { z } from "zod";

// ── Tracearr Public API — Shared Types ──────────────────────────────
// Wire contract between arr-dashboard's API and frontend for the Tracearr
// integration (charter §2.2 / ADR-0007). The backend translates raw
// Tracearr `/api/v1/public/*` responses into these shapes at the client
// boundary; the frontend never sees Tracearr's API surface directly.
//
// STRICTNESS POLICY — deliberately more tolerant than the qui contract:
//   1. Tracearr's own OpenAPI spec drifts from its runtime. Verified live
//      against supervised-v1.4.28: `/stats/today` returns `todaySessions`
//      (absent from the spec) and omits `timestamp` (marked required in the
//      spec). We therefore trust LIVE OBSERVATION over the spec's `required`.
//   2. Per-item objects (`Stream`, `SessionHistory`, `User`, `Violation`)
//      are derived from media-server data that is structurally partial — a
//      movie stream has no `seasonNumber`/`artistName`; a photo has no
//      `bitrate`. Only `id` is treated as guaranteed on those; every other
//      field is optional/nullable, and open vocabularies use `.catch()` so
//      a novel value degrades instead of 502-ing the whole response.
//   3. These item schemas were authored from the spec + envelope probes but
//      NOT yet validated against populated rows (the dev Tracearr has no
//      media servers attached, so item arrays come back empty). They run for
//      real starting with the streams/history consumers (Tracearr-2 / C2) —
//      tighten them there against live data.
//
// z.object() strips unknown keys by default (Zod 4), so drift that ADDS a
// field never throws — only a MISSING required field would. Envelopes below
// are live-verified, so their top-level keys are safe to require.

/** ISO-8601 timestamp. Kept as a plain string (no `.datetime()`) so a
 *  formatting quirk from Tracearr never fails validation of an otherwise
 *  usable payload — these are display values, not parsed for arithmetic. */
const isoTimestamp = z.string();

// ── /health ─────────────────────────────────────────────────────────

/** A media server Tracearr is connected to, as reported by `/health`. */
export const tracearrServerStatusSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["plex", "jellyfin", "emby"]).catch("plex"),
	online: z.boolean(),
	activeStreams: z.number().int(),
});
export type TracearrServerStatus = z.infer<typeof tracearrServerStatusSchema>;

/**
 * `GET /health` — connection + auth validation, plus attached servers.
 * `status` (the identity field the connection tester keys on) and `servers`
 * (the field we consume) are required; `version`/`timestamp` are optional to
 * stay as tolerant as the raw health probe in the client, so a future build
 * that trims either field degrades gracefully rather than 502-ing the route.
 */
export const tracearrHealthSchema = z.object({
	status: z.string(),
	version: z.string().optional(),
	timestamp: isoTimestamp.optional(),
	servers: z.array(tracearrServerStatusSchema),
});
export type TracearrHealth = z.infer<typeof tracearrHealthSchema>;

// ── /stats and /stats/today ─────────────────────────────────────────

/** `GET /stats` — all-time rollup counters. Live-verified present. */
export const tracearrStatsSchema = z.object({
	activeStreams: z.number().int(),
	totalUsers: z.number().int(),
	totalSessions: z.number().int(),
	recentViolations: z.number().int(),
	timestamp: isoTimestamp,
});
export type TracearrStats = z.infer<typeof tracearrStatsSchema>;

/**
 * `GET /stats/today` — the spec-vs-runtime drift case. `todaySessions` is
 * present live but absent from the spec; `timestamp` is the reverse. Both
 * are marked optional so either the spec's shape OR the runtime's shape
 * validates. The five counters common to both are required.
 */
export const tracearrStatsTodaySchema = z.object({
	activeStreams: z.number().int(),
	todayPlays: z.number().int(),
	/** Live-only (not in the published spec). */
	todaySessions: z.number().int().optional(),
	watchTimeHours: z.number(),
	alertsLast24h: z.number().int(),
	activeUsersToday: z.number().int(),
	/** Spec-only (omitted by supervised-v1.4.28 runtime). */
	timestamp: isoTimestamp.optional(),
});
export type TracearrStatsToday = z.infer<typeof tracearrStatsTodaySchema>;

/**
 * `GET /api/tracearr/stats` — OUR API bundles the all-time rollup and today's
 * counters in one response so the Statistics tab's summary cards need a
 * single fetch. `instanceId`/`instanceLabel` disclose which Tracearr backs
 * the figures (statistics target a single hub instance, not an aggregate).
 */
export const tracearrStatsBundleSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	stats: tracearrStatsSchema,
	today: tracearrStatsTodaySchema,
});
export type TracearrStatsBundle = z.infer<typeof tracearrStatsBundleSchema>;

// ── /activity ───────────────────────────────────────────────────────

export const tracearrQualityBreakdownSchema = z.object({
	directPlay: z.number().int(),
	directStream: z.number().int(),
	transcode: z.number().int(),
	total: z.number().int(),
	directPlayPercent: z.number(),
	directStreamPercent: z.number(),
	transcodePercent: z.number(),
});
export type TracearrQualityBreakdown = z.infer<typeof tracearrQualityBreakdownSchema>;

/** `GET /activity` — aggregated play/concurrency series for charts. */
export const tracearrActivitySchema = z.object({
	period: z.enum(["week", "month", "year"]).catch("month"),
	range: z.object({ start: isoTimestamp, end: isoTimestamp }),
	plays: z.array(z.object({ date: z.string(), count: z.number().int() })),
	concurrent: z.array(
		z.object({
			date: z.string(),
			total: z.number().int(),
			direct: z.number().int(),
			directStream: z.number().int(),
			transcode: z.number().int(),
		}),
	),
	byDayOfWeek: z.array(
		z.object({ day: z.number().int(), name: z.string(), count: z.number().int() }),
	),
	byHourOfDay: z.array(z.object({ hour: z.number().int(), count: z.number().int() })),
	platforms: z.array(z.object({ platform: z.string(), count: z.number().int() })),
	quality: tracearrQualityBreakdownSchema,
});
export type TracearrActivity = z.infer<typeof tracearrActivitySchema>;

/**
 * `GET /api/tracearr/activity` — OUR API wraps the time-series with the
 * source instance so the Statistics tab can disclose which Tracearr backs it.
 */
export const tracearrActivityBundleSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	activity: tracearrActivitySchema,
});
export type TracearrActivityBundle = z.infer<typeof tracearrActivityBundleSchema>;

// ── Shared media-detail sub-objects (Stream + SessionHistory) ───────
// Partial by nature; every field optional. Shared between live streams and
// historical sessions since Tracearr returns the same enrichment on both.

const sourceVideoDetailsSchema = z
	.object({
		bitrate: z.number().optional(),
		framerate: z.string().optional(),
		dynamicRange: z.string().optional(),
		aspectRatio: z.number().optional(),
		profile: z.string().optional(),
		level: z.string().optional(),
		colorSpace: z.string().optional(),
		colorDepth: z.number().optional(),
	})
	.nullable();

const sourceAudioDetailsSchema = z
	.object({
		bitrate: z.number().optional(),
		channelLayout: z.string().optional(),
		language: z.string().optional(),
		sampleRate: z.number().optional(),
	})
	.nullable();

const streamVideoDetailsSchema = z
	.object({
		bitrate: z.number().optional(),
		width: z.number().optional(),
		height: z.number().optional(),
		framerate: z.string().optional(),
		dynamicRange: z.string().optional(),
	})
	.nullable();

const streamAudioDetailsSchema = z
	.object({
		bitrate: z.number().optional(),
		channels: z.number().optional(),
		language: z.string().optional(),
	})
	.nullable();

const transcodeInfoSchema = z
	.object({
		containerDecision: z.enum(["directplay", "copy", "transcode"]).optional(),
		sourceContainer: z.string().optional(),
		streamContainer: z.string().optional(),
		hwRequested: z.boolean().optional(),
		hwDecoding: z.string().optional(),
		hwEncoding: z.string().optional(),
		speed: z.number().optional(),
		throttled: z.boolean().optional(),
		reasons: z.array(z.string()).optional(),
	})
	.nullable();

const subtitleInfoSchema = z
	.object({
		decision: z.string().optional(),
		codec: z.string().optional(),
		language: z.string().optional(),
		forced: z.boolean().optional(),
	})
	.nullable();

/** Media-playback enums shared by streams + history. Open vocabularies. */
export const tracearrMediaTypeSchema = z
	.enum(["movie", "episode", "track", "live", "photo", "unknown"])
	.catch("unknown");
export type TracearrMediaType = z.infer<typeof tracearrMediaTypeSchema>;

export const tracearrPlaybackStateSchema = z
	.enum(["playing", "paused", "stopped"])
	.catch("stopped");
export type TracearrPlaybackState = z.infer<typeof tracearrPlaybackStateSchema>;

const playbackDecisionSchema = z.enum(["directplay", "copy", "transcode"]).nullable();

/**
 * The full media-enrichment field set common to a live `Stream` and a
 * historical `SessionHistory`. Factored out to keep the two item schemas
 * in sync — Tracearr returns identical codec/decision/detail enrichment on
 * both. All optional: presence depends on media type and server capability.
 */
const mediaEnrichmentShape = {
	mediaType: tracearrMediaTypeSchema.optional(),
	showTitle: z.string().optional(),
	seasonNumber: z.number().int().optional(),
	episodeNumber: z.number().int().optional(),
	year: z.number().int().optional(),
	artistName: z.string().optional(),
	albumName: z.string().optional(),
	trackNumber: z.number().int().optional(),
	discNumber: z.number().int().optional(),
	thumbPath: z.string().optional(),
	posterUrl: z.string().optional(),
	durationMs: z.number().optional(),
	progressMs: z.number().optional(),
	isTranscode: z.boolean().optional(),
	videoDecision: playbackDecisionSchema.optional(),
	audioDecision: playbackDecisionSchema.optional(),
	bitrate: z.number().optional(),
	sourceVideoCodec: z.string().optional(),
	sourceAudioCodec: z.string().optional(),
	sourceAudioChannels: z.number().optional(),
	sourceVideoWidth: z.number().optional(),
	sourceVideoHeight: z.number().optional(),
	sourceVideoDetails: sourceVideoDetailsSchema.optional(),
	sourceAudioDetails: sourceAudioDetailsSchema.optional(),
	streamVideoCodec: z.string().optional(),
	streamAudioCodec: z.string().optional(),
	streamVideoDetails: streamVideoDetailsSchema.optional(),
	streamAudioDetails: streamAudioDetailsSchema.optional(),
	transcodeInfo: transcodeInfoSchema.optional(),
	subtitleInfo: subtitleInfoSchema.optional(),
	resolution: z.string().optional(),
	sourceVideoCodecDisplay: z.string().optional(),
	sourceAudioCodecDisplay: z.string().optional(),
	audioChannelsDisplay: z.string().optional(),
	streamVideoCodecDisplay: z.string().optional(),
	streamAudioCodecDisplay: z.string().optional(),
	device: z.string().optional(),
	player: z.string().optional(),
	product: z.string().optional(),
	platform: z.string().optional(),
} as const;

// ── /streams ────────────────────────────────────────────────────────

/** A single live playback session. See partial-shape note in header. */
export const tracearrStreamSchema = z.object({
	id: z.string(),
	serverId: z.string().optional(),
	serverName: z.string().optional(),
	username: z.string().optional(),
	userThumb: z.string().optional(),
	userAvatarUrl: z.string().optional(),
	mediaTitle: z.string().optional(),
	state: tracearrPlaybackStateSchema.optional(),
	startedAt: isoTimestamp.optional(),
	...mediaEnrichmentShape,
});
export type TracearrStream = z.infer<typeof tracearrStreamSchema>;

/** Per-server rollup inside the streams summary. `totalBitrate` is a
 *  pre-formatted STRING (e.g. "—" or "12.4 Mbps"), never a number. */
export const tracearrServerStreamSummarySchema = z.object({
	serverId: z.string(),
	serverName: z.string(),
	total: z.number().int(),
	transcodes: z.number().int(),
	directStreams: z.number().int(),
	directPlays: z.number().int(),
	totalBitrate: z.string(),
});
export type TracearrServerStreamSummary = z.infer<typeof tracearrServerStreamSummarySchema>;

export const tracearrStreamsSummarySchema = z.object({
	total: z.number().int(),
	transcodes: z.number().int(),
	directStreams: z.number().int(),
	directPlays: z.number().int(),
	/** Pre-formatted string (e.g. "—"), NOT a number. */
	totalBitrate: z.string(),
	byServer: z.array(tracearrServerStreamSummarySchema),
});
export type TracearrStreamsSummary = z.infer<typeof tracearrStreamsSummarySchema>;

/** `GET /streams` — live sessions + aggregate summary. Envelope verified. */
export const tracearrStreamsResponseSchema = z.object({
	data: z.array(tracearrStreamSchema),
	summary: tracearrStreamsSummarySchema,
});
export type TracearrStreamsResponse = z.infer<typeof tracearrStreamsResponseSchema>;

// ── Aggregate live-sessions view (arr-dashboard console tile, Tracearr-2) ──
// NOTE: unlike the schemas above (which model Tracearr's tolerant wire
// format), the three schemas below are OUR API → OUR frontend contract for
// the Console "Live Sessions" card, so they are strict. The backend derives
// them by aggregating each enabled Tracearr instance's `/streams` summary.

/**
 * Aggregate stream counts across every reachable Tracearr instance. Counts
 * sum cleanly; `totalBitrate` is a passthrough of the single reachable
 * instance's pre-formatted string and is `null` when there are zero or more
 * than one reachable instances (formatted strings can't be summed).
 */
export const tracearrLiveSessionsSummarySchema = z.object({
	total: z.number().int(),
	transcodes: z.number().int(),
	directStreams: z.number().int(),
	directPlays: z.number().int(),
	totalBitrate: z.string().nullable(),
});
export type TracearrLiveSessionsSummary = z.infer<typeof tracearrLiveSessionsSummarySchema>;

/** Per-instance reachability, so the card can honestly disclose a down instance. */
export const tracearrLiveSessionsInstanceSchema = z.object({
	id: z.string(),
	label: z.string(),
	reachable: z.boolean(),
});
export type TracearrLiveSessionsInstance = z.infer<typeof tracearrLiveSessionsInstanceSchema>;

/**
 * A single live playback session shaped for the console rows + kill action
 * (Tracearr-3). `id` is Tracearr's stream id (the terminate target) and
 * `instanceId`/`instanceLabel` identify WHICH Tracearr owns it — the kill
 * route needs both to route + ownership-check. The rest is the partial media
 * enrichment the row displays (title/user/progress/transcode); every media
 * field is optional because media-server data is structurally partial.
 */
export const tracearrLiveSessionSchema = z.object({
	id: z.string(),
	instanceId: z.string(),
	instanceLabel: z.string(),
	serverName: z.string().optional(),
	username: z.string().optional(),
	mediaTitle: z.string().optional(),
	showTitle: z.string().optional(),
	mediaType: tracearrMediaTypeSchema.optional(),
	seasonNumber: z.number().int().optional(),
	episodeNumber: z.number().int().optional(),
	state: tracearrPlaybackStateSchema.optional(),
	progressMs: z.number().optional(),
	durationMs: z.number().optional(),
	isTranscode: z.boolean().optional(),
	videoDecision: z.enum(["directplay", "copy", "transcode"]).nullable().optional(),
	player: z.string().optional(),
	platform: z.string().optional(),
});
export type TracearrLiveSession = z.infer<typeof tracearrLiveSessionSchema>;

/**
 * `GET /api/tracearr/streams` — aggregate live-session view for the console.
 * `configured` is false when the user has no enabled Tracearr instance (the
 * card is omitted). `summary` is null when configured but no instance is
 * currently reachable (the card shows an unreachable state, never a fake 0).
 * `sessions` is the flat per-session list across all reachable instances
 * (each tagged with its owning instance) that the card renders + kills.
 */
export const tracearrLiveSessionsResponseSchema = z.object({
	configured: z.boolean(),
	instances: z.array(tracearrLiveSessionsInstanceSchema),
	summary: tracearrLiveSessionsSummarySchema.nullable(),
	sessions: z.array(tracearrLiveSessionSchema),
});
export type TracearrLiveSessionsResponse = z.infer<typeof tracearrLiveSessionsResponseSchema>;

// ── POST /streams/{id}/terminate (Tracearr-3) ───────────────────────

/** Optional reason surfaced to the terminated user (Tracearr forwards it). */
export const tracearrTerminateRequestSchema = z.object({
	reason: z.string().trim().max(500).optional(),
});
export type TracearrTerminateRequest = z.infer<typeof tracearrTerminateRequestSchema>;

export const tracearrTerminateResponseSchema = z.object({
	success: z.literal(true),
	terminationLogId: z.string(),
	message: z.string(),
});
export type TracearrTerminateResponse = z.infer<typeof tracearrTerminateResponseSchema>;

// ── Pagination + /users ─────────────────────────────────────────────

export const tracearrPaginationMetaSchema = z.object({
	total: z.number().int(),
	page: z.number().int(),
	pageSize: z.number().int(),
});
export type TracearrPaginationMeta = z.infer<typeof tracearrPaginationMetaSchema>;

export const tracearrUserRoleSchema = z
	.enum(["owner", "admin", "viewer", "member", "disabled", "pending"])
	.catch("viewer");
export type TracearrUserRole = z.infer<typeof tracearrUserRoleSchema>;

/** A Tracearr-tracked media-server user. Partial; only `id` guaranteed. */
export const tracearrUserSchema = z.object({
	id: z.string(),
	username: z.string().optional(),
	displayName: z.string().optional(),
	thumbUrl: z.string().optional(),
	avatarUrl: z.string().optional(),
	role: tracearrUserRoleSchema.optional(),
	trustScore: z.number().optional(),
	totalViolations: z.number().int().optional(),
	serverId: z.string().optional(),
	serverName: z.string().optional(),
	lastActivityAt: isoTimestamp.nullable().optional(),
	sessionCount: z.number().int().optional(),
	createdAt: isoTimestamp.optional(),
});
export type TracearrUser = z.infer<typeof tracearrUserSchema>;

export const tracearrUsersResponseSchema = z.object({
	data: z.array(tracearrUserSchema),
	meta: tracearrPaginationMetaSchema,
});
export type TracearrUsersResponse = z.infer<typeof tracearrUsersResponseSchema>;

// ── /violations (account-sharing detection) ─────────────────────────

export const tracearrViolationSeveritySchema = z.enum(["low", "warning", "high"]).catch("warning");
export type TracearrViolationSeverity = z.infer<typeof tracearrViolationSeveritySchema>;

export const tracearrViolationSchema = z.object({
	id: z.string(),
	serverId: z.string().optional(),
	serverName: z.string().optional(),
	severity: tracearrViolationSeveritySchema.optional(),
	acknowledged: z.boolean().optional(),
	/** Free-form rule-specific payload — shape varies by rule type. */
	data: z.record(z.string(), z.unknown()).optional(),
	createdAt: isoTimestamp.optional(),
	rule: z.object({ id: z.string(), type: z.string(), name: z.string() }).partial().optional(),
	user: z
		.object({
			id: z.string(),
			username: z.string(),
			thumbUrl: z.string(),
			avatarUrl: z.string(),
		})
		.partial()
		.optional(),
});
export type TracearrViolation = z.infer<typeof tracearrViolationSchema>;

export const tracearrViolationsResponseSchema = z.object({
	data: z.array(tracearrViolationSchema),
	meta: tracearrPaginationMetaSchema,
});
export type TracearrViolationsResponse = z.infer<typeof tracearrViolationsResponseSchema>;

// ── /history (watch history — the Statistics/C2 data source) ─────────

/** A completed playback session. Same enrichment as a live Stream plus
 *  completion fields (`stoppedAt`, `watched`). Partial; only `id` sure. */
export const tracearrSessionHistorySchema = z.object({
	id: z.string(),
	serverId: z.string().optional(),
	serverName: z.string().optional(),
	state: tracearrPlaybackStateSchema.optional(),
	mediaTitle: z.string().optional(),
	username: z.string().optional(),
	totalDurationMs: z.number().optional(),
	startedAt: isoTimestamp.optional(),
	stoppedAt: isoTimestamp.nullable().optional(),
	watched: z.boolean().optional(),
	segmentCount: z.number().int().optional(),
	user: z
		.object({
			id: z.string(),
			username: z.string(),
			thumbUrl: z.string(),
			avatarUrl: z.string(),
		})
		.partial()
		.optional(),
	...mediaEnrichmentShape,
});
export type TracearrSessionHistory = z.infer<typeof tracearrSessionHistorySchema>;

export const tracearrHistoryResponseSchema = z.object({
	data: z.array(tracearrSessionHistorySchema),
	meta: tracearrPaginationMetaSchema,
});
export type TracearrHistoryResponse = z.infer<typeof tracearrHistoryResponseSchema>;

// ── Query-param option bags (for typed client methods) ──────────────
//
// Each carries an index signature so it's assignable to the request
// helper's `Record<string, string | number | boolean | undefined>` query
// type. Semantically apt here: these are URL query bags whose values are
// always primitives. The named keys give callers autocomplete; the index
// signature is the escape hatch for forwarding to the fetch layer.

/** Value type every query-param bag key resolves to. */
export type TracearrQueryValue = string | number | boolean | undefined;

export interface TracearrPaginationQuery {
	page?: number;
	pageSize?: number;
	serverId?: string;
	[key: string]: TracearrQueryValue;
}

export interface TracearrHistoryQuery extends TracearrPaginationQuery {
	state?: TracearrPlaybackState;
	mediaType?: TracearrMediaType;
	startDate?: string;
	endDate?: string;
	timezone?: string;
}

export interface TracearrViolationsQuery extends TracearrPaginationQuery {
	severity?: TracearrViolationSeverity;
	acknowledged?: boolean;
}

export interface TracearrStatsQuery {
	serverId?: string;
	timezone?: string;
	[key: string]: TracearrQueryValue;
}

export interface TracearrActivityQuery {
	period?: "week" | "month" | "year";
	serverId?: string;
	timezone?: string;
	[key: string]: TracearrQueryValue;
}

export interface TracearrStreamsQuery {
	serverId?: string;
	[key: string]: TracearrQueryValue;
}

export interface TracearrUsersQuery extends TracearrPaginationQuery {}
