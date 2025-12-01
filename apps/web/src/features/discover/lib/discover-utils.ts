import type {
	DiscoverSearchResult,
	DiscoverSearchType,
	LibraryItem,
	RecommendationItem,
	ServiceInstanceSummary,
} from "@arr/shared";

/**
 * Formats a runtime value (in minutes) to a human-readable string.
 * Returns null if runtime is invalid or zero.
 *
 * @param runtime - The runtime in minutes
 * @returns Formatted runtime string (e.g., "2h 30m", "45m") or null
 *
 * @example
 * formatRuntime(150) // "2h 30m"
 * formatRuntime(45) // "45m"
 * formatRuntime(120) // "2h"
 * formatRuntime(0) // null
 */
export const formatRuntime = (runtime?: number): string | null => {
	if (!runtime || runtime <= 0) {
		return null;
	}
	if (runtime >= 60) {
		const hours = Math.floor(runtime / 60);
		const minutes = runtime % 60;
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${runtime}m`;
};

/**
 * Deduplicates recommendation items by TMDB ID.
 * When duplicates are found, keeps the first occurrence.
 *
 * @param items - Array of recommendation items to deduplicate
 * @returns Array of unique recommendation items
 *
 * @example
 * const unique = deduplicateItems(items);
 */
export const deduplicateItems = (items: RecommendationItem[]): RecommendationItem[] => {
	const seen = new Set<number>();
	return items.filter((item) => {
		if (!item.tmdbId || seen.has(item.tmdbId)) {
			return false;
		}
		seen.add(item.tmdbId);
		return true;
	});
};

/**
 * Filters out recommendation items that already exist in the library.
 * Uses TMDB ID matching (most reliable) with title fallback.
 *
 * @param items - Array of recommendation items to filter
 * @param libraryItems - Array of library items to check against
 * @param mediaType - The media type to filter by ("movie" or "series")
 * @returns Filtered array of recommendation items not in the library
 *
 * @example
 * const filtered = filterExistingItems(recommendations, library, "movie");
 */
export const filterExistingItems = (
	items: RecommendationItem[],
	libraryItems: LibraryItem[] | undefined,
	mediaType: "movie" | "series",
): RecommendationItem[] => {
	if (!libraryItems) return items;

	// Filter library items by media type
	const relevantLibraryItems = libraryItems.filter(
		(item) =>
			(mediaType === "movie" && item.type === "movie") ||
			(mediaType === "series" && item.type === "series"),
	);

	// Build a Set of TMDB IDs that exist in library
	const libraryTmdbIds = new Set(
		relevantLibraryItems
			.map((item) => item.remoteIds?.tmdbId)
			.filter((id): id is number => typeof id === "number"),
	);

	// Build a Set of titles (lowercase) as fallback for items without TMDB IDs
	const libraryTitles = new Set(
		relevantLibraryItems.map((item) => item.title.toLowerCase()),
	);

	return items.filter((item) => {
		// First try matching by TMDB ID (most reliable)
		if (item.tmdbId && libraryTmdbIds.has(item.tmdbId)) {
			return false; // Item exists in library
		}

		// Fallback to title matching for items without TMDB IDs
		if (libraryTitles.has(item.title.toLowerCase())) {
			return false; // Item exists in library
		}

		return true; // Item not in library
	});
};

/**
 * Gets recently added items from the library, sorted by date added (newest first).
 * Limited to the specified number of items.
 *
 * @param libraryItems - Array of library items
 * @param mediaType - The media type to filter by ("movie" or "series")
 * @param limit - Maximum number of items to return (default: 5)
 * @returns Array of recently added library items
 */
export const getRecentlyAdded = (
	libraryItems: LibraryItem[] | undefined,
	mediaType: "movie" | "series",
	limit: number = 5,
): LibraryItem[] => {
	if (!libraryItems) {
		return [];
	}

	const matchingItems = libraryItems.filter(
		(item) =>
			(mediaType === "movie" && item.type === "movie") ||
			(mediaType === "series" && item.type === "series"),
	);

	return matchingItems
		.filter((item) => item.added)
		.sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
		.slice(0, limit);
};

/**
 * Gets items from the library with the longest runtime, sorted by runtime (longest first).
 *
 * @param libraryItems - Array of library items
 * @param mediaType - The media type to filter by ("movie" or "series")
 * @param limit - Maximum number of items to return (default: 5)
 * @returns Array of library items sorted by runtime (longest first)
 */
export const getTopRated = (
	libraryItems: LibraryItem[] | undefined,
	mediaType: "movie" | "series",
	limit: number = 5,
): LibraryItem[] => {
	if (!libraryItems) {
		return [];
	}

	const matchingItems = libraryItems.filter(
		(item) =>
			(mediaType === "movie" && item.type === "movie") ||
			(mediaType === "series" && item.type === "series"),
	);

	return matchingItems
		.filter((item) => item.statistics?.runtime && item.statistics.runtime > 0)
		.sort((a, b) => {
			const runtimeA = a.statistics?.runtime || 0;
			const runtimeB = b.statistics?.runtime || 0;
			return runtimeB - runtimeA;
		})
		.slice(0, limit);
};

/**
 * Converts a RecommendationItem to DiscoverSearchResult format.
 * Creates fake instance states marking all instances as "not existing" since
 * recommendation items don't include instance availability data.
 *
 * @param item - The recommendation item to convert
 * @param searchType - Current media type ("movie" or "series")
 * @param relevantInstances - Service instances relevant to current search type
 * @returns DiscoverSearchResult formatted for the add dialog
 *
 * @example
 * const result = convertRecommendationToSearchResult(
 *   recommendationItem,
 *   "movie",
 *   radarrInstances
 * );
 */
export const convertRecommendationToSearchResult = (
	item: RecommendationItem,
	searchType: DiscoverSearchType,
	relevantInstances: ServiceInstanceSummary[],
): DiscoverSearchResult => {
	return {
		id: `tmdb-${item.tmdbId}`,
		title: item.title,
		type: searchType,
		year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : undefined,
		overview: item.overview,
		remoteIds: {
			tmdbId: item.tmdbId,
		},
		images: {
			poster: item.posterUrl,
			fanart: item.backdropUrl,
		},
		ratings: item.rating
			? {
					value: item.rating,
					votes: item.voteCount,
				}
			: undefined,
		// Initialize instance states as "not existing" - actual status will be fetched separately
		instanceStates: relevantInstances
			.filter(
				(instance): instance is typeof instance & { service: "sonarr" | "radarr" } =>
					instance.service === "sonarr" || instance.service === "radarr"
			)
			.map((instance) => ({
				instanceId: instance.id,
				instanceName: instance.label,
				service: instance.service,
				exists: false,
				monitored: false,
				hasFile: false,
			})),
	};
};
