/**
 * Jellyfin API Client
 *
 * Frontend API functions for Jellyfin integration endpoints.
 * All requests are proxied through Next.js rewrites -> Fastify backend.
 */

import type {
	BandwidthAnalytics,
	BandwidthForecast,
	CacheHealthResponse,
	CodecAnalytics,
	DeviceAnalytics,
	JellyfinNowPlayingResponse,
	MostConcurrentResponse,
	QualityScoreAnalytics,
	SeriesProgressResponse,
	TopMediaResponse,
	TopMediaType,
	TranscodeAnalytics,
	UserAnalytics,
	UserEpisodeCompletion,
	WatchEnrichmentResponse,
	WatchHistoryResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Jellyfin-specific response types
// ============================================================================

export interface JellyfinServerIdentity {
	instanceId: string;
	instanceName: string;
	serverId: string;
	version: string;
	serverName: string;
	operatingSystem: string;
	baseUrl: string;
	service: "jellyfin" | "emby";
}

/** Identity route returns a flat array (not wrapped in { servers }) */
export type JellyfinIdentityResponse = JellyfinServerIdentity[];

export interface JellyfinSection {
	libraryId: string;
	libraryName: string;
	mediaType: string;
	instanceId: string;
	instanceName: string;
}

export interface JellyfinSectionsResponse {
	sections: JellyfinSection[];
}

export interface JellyfinOnDeckItem {
	tmdbId: number;
	title: string;
	mediaType: string;
	libraryName: string;
	instanceId: string;
	instanceName: string;
	jellyfinId: string | null;
	thumb: string | null;
}

export interface JellyfinOnDeckResponse {
	items: JellyfinOnDeckItem[];
}

export interface JellyfinRecentlyAddedItem {
	tmdbId: number;
	title: string;
	mediaType: string;
	libraryName: string;
	addedAt: string | null;
	jellyfinId: string | null;
	thumb: string | null;
	instanceId: string;
	instanceName: string;
}

export interface JellyfinRecentlyAddedResponse {
	items: JellyfinRecentlyAddedItem[];
}

export interface JellyfinEpisodeStatus {
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	watched: boolean;
	watchedByUsers: string[];
	lastWatchedAt: string | null;
}

export interface JellyfinEpisodeStatusResponse {
	showTmdbId: number;
	episodes: JellyfinEpisodeStatus[];
}

export interface JellyfinAccountsResponse {
	users: string[];
}

// ============================================================================
// Server Identity
// ============================================================================

/** Fetch Jellyfin server identity (name, version, OS). */
export async function fetchJellyfinIdentity(): Promise<JellyfinIdentityResponse> {
	return apiRequest("/api/jellyfin/identity");
}

// ============================================================================
// Library Sections
// ============================================================================

/** Fetch distinct Jellyfin library sections from cache. */
export async function fetchJellyfinSections(): Promise<JellyfinSectionsResponse> {
	return apiRequest("/api/jellyfin/sections");
}

// ============================================================================
// Watch Enrichment
// ============================================================================

/** Fetch watch enrichment data for library items from Jellyfin cache. */
export async function fetchJellyfinWatchEnrichment(
	tmdbIds: number[],
	types: string[],
): Promise<WatchEnrichmentResponse> {
	const params = new URLSearchParams({
		tmdbIds: tmdbIds.join(","),
		types: types.join(","),
	});
	return apiRequest(`/api/jellyfin/watch-enrichment?${params.toString()}`);
}

// ============================================================================
// Now Playing / Sessions
// ============================================================================

/** Fetch active Jellyfin sessions (now playing) across all instances. */
export async function fetchJellyfinNowPlaying(): Promise<JellyfinNowPlayingResponse> {
	return apiRequest("/api/jellyfin/now-playing");
}

// ============================================================================
// On Deck / Continue Watching
// ============================================================================

/** Fetch Jellyfin "Continue Watching" items. */
export async function fetchJellyfinOnDeck(): Promise<JellyfinOnDeckResponse> {
	return apiRequest("/api/jellyfin/on-deck");
}

// ============================================================================
// Recently Added
// ============================================================================

/** Fetch recently added items from Jellyfin library cache. */
export async function fetchJellyfinRecentlyAdded(
	limit = 20,
): Promise<JellyfinRecentlyAddedResponse> {
	return apiRequest(`/api/jellyfin/recently-added?limit=${limit}`);
}

// ============================================================================
// Episode Watch Status
// ============================================================================

/** Fetch episode watch status for a show from Jellyfin. */
export async function fetchJellyfinEpisodeWatchStatus(
	instanceId: string,
	showTmdbId: number,
): Promise<JellyfinEpisodeStatusResponse> {
	return apiRequest(`/api/jellyfin/episodes?instanceId=${instanceId}&showTmdbId=${showTmdbId}`);
}

// ============================================================================
// User Accounts
// ============================================================================

/** Fetch Jellyfin user accounts. */
export async function fetchJellyfinAccounts(): Promise<JellyfinAccountsResponse> {
	return apiRequest("/api/jellyfin/accounts");
}

// ============================================================================
// Cache Health
// ============================================================================

/** Fetch cache refresh health status for all Jellyfin instances. */
export async function fetchJellyfinCacheHealth(): Promise<CacheHealthResponse> {
	return apiRequest("/api/jellyfin/cache/health");
}

/** Trigger a manual cache refresh for a specific Jellyfin instance. */
export async function triggerJellyfinCacheRefresh(
	instanceId: string,
): Promise<{ success: boolean; upserted: number; errors: number }> {
	return apiRequest(`/api/jellyfin/cache/${instanceId}/refresh`, { method: "POST" });
}

// ============================================================================
// Library Scan
// ============================================================================

/** Trigger a Jellyfin library scan for a specific instance. */
export async function triggerJellyfinScan(
	instanceId: string,
): Promise<{ success: boolean; message: string }> {
	return apiRequest(`/api/jellyfin/${instanceId}/refresh`, { method: "POST" });
}

// ============================================================================
// Analytics
// ============================================================================

export async function fetchJellyfinTranscodeAnalytics(days = 30): Promise<TranscodeAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/transcode?days=${days}`);
}

export async function fetchJellyfinBandwidthAnalytics(days = 30): Promise<BandwidthAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/bandwidth?days=${days}`);
}

