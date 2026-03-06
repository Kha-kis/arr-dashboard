/**
 * Plex Shared Types
 *
 * Types for Plex integration — watch enrichment, sessions, sections, episodes, collections.
 */

// ============================================================================
// Watch Enrichment (F1)
// ============================================================================

export interface WatchEnrichmentItem {
	lastWatchedAt: string | null;
	watchCount: number;
	watchedByUsers: string[];
	onDeck: boolean;
	userRating: number | null;
	source: "plex" | "tautulli" | "both";
	/** Plex ratingKey for write-back operations (null if not available) */
	ratingKey: string | null;
	/** Instance ID of the Plex instance this item belongs to */
	instanceId: string | null;
	/** Plex collections this item belongs to */
	collections: string[];
	/** Plex labels applied to this item */
	labels: string[];
}

export interface WatchEnrichmentResponse {
	items: Record<string, WatchEnrichmentItem>;
}

// ============================================================================
// Sections (F2)
// ============================================================================

export interface PlexSection {
	sectionId: string;
	sectionTitle: string;
	mediaType: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexSectionsResponse {
	sections: PlexSection[];
}

// ============================================================================
// Now Playing / Sessions (F4)
// ============================================================================

export interface PlexSessionPlayer {
	title: string;
	platform: string;
	product: string;
	state: string;
}

export interface PlexSessionUser {
	id: number;
	title: string;
	thumb?: string;
}

export interface PlexSession {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	type: string;
	user: PlexSessionUser;
	player: PlexSessionPlayer;
	state: "playing" | "paused" | "buffering";
	viewOffset: number;
	duration: number;
	videoDecision: string;
	audioDecision: string;
	bandwidth?: number;
	thumb?: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexNowPlayingResponse {
	sessions: PlexSession[];
	totalBandwidth: number;
}

// ============================================================================
// Episode Watch Status (F6)
// ============================================================================

export interface PlexEpisodeStatus {
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	watched: boolean;
	watchedByUsers: string[];
	lastWatchedAt: string | null;
}

export interface PlexEpisodeStatusResponse {
	showTmdbId: number;
	episodes: PlexEpisodeStatus[];
}

// ============================================================================
// Collections & Labels (F8)
// ============================================================================

export interface PlexTagItem {
	name: string;
	count: number;
}

export interface PlexTagsResponse {
	collections: PlexTagItem[];
	labels: PlexTagItem[];
}

export interface PlexTagUpdateRequest {
	type: "collection" | "label";
	action: "add" | "remove";
	name: string;
}

// ============================================================================
// Scan (F3)
// ============================================================================

export interface PlexScanResponse {
	success: boolean;
	message: string;
}

// ============================================================================
// Recently Added (F9)
// ============================================================================

export interface PlexRecentlyAddedItem {
	tmdbId: number;
	title: string;
	mediaType: "movie" | "show" | "episode" | string;
	sectionTitle: string;
	addedAt: string;
	ratingKey: string | null;
	instanceId: string;
	instanceName: string;
}

export interface PlexRecentlyAddedResponse {
	items: PlexRecentlyAddedItem[];
}

// ============================================================================
// Server Identity (F10)
// ============================================================================

export interface PlexServerIdentity {
	instanceId: string;
	instanceName: string;
	machineId: string;
	version: string;
	friendlyName: string;
	platform: string;
}

export interface PlexIdentityResponse {
	servers: PlexServerIdentity[];
}

// ============================================================================
// On Deck / Continue Watching (F11)
// ============================================================================

export interface PlexOnDeckItem {
	tmdbId: number;
	title: string;
	mediaType: "movie" | "show" | "episode" | string;
	sectionTitle: string;
	instanceId: string;
	instanceName: string;
	ratingKey: string | null;
}

export interface PlexOnDeckResponse {
	items: PlexOnDeckItem[];
}

// ============================================================================
// Plex Accounts (F12)
// ============================================================================

export interface PlexAccountsResponse {
	users: string[];
}

// ============================================================================
// Cache Health (F13)
// ============================================================================

export interface CacheHealthItem {
	instanceId: string;
	instanceName: string;
	cacheType: "plex" | "tautulli" | "plex_episode";
	lastRefreshedAt: string;
	lastResult: "success" | "error";
	lastErrorMessage: string | null;
	itemCount: number;
	isStale: boolean;
}

export interface CacheHealthResponse {
	items: CacheHealthItem[];
}

// ============================================================================
// Series Progress (F14)
// ============================================================================

export interface SeriesProgressItem {
	total: number;
	watched: number;
	percent: number;
}

export interface SeriesProgressResponse {
	progress: Record<number, SeriesProgressItem>;
}

// ============================================================================
// Transcode Analytics (F15)
// ============================================================================

export interface TranscodeAnalytics {
	directPlay: number;
	transcode: number;
	directStream: number;
	totalSessions: number;
	dailyBreakdown: Array<{
		date: string;
		directPlay: number;
		transcode: number;
		directStream: number;
	}>;
}

// ============================================================================
// Bandwidth Analytics (F16)
// ============================================================================

export interface BandwidthAnalytics {
	peakConcurrent: number;
	peakBandwidth: number;
	avgBandwidth: number;
	timeSeries: Array<{
		date: string;
		concurrent: number;
		bandwidth: number;
		lanBandwidth: number;
		wanBandwidth: number;
	}>;
}

// ============================================================================
// User Analytics (Tier 1)
// ============================================================================

export interface UserAnalytics {
	users: Array<{
		username: string;
		totalSessions: number;
		totalBandwidth: number;
		estimatedWatchTimeMinutes: number;
		mostRecentActivity: string;
	}>;
	dailyBreakdown: Array<{
		date: string;
		userSessions: Record<string, number>;
	}>;
}

// ============================================================================
// Watch History (Tier 1)
// ============================================================================

export interface WatchHistoryEvent {
	user: string;
	title: string;
	timestamp: string;
	platform: string | null;
	videoDecision: string | null;
}

export interface WatchHistoryResponse {
	events: WatchHistoryEvent[];
}

// ============================================================================
// Codec/Resolution Analytics (Tier 1 / Tier 2)
// ============================================================================

export interface CodecAnalytics {
	videoCodecs: Array<{ codec: string; count: number; percent: number }>;
	audioCodecs: Array<{ codec: string; count: number; percent: number }>;
	resolutions: Array<{ resolution: string; count: number; percent: number }>;
	totalSessions: number;
}

// ============================================================================
// Device/Platform Analytics (Tier 2)
// ============================================================================

export interface DeviceAnalytics {
	platforms: Array<{ platform: string; sessions: number; percent: number }>;
	players: Array<{ player: string; platform: string; sessions: number }>;
	totalSessions: number;
}

// ============================================================================
// Collection/Label Statistics (Tier 2)
// ============================================================================

export interface CollectionStats {
	collections: Array<{
		name: string;
		totalItems: number;
		watchedItems: number;
		watchPercent: number;
	}>;
	labels: Array<{
		name: string;
		totalItems: number;
		watchedItems: number;
		watchPercent: number;
	}>;
}

// ============================================================================
// Per-User Episode Completion (Tier 2)
// ============================================================================

export interface UserEpisodeCompletion {
	shows: Array<{
		tmdbId: number;
		users: Array<{
			username: string;
			watched: number;
			total: number;
			percent: number;
		}>;
	}>;
}

// ============================================================================
// Quality Score (Tier 3)
// ============================================================================

export interface QualityScoreAnalytics {
	overallScore: number;
	breakdown: {
		directPlayScore: number;
		resolutionScore: number;
		transcodeScore: number;
	};
	trend: Array<{ date: string; score: number }>;
	perUser: Array<{ username: string; score: number; sessions: number }>;
}

// ============================================================================
// Bandwidth Forecast (Tier 3)
// ============================================================================

export interface BandwidthForecast {
	historicalDaily: Array<{ date: string; avgBandwidth: number; peakBandwidth: number }>;
	forecast: Array<{ date: string; predictedPeak: number }>;
	peakHours: Array<{ hour: number; avgConcurrent: number; avgBandwidth: number }>;
	trend: "increasing" | "stable" | "decreasing";
}
