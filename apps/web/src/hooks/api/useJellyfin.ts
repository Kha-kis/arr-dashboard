/**
 * Jellyfin React Query Hooks
 *
 * Custom hooks for Jellyfin integration: watch enrichment, sections, scan,
 * on deck, episodes, accounts, and cache management.
 */

import type {
	BandwidthAnalytics,
	BandwidthForecast,
	CacheHealthResponse,
	CodecAnalytics,
	DeviceAnalytics,
	JellyfinNowPlayingResponse,
	LibraryItem,
	QualityScoreAnalytics,
	SeriesProgressResponse,
	TranscodeAnalytics,
	UserAnalytics,
	UserEpisodeCompletion,
	WatchEnrichmentResponse,
	WatchHistoryResponse,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { POLLING_BACKGROUND, POLLING_REALTIME } from "../../lib/polling-intervals";
import { useEnrichableItems } from "../useEnrichableItems";
import type {
	JellyfinAccountsResponse,
	JellyfinEpisodeStatusResponse,
	JellyfinIdentityResponse,
	JellyfinOnDeckResponse,
	JellyfinRecentlyAddedResponse,
	JellyfinSectionsResponse,
} from "../../lib/api-client/jellyfin";
import {
	fetchJellyfinAccounts,
	fetchJellyfinBandwidthAnalytics,
	fetchJellyfinCacheHealth,
	fetchJellyfinCodecAnalytics,
	fetchJellyfinDeviceAnalytics,
	fetchJellyfinEpisodeWatchStatus,
	fetchJellyfinIdentity,
	fetchJellyfinNowPlaying,
	fetchJellyfinOnDeck,
	fetchJellyfinRecentlyAdded,
	fetchJellyfinSections,
	fetchJellyfinTranscodeAnalytics,
	fetchJellyfinUserAnalytics,
	fetchJellyfinWatchEnrichment,
	fetchJellyfinWatchHistory,
	fetchJellyfinQualityScore,
	fetchJellyfinBandwidthForecast,
	fetchJellyfinSeriesProgress,
	fetchJellyfinUserEpisodeCompletion,
	triggerJellyfinCacheRefresh,
	triggerJellyfinScan,
} from "../../lib/api-client/jellyfin";
import { jellyfinKeys } from "../../lib/query-keys";

// ============================================================================
// Server Identity
// ============================================================================

export const useJellyfinIdentity = (enabled = true) => {
	return useQuery<JellyfinIdentityResponse>({
		queryKey: jellyfinKeys.identity(),
		queryFn: fetchJellyfinIdentity,
		staleTime: 10 * 60_000,
		enabled,
	});
};

// ============================================================================
// Now Playing / Sessions
// ============================================================================

export const useJellyfinNowPlaying = (enabled = true, refetchInterval = POLLING_REALTIME) => {
	return useQuery<JellyfinNowPlayingResponse>({
		queryKey: jellyfinKeys.nowPlaying(),
		queryFn: fetchJellyfinNowPlaying,
		refetchInterval,
		enabled,
	});
};

// ============================================================================
// Library Sections
// ============================================================================

export const useJellyfinSections = () => {
	return useQuery<JellyfinSectionsResponse>({
		queryKey: jellyfinKeys.sections(),
		queryFn: fetchJellyfinSections,
		staleTime: 10 * 60_000,
	});
};

// ============================================================================
// Watch Enrichment
// ============================================================================

export const useJellyfinWatchEnrichment = (items: LibraryItem[]) => {
	const enrichable = useEnrichableItems(items, { movie: "movie", series: "series" });

	return useQuery<WatchEnrichmentResponse>({
		queryKey: jellyfinKeys.watchEnrichment(enrichable.key),
		queryFn: () => fetchJellyfinWatchEnrichment(enrichable.tmdbIds, enrichable.types),
		staleTime: 5 * 60_000,
		enabled: enrichable.hasItems,
	});
};

// ============================================================================
// On Deck / Continue Watching
// ============================================================================

export const useJellyfinOnDeck = (enabled = true) => {
	return useQuery<JellyfinOnDeckResponse>({
		queryKey: jellyfinKeys.onDeck(),
		queryFn: fetchJellyfinOnDeck,
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Recently Added
// ============================================================================

export const useJellyfinRecentlyAdded = (limit = 20, enabled = true) => {
	return useQuery<JellyfinRecentlyAddedResponse>({
		queryKey: jellyfinKeys.recentlyAdded(limit),
		queryFn: () => fetchJellyfinRecentlyAdded(limit),
		staleTime: 5 * 60_000,
		enabled,
	});
};

// ============================================================================
// Episode Watch Status
// ============================================================================

export const useJellyfinEpisodeWatchStatus = (
	instanceId: string | null | undefined,
	showTmdbId: number | null | undefined,
) => {
	return useQuery<JellyfinEpisodeStatusResponse>({
		queryKey: jellyfinKeys.episodes(instanceId ?? "", showTmdbId ?? 0),
		queryFn: () => fetchJellyfinEpisodeWatchStatus(instanceId!, showTmdbId!),
		staleTime: 5 * 60_000,
		enabled: !!instanceId && !!showTmdbId,
	});
};

// ============================================================================
// User Accounts
// ============================================================================

export const useJellyfinAccounts = (enabled = true) => {
	return useQuery<JellyfinAccountsResponse>({
		queryKey: jellyfinKeys.accounts(),
		queryFn: fetchJellyfinAccounts,
		staleTime: 10 * 60_000,
		enabled,
	});
};

// ============================================================================
// Cache Health
// ============================================================================

export const useJellyfinCacheHealth = (enabled = true) => {
	return useQuery<CacheHealthResponse>({
		queryKey: jellyfinKeys.cacheHealth(),
		queryFn: fetchJellyfinCacheHealth,
		staleTime: 5 * 60_000,
		refetchInterval: POLLING_BACKGROUND,
		enabled,
	});
};

// ============================================================================
// Cache Refresh Mutation
// ============================================================================

export const useJellyfinCacheRefreshMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		{ success: boolean; upserted: number; errors: number },
		Error,
		{ instanceId: string }
	>({
		mutationFn: ({ instanceId }) => triggerJellyfinCacheRefresh(instanceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: jellyfinKeys.cacheHealth() });
		},
	});
};

// ============================================================================
// Library Scan Mutation
// ============================================================================

export const useJellyfinScanMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<{ success: boolean; message: string }, Error, { instanceId: string }>({
		mutationFn: ({ instanceId }) => triggerJellyfinScan(instanceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: jellyfinKeys.cacheHealth() });
		},
	});
};

