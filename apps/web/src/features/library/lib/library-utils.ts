import type { LibraryItem, ServiceInstanceSummary } from "@arr/shared";

/**
 * Format bytes into human-readable string (e.g., "1.5 GB")
 */
export const formatBytes = (value?: number): string | null => {
	if (value == null || value < 0) {
		return null;
	}

	const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
	const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	const size = value / Math.pow(1024, exponent);
	return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[exponent]}`;
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
export const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Build external link to item in Sonarr/Radarr UI
 */
export const buildLibraryExternalLink = (
	item: LibraryItem,
	instance?: ServiceInstanceSummary,
): string | null => {
	if (!instance || !instance.baseUrl) {
		return null;
	}

	const baseUrl = normalizeBaseUrl(instance.baseUrl);
	const idSegment = encodeURIComponent(String(item.id));
	const slugSegment = item.titleSlug ? encodeURIComponent(item.titleSlug) : idSegment;

	if (item.service === "sonarr") {
		return `${baseUrl}/series/${slugSegment}`;
	}

	if (item.service === "radarr") {
		return `${baseUrl}/movie/${idSegment}`;
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
