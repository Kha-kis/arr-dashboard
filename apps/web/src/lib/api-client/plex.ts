/**
 * Plex API Client
 *
 * Frontend API functions for Plex integration endpoints.
 * All requests are proxied through Next.js rewrites → Fastify backend.
 */

import type {
	BandwidthAnalytics,
	BandwidthForecast,
	CacheHealthResponse,
	CodecAnalytics,
	CollectionStats,
	DeviceAnalytics,
	PlexAccountsResponse,
	PlexEpisodeStatusResponse,
	PlexIdentityResponse,
	PlexNowPlayingResponse,
	PlexOnDeckResponse,
	PlexRecentlyAddedResponse,
	PlexScanResponse,
	PlexSectionsResponse,
	PlexTagsResponse,
	PlexTagUpdateRequest,
	QualityScoreAnalytics,
	SeriesProgressResponse,
	TranscodeAnalytics,
	UserAnalytics,
	UserEpisodeCompletion,
	WatchEnrichmentResponse,
	WatchHistoryResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Fetch watch enrichment data for library items from PlexCache + TautulliCache.
 */
export async function fetchWatchEnrichment(
	tmdbIds: number[],
	types: string[],
): Promise<WatchEnrichmentResponse> {
	const params = new URLSearchParams({
		tmdbIds: tmdbIds.join(","),
		types: types.join(","),
	});
	return apiRequest(`/api/plex/watch-enrichment?${params.toString()}`);
}

/**
 * Fetch distinct Plex library sections from cache.
 */
export async function fetchPlexSections(): Promise<PlexSectionsResponse> {
	return apiRequest("/api/plex/sections");
}

/**
 * Trigger a Plex library section scan.
 */
export async function triggerPlexScan(
	instanceId: string,
	sectionId: string,
): Promise<PlexScanResponse> {
	return apiRequest(`/api/plex/${instanceId}/sections/${sectionId}/refresh`, {
		method: "POST",
	});
}

/**
 * Fetch currently active Plex sessions (Now Playing).
 */
export async function fetchNowPlaying(): Promise<PlexNowPlayingResponse> {
	return apiRequest("/api/plex/now-playing");
}

/**
 * Fetch episode watch status for a show.
 */
export async function fetchEpisodeWatchStatus(
	instanceId: string,
	showTmdbId: number,
): Promise<PlexEpisodeStatusResponse> {
	return apiRequest(`/api/plex/episodes?instanceId=${instanceId}&showTmdbId=${showTmdbId}`);
}

/**
 * Fetch collections for a Plex instance.
 */
export async function fetchPlexCollections(instanceId: string): Promise<PlexTagsResponse> {
	return apiRequest(`/api/plex/${instanceId}/collections`);
}

/**
 * Fetch labels for a Plex instance.
 */
export async function fetchPlexLabels(instanceId: string): Promise<PlexTagsResponse> {
	return apiRequest(`/api/plex/${instanceId}/labels`);
}

/**
 * Add or remove a collection/label from a Plex item.
 */
export async function updatePlexTag(
	instanceId: string,
	ratingKey: string,
	update: PlexTagUpdateRequest,
): Promise<void> {
	return apiRequest(`/api/plex/${instanceId}/items/${ratingKey}/tags`, {
		json: update,
	});
}

// ============================================================================
// Recently Added (Phase 1)
// ============================================================================

/** Fetch recently added items from Plex library cache. */
export async function fetchRecentlyAdded(limit = 20): Promise<PlexRecentlyAddedResponse> {
	return apiRequest(`/api/plex/recently-added?limit=${limit}`);
}

// ============================================================================
// Server Identity (Phase 1)
// ============================================================================

/** Fetch Plex server identity (name, version, platform). */
export async function fetchPlexIdentity(): Promise<PlexIdentityResponse> {
	return apiRequest("/api/plex/identity");
}

// ============================================================================
// On Deck (Phase 1)
// ============================================================================

/** Fetch Plex "On Deck" (continue watching) items. */
export async function fetchOnDeck(): Promise<PlexOnDeckResponse> {
	return apiRequest("/api/plex/on-deck");
}

// ============================================================================
// Plex Accounts (Phase 2)
// ============================================================================

/** Fetch Plex managed/shared user accounts. */
export async function fetchPlexAccounts(): Promise<PlexAccountsResponse> {
	return apiRequest("/api/plex/accounts");
}

// ============================================================================
// Cache Health (Phase 2)
// ============================================================================

/** Fetch cache refresh health status for all Plex/Tautulli instances. */
export async function fetchCacheHealth(): Promise<CacheHealthResponse> {
	return apiRequest("/api/plex/cache/health");
}

/** Trigger a manual cache refresh for a specific Plex instance. */
export async function triggerCacheRefresh(
	instanceId: string,
): Promise<{ success: boolean; upserted: number; errors: number }> {
	return apiRequest(`/api/plex/cache/${instanceId}/refresh`, { method: "POST" });
}

// ============================================================================
// Series Progress (Phase 2)
// ============================================================================

/** Fetch per-series watched/total episode progress from PlexEpisodeCache. */
export async function fetchSeriesProgress(tmdbIds: number[]): Promise<SeriesProgressResponse> {
	const params = new URLSearchParams({ tmdbIds: tmdbIds.join(",") });
	return apiRequest(`/api/plex/series-progress?${params.toString()}`);
}

// ============================================================================
// Transcode Analytics (Phase 3)
// ============================================================================

/** Fetch transcode decision analytics from SessionSnapshot data. */
export async function fetchTranscodeAnalytics(days = 30): Promise<TranscodeAnalytics> {
	return apiRequest(`/api/plex/analytics/transcode?days=${days}`);
}

// ============================================================================
// Bandwidth Analytics (Phase 3)
// ============================================================================

/** Fetch bandwidth analytics (LAN/WAN) from SessionSnapshot data. */
export async function fetchBandwidthAnalytics(days = 30): Promise<BandwidthAnalytics> {
	return apiRequest(`/api/plex/analytics/bandwidth?days=${days}`);
}

// ============================================================================
// User Analytics (Tier 1)
// ============================================================================

/** Fetch per-user analytics from SessionSnapshot data. */
export async function fetchUserAnalytics(days = 30): Promise<UserAnalytics> {
	return apiRequest(`/api/plex/analytics/users?days=${days}`);
}

// ============================================================================
// Watch History (Tier 1)
// ============================================================================

/** Fetch deduplicated watch history timeline. */
export async function fetchWatchHistory(days = 7, limit = 50): Promise<WatchHistoryResponse> {
	return apiRequest(`/api/plex/analytics/history?days=${days}&limit=${limit}`);
}

// ============================================================================
// Codec/Resolution Analytics (Tier 1/2)
// ============================================================================

/** Fetch video/audio codec and resolution distributions. */
export async function fetchCodecAnalytics(days = 30): Promise<CodecAnalytics> {
	return apiRequest(`/api/plex/analytics/codec?days=${days}`);
}

// ============================================================================
// Device/Platform Analytics (Tier 2)
// ============================================================================

/** Fetch platform and player distributions. */
export async function fetchDeviceAnalytics(days = 30): Promise<DeviceAnalytics> {
	return apiRequest(`/api/plex/analytics/devices?days=${days}`);
}

// ============================================================================
// Collection/Label Statistics (Tier 2)
// ============================================================================

/** Fetch collection and label item counts with watched percentages. */
export async function fetchCollectionStats(): Promise<CollectionStats> {
	return apiRequest("/api/plex/analytics/collections");
}

// ============================================================================
// Per-User Episode Completion (Tier 2)
// ============================================================================

/** Fetch per-user episode completion for specified shows. */
export async function fetchUserEpisodeCompletion(
	tmdbIds: number[],
): Promise<UserEpisodeCompletion> {
	return apiRequest(`/api/plex/analytics/episode-completion?tmdbIds=${tmdbIds.join(",")}`);
}

// ============================================================================
// Quality Score (Tier 3)
// ============================================================================

/** Fetch stream quality score analytics. */
export async function fetchQualityScore(days = 30): Promise<QualityScoreAnalytics> {
	return apiRequest(`/api/plex/analytics/quality-score?days=${days}`);
}

// ============================================================================
// Bandwidth Forecast (Tier 3)
// ============================================================================

/** Fetch bandwidth forecast with linear regression projections. */
export async function fetchBandwidthForecast(days = 30): Promise<BandwidthForecast> {
	return apiRequest(`/api/plex/analytics/forecast?days=${days}`);
}
