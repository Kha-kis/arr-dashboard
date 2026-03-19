/**
 * Tautulli Shared Types
 *
 * Minimal types for Tautulli integration — response shapes and cache data.
 */

/** Tautulli server info (from get_tautulli_info) */
export interface TautulliInfo {
	tautulli_version: string;
}

/** Tautulli library section (from get_libraries) */
export interface TautulliLibrary {
	section_id: string;
	section_name: string;
	section_type: string; // "movie" | "show" | "artist"
	count: string;
}

/** Tautulli history item (from get_history) */
export interface TautulliHistoryItem {
	rating_key: string;
	parent_rating_key: string;
	grandparent_rating_key: string;
	title: string;
	grandparent_title: string;
	media_type: string; // "movie" | "episode"
	user: string;
	date: number; // Unix timestamp
	play_count?: number;
}

// ============================================================================
// Activity / Now Playing (F5)
// ============================================================================

export interface TautulliSession {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	mediaType: string;
	user: string;
	player: string;
	platform: string;
	product: string;
	state: "playing" | "paused" | "buffering";
	progressPercent: number;
	transcodeDecision: string;
	videoDecision: string;
	audioDecision: string;
	videoResolution: string;
	audioCodec: string;
	videoCodec: string;
	bandwidth: number;
	location: "lan" | "wan";
	thumb?: string;
	instanceId: string;
	instanceName: string;
}

export interface TautulliActivityResponse {
	sessions: TautulliSession[];
	streamCount: number;
	totalBandwidth: number;
	lanBandwidth: number;
	wanBandwidth: number;
}

// ============================================================================
// Statistics (F7)
// ============================================================================

export interface TautulliUserStat {
	userId: number;
	friendlyName: string;
	totalPlays: number;
	totalDuration: number;
}

export interface TautulliHomeStatRow {
	title: string;
	friendlyName?: string;
	totalPlays: number;
	totalDuration: number;
	platform?: string;
	thumb?: string;
}

export interface TautulliHomeStat {
	statId: string;
	statTitle: string;
	rows: TautulliHomeStatRow[];
}

export interface TautulliStatsResponse {
	homeStats: TautulliHomeStat[];
	userStats: TautulliUserStat[];
	timeRange: number;
}

export interface TautulliPlaysByDateSeries {
	name: string;
	data: number[];
}

export interface TautulliPlaysByDateResponse {
	categories: string[];
	series: TautulliPlaysByDateSeries[];
	timeRange: number;
}

export type TautulliHomeStatsResponse = Pick<TautulliStatsResponse, "homeStats">;

// ============================================================================
// Watch History (frontend-facing)
// ============================================================================

export interface TautulliWatchHistoryItem {
	title: string;
	grandparentTitle?: string;
	year?: number;
	mediaType: "movie" | "episode" | "track";
	watchedAt: string; // ISO date
	duration: number; // seconds
	watchedDuration: number; // seconds
	user: string;
	platform: string;
	player: string;
	completionPercent: number;
	ratingKey: string;
}

export interface TautulliWatchHistoryResponse {
	history: TautulliWatchHistoryItem[];
	totalCount: number;
}
