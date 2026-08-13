export interface TautulliInfo {
	tautulli_version: string;
}

export interface TautulliLibrary {
	section_id: string;
	section_name: string;
	section_type: string;
	count: string;
}

export interface TautulliHistoryItem {
	row_id?: number;
	rating_key: string;
	parent_rating_key: string;
	grandparent_rating_key: string;
	title: string;
	grandparent_title: string;
	media_type: string;
	user: string;
	date: number;
	play_count?: number;
	group_count?: number;
}

export interface TautulliHistorySnapshot {
	items: TautulliHistoryItem[];
	recordsFiltered: number;
	recordsTotal: number;
	complete: boolean;
	incompleteReason?:
		| "page_limit_reached"
		| "upstream_total_changed"
		| "empty_page"
		| "missing_row_id"
		| "duplicate_row_id"
		| "unstable_row_id";
}

export interface TautulliHomeStatRow {
	title?: string;
	friendly_name?: string;
	user?: string;
	user_id?: string;
	section_id?: string;
	section_name?: string;
	section_type?: string;
	total_plays: number;
	total_duration: number;
	platform?: string;
	count?: number;
	started?: number;
	stopped?: number;
	rating_key?: string;
	grandparent_rating_key?: string;
	thumb?: string;
}

export interface TautulliHomeStat {
	stat_id: string;
	stat_title: string;
	rows: TautulliHomeStatRow[];
}

/** A provider-owned Tautulli user identity returned by `get_users`. */
export interface TautulliUser {
	user_id: string;
	username: string;
	friendly_name?: string;
}

/** One requested time window returned by `get_user_watch_time_stats`. */
export interface TautulliUserWatchTimeStat {
	query_days: number;
	total_plays: number;
	total_time: number;
}

/** Public provider discriminator. Tautulli analytics never fall back to another provider. */
export type TautulliProvider = "tautulli";

/** Source identity carried alongside provider-specific responses. */
export interface TautulliInstanceSource {
	instanceId: string;
	instanceLabel: string;
	reachable: boolean;
}

export interface TautulliActivitySession {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	mediaType: string;
	user: string;
	player: string;
	platform: string;
	product: string;
	state: "playing" | "paused" | "buffering" | "unknown";
	progressPercent: number;
	transcodeDecision: string;
	videoDecision: string;
	audioDecision: string;
	videoResolution: string;
	audioCodec: string;
	videoCodec: string;
	bandwidth: number;
	location: "lan" | "wan" | "unknown";
	thumb?: string;
	instanceId: string;
	instanceLabel: string;
}

export interface TautulliActivitySource extends TautulliInstanceSource {
	incompleteReason?: "source_unreachable" | "connection_changed";
	sessions: TautulliActivitySession[];
	streamCount: number;
	totalBandwidth: number;
	lanBandwidth: number;
	wanBandwidth: number;
}

export interface TautulliActivityResponse {
	provider: TautulliProvider;
	configured: boolean;
	sources: TautulliActivitySource[];
}

export interface TautulliAnalyticsUserStat {
	/** Exact provider user id from Tautulli; it is not an arr-dashboard user id. */
	userId: string;
	friendlyName: string;
	totalPlays: number;
	totalDuration: number;
	instanceId: string;
	instanceLabel: string;
}

export type TautulliStatsIncompleteReason =
	| "source_unreachable"
	| "connection_changed"
	| "user_list_unavailable"
	| "user_stats_partial";

/** Completeness metadata applies only to stats' optional per-user enrichment. */
export interface TautulliStatsSource extends TautulliInstanceSource {
	homeStats: TautulliHomeStat[];
	userStats: TautulliAnalyticsUserStat[];
	rankingLimit: number;
	userStatsComplete: boolean;
	failedUserCount: number;
	incompleteReason?: TautulliStatsIncompleteReason;
}

export interface TautulliStatsResponse {
	provider: TautulliProvider;
	configured: boolean;
	sources: TautulliStatsSource[];
	timeRange: number;
}

export interface TautulliPlaysByDateSource extends TautulliInstanceSource {
	incompleteReason?: "source_unreachable" | "connection_changed";
	categories: string[];
	series: Array<{ name: string; data: number[] }>;
}

export interface TautulliPlaysByDateResponse {
	provider: TautulliProvider;
	configured: boolean;
	sources: TautulliPlaysByDateSource[];
	timeRange: number;
}

export interface TautulliWatchHistoryItem {
	title: string;
	grandparentTitle?: string;
	mediaType: "movie" | "episode" | "track" | "unknown";
	watchedAt: string;
	user: string;
	ratingKey: string;
	instanceId: string;
	instanceLabel: string;
}

export type TautulliHistoryIncompleteReason =
	| NonNullable<TautulliHistorySnapshot["incompleteReason"]>
	| "source_unreachable"
	| "connection_changed"
	| "page_truncated"
	| "page_overflow";

export type TautulliHistorySource = {
	instanceId: string;
	instanceLabel: string;
	totalCount: number;
	history: TautulliWatchHistoryItem[];
} & (
	| { complete: true; incompleteReason?: never }
	| { complete: false; incompleteReason: TautulliHistoryIncompleteReason }
);

export interface TautulliWatchHistoryResponse {
	provider: TautulliProvider;
	configured: boolean;
	sources: TautulliHistorySource[];
	pagination: {
		offset: number;
		limit: number;
		complete: boolean;
	};
}

export interface TautulliCacheStatusResponse {
	instanceId: string;
	cachedItems: number;
	hasCacheData: boolean;
	status: {
		cacheType: "tautulli";
		lastRefreshedAt: string | null;
		lastResult: string | null;
		lastErrorMessage: string | null;
		itemCount: number;
		lastAttemptAt: string | null;
		lastAttemptResult: string | null;
		lastAttemptErrorMessage: string | null;
	} | null;
}

export interface TautulliCacheHealthResponse {
	items: Array<{
		instanceId: string;
		instanceLabel: string;
		cacheType: "tautulli";
		lastRefreshedAt: string | null;
		lastResult: string | null;
		lastErrorMessage: string | null;
		itemCount: number;
		/** The latest refresh attempt, retained separately from the successful generation. */
		lastAttemptAt: string | null;
		lastAttemptResult: string | null;
		lastAttemptErrorMessage: string | null;
		/** The result users should act on after accounting for an in-flight or failed attempt. */
		effectiveResult: string | null;
		isStale: boolean | null;
	}>;
}

export interface TautulliCacheRefreshResponse {
	success: boolean;
	complete: boolean;
	superseded: boolean;
	upserted: number;
	errors: number;
}
