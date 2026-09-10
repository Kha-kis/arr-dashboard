import type { HistoryService, ProviderCoverageProvider } from "@arr/shared";

/** The complete set of database services whose provider History is observable. */
export const HISTORY_SERVICE_TYPES = ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] as const;

export type HistoryServiceType = (typeof HISTORY_SERVICE_TYPES)[number];

export const HISTORY_COLLECTION_MAX_REQUESTS = 100;
export const HISTORY_COLLECTION_MAX_RAW_ROWS = 10_000;
export const HISTORY_COLLECTION_PAGE_SIZE = 100;
export const HISTORY_COLLECTION_MAX_DURATION_MS = 4 * 60_000;
export const HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS = 20_000;
export const HISTORY_COLLECTION_MAX_SOURCE_TURNS = 100;
export const HISTORY_COLLECTION_MAX_TURNS_PER_SOURCE = 2;
export const HISTORY_OBSERVATION_METADATA_MAX_BYTES = 8 * 1024;
export const HISTORY_OBSERVATION_RECEIPT_SCOPE = "history";

export function isHistoryServiceType(value: unknown): value is HistoryServiceType {
	return typeof value === "string" && (HISTORY_SERVICE_TYPES as readonly string[]).includes(value);
}

export function historyServiceTypeToService(value: HistoryServiceType): HistoryService {
	switch (value) {
		case "SONARR":
			return "sonarr";
		case "RADARR":
			return "radarr";
		case "PROWLARR":
			return "prowlarr";
		case "LIDARR":
			return "lidarr";
		case "READARR":
			return "readarr";
	}
}

export function historyServiceToCoverageProvider(
	service: HistoryService,
): ProviderCoverageProvider {
	switch (service) {
		case "sonarr":
			return "sonarr_history";
		case "radarr":
			return "radarr_history";
		case "prowlarr":
			return "prowlarr_history";
		case "lidarr":
			return "lidarr_history";
		case "readarr":
			return "readarr_history";
	}
}
