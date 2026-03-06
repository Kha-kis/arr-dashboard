/**
 * Plex React Query Hooks
 *
 * Custom hooks for Plex integration: watch enrichment, sections, scan, now playing,
 * episodes, and tag management.
 */

import type {
	BandwidthAnalytics,
	BandwidthForecast,
	CacheHealthResponse,
	CodecAnalytics,
	CollectionStats,
	DeviceAnalytics,
	LibraryItem,
	PlexAccountsResponse,
	PlexIdentityResponse,
	PlexNowPlayingResponse,
	PlexOnDeckResponse,
	PlexRecentlyAddedResponse,
	PlexScanResponse,
	PlexSectionsResponse,
	PlexTagUpdateRequest,
	QualityScoreAnalytics,
	SeriesProgressResponse,
	TranscodeAnalytics,
	UserAnalytics,
	UserEpisodeCompletion,
	WatchEnrichmentResponse,
	WatchHistoryResponse,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	fetchBandwidthAnalytics,
	fetchBandwidthForecast,
	fetchCacheHealth,
	fetchCodecAnalytics,
	fetchCollectionStats,
	fetchDeviceAnalytics,
	fetchEpisodeWatchStatus,
	fetchNowPlaying,
	fetchOnDeck,
	fetchPlexAccounts,
	fetchPlexCollections,
	fetchPlexIdentity,
	fetchPlexLabels,
	fetchPlexSections,
	fetchQualityScore,
	fetchRecentlyAdded,
	fetchSeriesProgress,
	fetchTranscodeAnalytics,
	fetchUserAnalytics,
	fetchUserEpisodeCompletion,
	fetchWatchEnrichment,
	fetchWatchHistory,
	triggerCacheRefresh,
	triggerPlexScan,
	updatePlexTag,
} from "../../lib/api-client/plex";

// ============================================================================
// Query Keys
// ============================================================================

export const plexKeys = {
	all: ["plex"] as const,
	watchEnrichment: (key: string) => ["plex", "watch-enrichment", key] as const,
	sections: () => ["plex", "sections"] as const,
	nowPlaying: () => ["plex", "now-playing"] as const,
	episodes: (instanceId: string, showTmdbId: number) =>
		["plex", "episodes", instanceId, showTmdbId] as const,
	tags: (instanceId: string) => ["plex", "tags", instanceId] as const,
	recentlyAdded: (limit: number) => ["plex", "recently-added", limit] as const,
	identity: () => ["plex", "identity"] as const,
	onDeck: () => ["plex", "on-deck"] as const,
	accounts: () => ["plex", "accounts"] as const,
	cacheHealth: () => ["plex", "cache-health"] as const,
	seriesProgress: (key: string) => ["plex", "series-progress", key] as const,
	transcodeAnalytics: (days: number) => ["plex", "transcode-analytics", days] as const,
	bandwidthAnalytics: (days: number) => ["plex", "bandwidth-analytics", days] as const,
	userAnalytics: (days: number) => ["plex", "user-analytics", days] as const,
	watchHistory: (days: number, limit: number) => ["plex", "watch-history", days, limit] as const,
	codecAnalytics: (days: number) => ["plex", "codec-analytics", days] as const,
	deviceAnalytics: (days: number) => ["plex", "device-analytics", days] as const,
	collectionStats: () => ["plex", "collection-stats"] as const,
	userEpisodeCompletion: (key: string) => ["plex", "user-episode-completion", key] as const,
	qualityScore: (days: number) => ["plex", "quality-score", days] as const,
	bandwidthForecast: (days: number) => ["plex", "bandwidth-forecast", days] as const,
};

// ============================================================================
// Watch Enrichment (F1)
// ============================================================================

/**
 * Hook to fetch Plex/Tautulli watch enrichment for current library page items.
 * Follows the same pattern as useLibraryEnrichment in useSeerr.ts.
 */
