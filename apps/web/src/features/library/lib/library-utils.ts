import type { LibraryItem, ServiceInstanceSummary } from "@arr/shared";
import { formatBytes as formatBytesShared } from "../../../lib/format-utils";

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

	const baseUrl = normalizeBaseUrl(instance.baseUrl);
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
 * Group library items by type (movies vs series)
 */
export const groupItemsByType = (items: LibraryItem[]) => ({
	movies: items.filter((item) => item.type === "movie"),
	series: items.filter((item) => item.type === "series"),
});
