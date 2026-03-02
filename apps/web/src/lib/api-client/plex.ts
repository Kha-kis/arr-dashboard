/**
 * Plex API Client
 *
 * Frontend API functions for Plex integration endpoints.
 * All requests are proxied through Next.js rewrites → Fastify backend.
 */

import type {
	PlexEpisodeStatusResponse,
	PlexNowPlayingResponse,
	PlexScanResponse,
	PlexSectionsResponse,
	PlexTagsResponse,
	PlexTagUpdateRequest,
	WatchEnrichmentResponse,
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