// ============================================================================
// Analytics
// ============================================================================

export const useJellyfinTranscodeAnalytics = (days = 30, enabled = true) => {
	return useQuery<TranscodeAnalytics>({
		queryKey: jellyfinKeys.transcodeAnalytics(days),
		queryFn: () => fetchJellyfinTranscodeAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinBandwidthAnalytics = (days = 30, enabled = true) => {
	return useQuery<BandwidthAnalytics>({
		queryKey: jellyfinKeys.bandwidthAnalytics(days),
		queryFn: () => fetchJellyfinBandwidthAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinUserAnalytics = (days = 30, enabled = true) => {
	return useQuery<UserAnalytics>({
		queryKey: jellyfinKeys.userAnalytics(days),
		queryFn: () => fetchJellyfinUserAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinWatchHistory = (days = 7, limit = 50, enabled = true) => {
	return useQuery<WatchHistoryResponse>({
		queryKey: jellyfinKeys.watchHistory(days, limit),
		queryFn: () => fetchJellyfinWatchHistory(days, limit),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinCodecAnalytics = (days = 30, enabled = true) => {
	return useQuery<CodecAnalytics>({
		queryKey: jellyfinKeys.codecAnalytics(days),
		queryFn: () => fetchJellyfinCodecAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinDeviceAnalytics = (days = 30, enabled = true) => {
	return useQuery<DeviceAnalytics>({
		queryKey: jellyfinKeys.deviceAnalytics(days),
		queryFn: () => fetchJellyfinDeviceAnalytics(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinQualityScore = (days = 30, enabled = true) => {
	return useQuery<QualityScoreAnalytics>({
		queryKey: jellyfinKeys.qualityScore(days),
		queryFn: () => fetchJellyfinQualityScore(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinBandwidthForecast = (days = 30, enabled = true) => {
	return useQuery<BandwidthForecast>({
		queryKey: jellyfinKeys.bandwidthForecast(days),
		queryFn: () => fetchJellyfinBandwidthForecast(days),
		staleTime: 5 * 60_000,
		enabled,
	});
};

export const useJellyfinSeriesProgress = (tmdbIds: number[], enabled = true) => {
	const key = tmdbIds.join(",");
	return useQuery<SeriesProgressResponse>({
		queryKey: jellyfinKeys.seriesProgress(key),
		queryFn: () => fetchJellyfinSeriesProgress(tmdbIds),
		staleTime: 5 * 60_000,
		enabled: enabled && tmdbIds.length > 0,
	});
};

export const useJellyfinUserEpisodeCompletion = (tmdbIds: number[], enabled = true) => {
	const key = tmdbIds.join(",");
	return useQuery<UserEpisodeCompletion>({
		queryKey: jellyfinKeys.userEpisodeCompletion(key),
		queryFn: () => fetchJellyfinUserEpisodeCompletion(tmdbIds),
		staleTime: 5 * 60_000,
		enabled: enabled && tmdbIds.length > 0,
	});
};