export const useWatchEnrichment = (items: LibraryItem[]) => {
	const enrichable = useMemo(() => {
		if (items.length === 0) return { tmdbIds: [], types: [], key: "" };

		const tmdbIds: number[] = [];
		const types: string[] = [];
		for (const item of items) {
			if (
				(item.service === "sonarr" || item.service === "radarr") &&
				item.remoteIds?.tmdbId
			) {
				tmdbIds.push(item.remoteIds.tmdbId);
				types.push(item.type === "movie" ? "movie" : "series");
			}
		}
		const key = tmdbIds.map((id, i) => `${types[i]}:${id}`).join(",");
		return { tmdbIds, types, key };
	}, [items]);

	return useQuery<WatchEnrichmentResponse>({
		queryKey: plexKeys.watchEnrichment(enrichable.key),
		queryFn: () => fetchWatchEnrichment(enrichable.tmdbIds, enrichable.types),
		staleTime: 5 * 60_000,
		enabled: enrichable.tmdbIds.length > 0,
	});
};

// ============================================================================
// Sections (F2)
// ============================================================================

export const usePlexSections = () => {
	return useQuery<PlexSectionsResponse>({
		queryKey: plexKeys.sections(),
		queryFn: fetchPlexSections,
		staleTime: 10 * 60_000,
	});
};

// ============================================================================
// Scan (F3)
// ============================================================================

export const usePlexScanMutation = () => {
	return useMutation<PlexScanResponse, Error, { instanceId: string; sectionId: string }>({
		mutationFn: ({ instanceId, sectionId }) => triggerPlexScan(instanceId, sectionId),
	});
};

// ============================================================================
// Now Playing (F4)
// ============================================================================

export const useNowPlaying = (enabled = true) => {
	return useQuery<PlexNowPlayingResponse>({
		queryKey: plexKeys.nowPlaying(),
		queryFn: fetchNowPlaying,
		refetchInterval: 15_000,
		enabled,
	});
};

// ============================================================================
// Episode Watch Status (F6)
// ============================================================================

export const useEpisodeWatchStatus = (
	instanceId: string | null | undefined,
	showTmdbId: number | null | undefined,
) => {
	return useQuery({
		queryKey: plexKeys.episodes(instanceId ?? "", showTmdbId ?? 0),
		queryFn: () => fetchEpisodeWatchStatus(instanceId!, showTmdbId!),
		staleTime: 5 * 60_000,
		enabled: !!instanceId && !!showTmdbId,
	});
};

// ============================================================================
// Tags / Collections (F8)
// ============================================================================

export const usePlexTags = (instanceId: string | null | undefined) => {
	return useQuery({
		queryKey: plexKeys.tags(instanceId ?? ""),
		queryFn: async () => {
			const [collections, labels] = await Promise.all([
				fetchPlexCollections(instanceId!),
				fetchPlexLabels(instanceId!),
			]);
			return {
				collections: collections.collections,
				labels: labels.labels,
			};
		},
		staleTime: 5 * 60_000,
		enabled: !!instanceId,
	});
};

export const usePlexTagMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { instanceId: string; ratingKey: string; update: PlexTagUpdateRequest }>({
		mutationFn: ({ instanceId, ratingKey, update }) =>
			updatePlexTag(instanceId, ratingKey, update),
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({ queryKey: plexKeys.tags(variables.instanceId) });
		},
	});
};

// ============================================================================
// Recently Added (Phase 1 - F1)
// ============================================================================

