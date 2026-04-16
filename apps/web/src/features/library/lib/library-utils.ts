import type { LibraryItem, ServiceInstanceSummary } from "@arr/shared";
import { formatBytes as formatBytesShared } from "../../../lib/format-utils";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

/** Maps each ARR service type to its primary accent color. */
export const SERVICE_COLORS: Record<"sonarr" | "radarr" | "lidarr" | "readarr", string> = {
	sonarr: SERVICE_GRADIENTS.sonarr.from,
	radarr: SERVICE_GRADIENTS.radarr.from,
	lidarr: SERVICE_GRADIENTS.lidarr.from,
	readarr: SERVICE_GRADIENTS.readarr.from,
};

/**
 * Format bytes into human-readable string (e.g., "1.5 GB").
 * Returns `null` for invalid values (library convention).
 */
export const formatBytes = (value?: number): string | null => {
	if (value == null || value < 0) return null;
	return formatBytesShared(value);
};

/**
 * Format runtime in minutes into human-readable string (e.g., "2h 30m")
 */
export const formatRuntime = (value?: number | null): string | null => {
	if (value == null || value < 0) {
		return null;
	}

	const hours = Math.floor(value / 60);
	const minutes = Math.round(value % 60);

	if (hours === 0) {
		return `${minutes}m`;
	}

	if (minutes === 0) {
		return `${hours}h`;
	}

	return `${hours}h ${minutes}m`;
};

/**
 * Remove trailing slashes from URL
 */
const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Build external link to item in Sonarr/Radarr UI
 * - Radarr uses TMDB ID in URLs: /movie/{tmdbId}
 * - Sonarr uses title slug in URLs: /series/{titleSlug}
 */
export const buildLibraryExternalLink = (
	item: LibraryItem,
	instance?: ServiceInstanceSummary,
): string | null => {
	if (!instance || !instance.baseUrl) {
		return null;
	}

	// Prefer externalUrl so links resolve behind reverse proxies (#354);
	// baseUrl is only reachable from inside the LAN/container network.
	const baseUrl = normalizeBaseUrl(instance.externalUrl ?? instance.baseUrl);
	const slugSegment = item.titleSlug ? encodeURIComponent(item.titleSlug) : null;

	if (item.service === "sonarr") {
		// Sonarr uses titleSlug, fallback to id
		const segment = slugSegment ?? encodeURIComponent(String(item.id));
		return `${baseUrl}/series/${segment}`;
	}

	if (item.service === "radarr") {
		// Radarr uses TMDB ID in URLs, not internal database ID
		const tmdbId = item.remoteIds?.tmdbId;
		if (!tmdbId) {
			return null;
		}
		return `${baseUrl}/movie/${encodeURIComponent(String(tmdbId))}`;
	}

	return null;
};

/**
 * Build a Plex deep link URL for opening an item in the Plex web app.
 * Requires the server's machineId and the item's ratingKey from Plex cache.
 */
export const buildPlexUrl = (machineId: string, ratingKey: string): string => {
	return `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${ratingKey}`)}`;
};

/**
 * Build a Jellyfin or Emby deep link URL for opening an item in the web UI.
 * Jellyfin: {baseUrl}/web/#/details?id={jellyfinId}
 * Emby:     {baseUrl}/web/index.html#!/item?id={jellyfinId}&serverId={serverId}
 */
export const buildJellyfinUrl = (
	baseUrl: string,
	jellyfinId: string,
	service: "jellyfin" | "emby",
	serverId?: string,
): string => {
	const base = normalizeBaseUrl(baseUrl);
	if (service === "emby" && serverId) {
		return `${base}/web/index.html#!/item?id=${encodeURIComponent(jellyfinId)}&serverId=${encodeURIComponent(serverId)}`;
	}
	return `${base}/web/#/details?id=${encodeURIComponent(jellyfinId)}`;
};
