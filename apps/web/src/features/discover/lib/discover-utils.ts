import type { RecommendationItem } from "@arr/shared";
import type { LibraryItem } from "@arr/shared";

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
 * Filters out recommendation items that already exist in the library.
 * Performs case-insensitive title matching based on the selected media type.
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

  const libraryTitles = new Set(
    libraryItems
      .filter(
        (item) =>
          (mediaType === "movie" && item.type === "movie") ||
          (mediaType === "series" && item.type === "series"),
      )
      .map((item) => item.title.toLowerCase()),
  );

  return items.filter((item) => !libraryTitles.has(item.title.toLowerCase()));
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
    .sort(
      (a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime(),
    )
    .slice(0, limit);
};

/**
 * Gets top rated items from the library, sorted by runtime.
 * Note: This appears to be sorting by runtime, not rating - may need adjustment.
 *
 * @param libraryItems - Array of library items
 * @param mediaType - The media type to filter by ("movie" or "series")
 * @param limit - Maximum number of items to return (default: 5)
 * @returns Array of top rated library items
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
      const ratingA = a.statistics?.runtime || 0;
      const ratingB = b.statistics?.runtime || 0;
      return ratingB - ratingA;
    })
    .slice(0, limit);
};
