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
export const compareBySortKey = (sortKey: SortKey, a: SearchResult, b: SearchResult): number => {
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
	if (normalized.includes("download client") && normalized.includes("isn't configured")) {
		return "Configure a torrent download client in Prowlarr before grabbing releases.";
	}
	if (normalized.includes("download client") && normalized.includes("configure")) {
		return "Configure a torrent download client in Prowlarr before grabbing releases.";
	}
	if (normalized.includes("download client failed to add torrent")) {
		return "The download client (qBittorrent/Transmission/etc.) rejected the torrent. Check that your download client is running and properly configured in Prowlarr.";
	}
	if (
		normalized.includes("validation errors") &&
		normalized.includes("json value could not be converted")
	) {
		return "Prowlarr rejected the grab payload. Try the search again or review the indexer configuration.";
	}
	return null;
};

/**
 * Checks if a string looks like a stack trace
 * @param text - Text to check
 * @returns True if text appears to be a stack trace
 */
const isStackTrace = (text: string): boolean => {
	const lines = text.split("\n");
	// If it has more than 3 lines and contains common stack trace patterns
	if (lines.length > 3) {
		const stackIndicators = [
			"at ",
			".cs:line",
			"NzbDrone.",
			"Prowlarr.",
			"System.",
			"Microsoft.",
			"   at ",
		];
		const matchingLines = lines.filter((line) =>
			stackIndicators.some((indicator) => line.includes(indicator)),
		);
		// If more than half the lines look like stack trace lines
		return matchingLines.length > lines.length / 2;
	}
	return false;
};

/**
 * Derives a grab error message from an API error object
 * @param error - Error object from API
 * @returns User-friendly error message
 */
export const deriveGrabErrorMessage = (error: unknown): string => {
	// Check if it's an ApiError with payload
	if (error && typeof error === "object" && "payload" in error) {
		const payload = (error as any).payload;

		if (payload && typeof payload === "object") {
			const record = payload as Record<string, unknown>;
			const primary = typeof record.message === "string" ? record.message.trim() : "";
			const secondary = typeof record.description === "string" ? record.description.trim() : "";

			// Filter out stack traces from description
			const cleanSecondary = secondary && !isStackTrace(secondary) ? secondary : "";

			const errors = record.errors as Record<string, unknown> | undefined;
			const fieldMessages: string[] = [];
			if (errors && typeof errors === "object") {
				for (const value of Object.values(errors)) {
					if (Array.isArray(value)) {
						for (const entry of value) {
							if (typeof entry === "string" && entry.trim().length > 0) {
								fieldMessages.push(entry.trim());
							}
						}
					}
				}
			}

			const combined = [primary, cleanSecondary, ...fieldMessages].filter(
				(entry) => entry.length > 0,
			);
			if (combined.length > 0) {
				const friendly = interpretGrabError(combined.join(" "));
				return friendly ?? combined.join(" ");
			}
		} else if (typeof payload === "string" && payload.trim().length > 0) {
			const friendly = interpretGrabError(payload);
			return friendly ?? payload.trim();
		}

		if ("message" in error && typeof (error as any).message === "string") {
			const friendly = interpretGrabError((error as any).message);
			return friendly ?? (error as any).message;
		}
	}

	if (error instanceof Error && error.message) {
		const friendly = interpretGrabError(error.message);
		return friendly ?? error.message;
	}

	return "Failed to send release to the download client.";
};
