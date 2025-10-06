import type { SearchResult } from "@arr/shared";

/**
 * Available search types for manual search
 */
export const SEARCH_TYPES: Array<{
  value: "all" | "movie" | "tv" | "music" | "book";
  label: string;
}> = [
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
  { value: "music", label: "Music" },
  { value: "book", label: "Books" },
  { value: "all", label: "All" },
];

/**
 * Available protocol filters for search results
 */
export const PROTOCOL_FILTERS: Array<{
  value: "all" | "torrent" | "usenet";
  label: string;
}> = [
  { value: "all", label: "All protocols" },
  { value: "torrent", label: "Torrent only" },
  { value: "usenet", label: "Usenet only" },
];

/**
 * Available sort options for search results
 */
export const SORT_OPTIONS: Array<{
  value: "seeders" | "publishDate" | "age" | "size" | "title";
  label: string;
}> = [
  { value: "seeders", label: "Seeders" },
  { value: "publishDate", label: "Publish date" },
  { value: "age", label: "Age" },
  { value: "size", label: "Size" },
  { value: "title", label: "Title" },
];

export type SortKey = (typeof SORT_OPTIONS)[number]["value"];
export type ProtocolFilter = (typeof PROTOCOL_FILTERS)[number]["value"];

/**
 * Builds filter payload from selected indexers
 * @param selected - Record of instance IDs to indexer IDs
 * @returns Array of filter objects with valid indexer IDs
 */
export const buildFilters = (
  selected: Record<string, number[]>,
): Array<{ instanceId: string; indexerIds: number[] }> => {
  return Object.entries(selected)
    .map(([instanceId, ids]) => ({
      instanceId,
      indexerIds: ids.filter((id) => typeof id === "number" && id > 0),
    }))
    .filter((entry) => entry.indexerIds.length > 0);
};

/**
 * Parses a number input string to a valid number or null
 * @param value - Input string to parse
 * @returns Parsed number or null if invalid
 */
export const parseNumberInput = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Extracts publish timestamp from a date string
 * @param value - Date string to parse
 * @returns Unix timestamp in milliseconds or null if invalid
 */
export const getPublishTimestamp = (value?: string): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Calculates age in hours from a search result
 * Tries multiple fields: ageHours, age, ageDays, publishDate
 * @param result - Search result to extract age from
 * @returns Age in hours or null if unavailable
 */
export const getAgeHours = (result: SearchResult): number | null => {
  if (typeof result.ageHours === "number" && Number.isFinite(result.ageHours)) {
    return result.ageHours;
  }
  if (typeof result.age === "number" && Number.isFinite(result.age)) {
    return result.age;
  }
  if (typeof result.ageDays === "number" && Number.isFinite(result.ageDays)) {
    return result.ageDays * 24;
  }
  const timestamp = getPublishTimestamp(result.publishDate);
  if (timestamp) {
    const diffMs = Date.now() - timestamp;
    if (diffMs > 0) {
      return diffMs / (1000 * 60 * 60);
    }
  }
  return null;
};

/**
 * Compares two numbers with proper null handling
 * @param a - First number
 * @param b - Second number
 * @returns -1, 0, or 1 for comparison
 */
export const compareNumbers = (a: number, b: number) => {
  if (a === b) {
    return 0;
  }
  return a > b ? 1 : -1;
};

/**
 * Compares two search results by a specific sort key
 * @param sortKey - Key to sort by
 * @param a - First search result
 * @param b - Second search result
 * @returns -1, 0, or 1 for comparison
 */
export const compareBySortKey = (
  sortKey: SortKey,
  a: SearchResult,
  b: SearchResult,
): number => {
  switch (sortKey) {
    case "seeders":
      return compareNumbers(a.seeders ?? 0, b.seeders ?? 0);
    case "size":
      return compareNumbers(a.size ?? 0, b.size ?? 0);
    case "publishDate": {
      const timeA = getPublishTimestamp(a.publishDate);
      const timeB = getPublishTimestamp(b.publishDate);
      if (timeA === null && timeB === null) {
        return 0;
      }
      if (timeA === null) {
        return 1;
      }
      if (timeB === null) {
        return -1;
      }
      return compareNumbers(timeA, timeB);
    }
    case "age": {
      const ageA = getAgeHours(a);
      const ageB = getAgeHours(b);
      if (ageA === null && ageB === null) {
        return 0;
      }
      if (ageA === null) {
        return 1;
      }
      if (ageB === null) {
        return -1;
      }
      return compareNumbers(ageA, ageB);
    }
    case "title":
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    default:
      return 0;
  }
};

/**
 * Interprets common grab error messages and provides user-friendly alternatives
 * @param message - Error message to interpret
 * @returns Friendly error message or null if no interpretation available
 */
export const interpretGrabError = (message: string): string | null => {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("download client") &&
    normalized.includes("isn't configured")
  ) {
    return "Configure a torrent download client in Prowlarr before grabbing releases.";
  }
  if (
    normalized.includes("download client") &&
    normalized.includes("configure")
  ) {
    return "Configure a torrent download client in Prowlarr before grabbing releases.";
  }
  if (
    normalized.includes("validation errors") &&
    normalized.includes("json value could not be converted")
  ) {
    return "Prowlarr rejected the grab payload. Try the search again or review the indexer configuration.";
  }
  return null;
};
