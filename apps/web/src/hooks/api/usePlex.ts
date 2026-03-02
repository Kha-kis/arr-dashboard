/**
 * Plex React Query Hooks
 *
 * Custom hooks for Plex integration: watch enrichment, sections, scan, now playing,
 * episodes, and tag management.
 */

import type {
	LibraryItem,
	PlexNowPlayingResponse,
	PlexScanResponse,
	PlexSectionsResponse,
	PlexTagUpdateRequest,
	WatchEnrichmentResponse,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	fetchEpisodeWatchStatus,
	fetchNowPlaying,
	fetchPlexCollections,
	fetchPlexLabels,
	fetchPlexSections,
	fetchWatchEnrichment,
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