export async function fetchJellyfinUserAnalytics(days = 30): Promise<UserAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/users?days=${days}`);
}

export async function fetchJellyfinWatchHistory(
	days = 7,
	limit = 50,
): Promise<WatchHistoryResponse> {
	return apiRequest(`/api/jellyfin/analytics/history?days=${days}&limit=${limit}`);
}

export async function fetchJellyfinCodecAnalytics(days = 30): Promise<CodecAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/codec?days=${days}`);
}

export async function fetchJellyfinDeviceAnalytics(days = 30): Promise<DeviceAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/devices?days=${days}`);
}

export async function fetchJellyfinQualityScore(days = 30): Promise<QualityScoreAnalytics> {
	return apiRequest(`/api/jellyfin/analytics/quality-score?days=${days}`);
}

export async function fetchJellyfinBandwidthForecast(days = 30): Promise<BandwidthForecast> {
	return apiRequest(`/api/jellyfin/analytics/forecast?days=${days}`);
}

export async function fetchJellyfinSeriesProgress(
	tmdbIds: number[],
): Promise<SeriesProgressResponse> {
	return apiRequest(`/api/jellyfin/series-progress?tmdbIds=${tmdbIds.join(",")}`);
}

export async function fetchJellyfinUserEpisodeCompletion(
	tmdbIds: number[],
): Promise<UserEpisodeCompletion> {
	return apiRequest(`/api/jellyfin/analytics/episode-completion?tmdbIds=${tmdbIds.join(",")}`);
}

export async function fetchJellyfinTopMedia(
	mediaType: TopMediaType,
	days = 30,
	limit = 10,
): Promise<TopMediaResponse> {
	return apiRequest(
		`/api/jellyfin/analytics/top-media?mediaType=${mediaType}&days=${days}&limit=${limit}`,
	);
}

export async function fetchJellyfinPopularMedia(
	mediaType: TopMediaType,
	days = 30,
	limit = 10,
): Promise<TopMediaResponse> {
	return apiRequest(
		`/api/jellyfin/analytics/popular-media?mediaType=${mediaType}&days=${days}&limit=${limit}`,
	);
}

export async function fetchJellyfinLastWatched(
	mediaType: TopMediaType,
	days = 30,
	limit = 10,
): Promise<TopMediaResponse> {
	return apiRequest(
		`/api/jellyfin/analytics/last-watched?mediaType=${mediaType}&days=${days}&limit=${limit}`,
	);
}

export async function fetchJellyfinMostConcurrent(
	days = 30,
	limit = 5,
): Promise<MostConcurrentResponse> {
	return apiRequest(`/api/jellyfin/analytics/most-concurrent?days=${days}&limit=${limit}`);
}