export const useRecentlyAdded = (limit = 20, enabled = true) => {
	return useQuery<PlexRecentlyAddedResponse>({
		queryKey: plexKeys.recentlyAdded(limit),
		queryFn: () => fetchRecentlyAdded(limit),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Server Identity (Phase 1 - F7)
// ============================================================================

export const usePlexIdentity = (enabled = true) => {
	return useQuery<PlexIdentityResponse>({
		queryKey: plexKeys.identity(),
		queryFn: fetchPlexIdentity,
		staleTime: 10 * 60_000,
		enabled,
	});
};

// ============================================================================
// On Deck (Phase 1 - F8)
// ============================================================================

export const useOnDeck = (enabled = true) => {
	return useQuery<PlexOnDeckResponse>({
		queryKey: plexKeys.onDeck(),
		queryFn: fetchOnDeck,
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Plex Accounts (Phase 2 - F2)
// ============================================================================

export const usePlexAccounts = (enabled = true) => {
	return useQuery<PlexAccountsResponse>({
		queryKey: plexKeys.accounts(),
		queryFn: fetchPlexAccounts,
		staleTime: 10 * 60_000,
		enabled,
	});
};

// ============================================================================
// Cache Health (Phase 2 - F3)
// ============================================================================

export const useCacheHealth = (enabled = true) => {
	return useQuery<CacheHealthResponse>({
		queryKey: plexKeys.cacheHealth(),
		queryFn: fetchCacheHealth,
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useCacheRefreshMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		{ success: boolean; upserted: number; errors: number },
		Error,
		{ instanceId: string }
	>({
		mutationFn: ({ instanceId }) => triggerCacheRefresh(instanceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: plexKeys.cacheHealth() });
		},
	});
};

// ============================================================================
// Series Progress (Phase 2 - F5)
// ============================================================================

export const useSeriesProgress = (tmdbIds: number[], enabled = true) => {
	const key = useMemo(() => [...tmdbIds].sort().join(","), [tmdbIds]);

	return useQuery<SeriesProgressResponse>({
		queryKey: plexKeys.seriesProgress(key),
		queryFn: () => fetchSeriesProgress(tmdbIds),
		staleTime: 5 * 60_000,
		enabled: enabled && tmdbIds.length > 0,
	});
};

// ============================================================================
// Transcode Analytics (Phase 3 - F4)
// ============================================================================

export const useTranscodeAnalytics = (days = 30, enabled = true) => {
	return useQuery<TranscodeAnalytics>({
		queryKey: plexKeys.transcodeAnalytics(days),
		queryFn: () => fetchTranscodeAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Bandwidth Analytics (Phase 3 - F6)
// ============================================================================

export const useBandwidthAnalytics = (days = 30, enabled = true) => {
	return useQuery<BandwidthAnalytics>({
		queryKey: plexKeys.bandwidthAnalytics(days),
		queryFn: () => fetchBandwidthAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// User Analytics (Tier 1)
// ============================================================================

export const useUserAnalytics = (days = 30, enabled = true) => {
	return useQuery<UserAnalytics>({
		queryKey: plexKeys.userAnalytics(days),
		queryFn: () => fetchUserAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Watch History (Tier 1)
// ============================================================================

export const useWatchHistory = (days = 7, limit = 50, enabled = true) => {
	return useQuery<WatchHistoryResponse>({
		queryKey: plexKeys.watchHistory(days, limit),
		queryFn: () => fetchWatchHistory(days, limit),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Codec/Resolution Analytics (Tier 1/2)
// ============================================================================

export const useCodecAnalytics = (days = 30, enabled = true) => {
	return useQuery<CodecAnalytics>({
		queryKey: plexKeys.codecAnalytics(days),
		queryFn: () => fetchCodecAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Device/Platform Analytics (Tier 2)
// ============================================================================

export const useDeviceAnalytics = (days = 30, enabled = true) => {
	return useQuery<DeviceAnalytics>({
		queryKey: plexKeys.deviceAnalytics(days),
		queryFn: () => fetchDeviceAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Collection/Label Statistics (Tier 2)
// ============================================================================

export const useCollectionStats = (enabled = true) => {
	return useQuery<CollectionStats>({
		queryKey: plexKeys.collectionStats(),
		queryFn: fetchCollectionStats,
		staleTime: 10 * 60_000,
		enabled,
	});
};

// ============================================================================
// Per-User Episode Completion (Tier 2)
// ============================================================================

export const useUserEpisodeCompletion = (tmdbIds: number[], enabled = true) => {
	const key = useMemo(() => [...tmdbIds].sort().join(","), [tmdbIds]);

	return useQuery<UserEpisodeCompletion>({
		queryKey: plexKeys.userEpisodeCompletion(key),
		queryFn: () => fetchUserEpisodeCompletion(tmdbIds),
		staleTime: 5 * 60_000,
		enabled: enabled && tmdbIds.length > 0,
	});
};

// ============================================================================
// Quality Score (Tier 3)
// ============================================================================

export const useQualityScore = (days = 30, enabled = true) => {
	return useQuery<QualityScoreAnalytics>({
		queryKey: plexKeys.qualityScore(days),
		queryFn: () => fetchQualityScore(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Bandwidth Forecast (Tier 3)
// ============================================================================

export const useBandwidthForecast = (days = 30, enabled = true) => {
	return useQuery<BandwidthForecast>({
		queryKey: plexKeys.bandwidthForecast(days),
		queryFn: () => fetchBandwidthForecast(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};
