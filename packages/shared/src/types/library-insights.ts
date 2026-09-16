import type { PlexEvidenceSummary } from "./plex";
import type { ProviderObservationStatusEnvelope } from "./provider-observation";

export type WatchInsightAvailability = "complete" | "partial" | "unavailable" | "not-configured";

interface LibraryWatchCandidate {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	addedDaysAgo: number;
	watchState: "unwatched" | "unknown";
}

export interface DiskWasteItem extends LibraryWatchCandidate {
	monitored: boolean;
	qualityProfileName: string | null;
}

export interface RequestedUnwatchedItem extends LibraryWatchCandidate {
	requestedBy: string;
	requestedAt: string;
}

interface WatchInsightResponse {
	success: boolean;
	evidence?: PlexEvidenceSummary;
	providerStatus?: ProviderObservationStatusEnvelope;
}

export interface DiskWasteInsightsResponse extends WatchInsightResponse {
	data: {
		items: DiskWasteItem[];
		unknownItems: DiskWasteItem[];
		totalWastedBytes: number | null;
		hasPlexData: boolean;
		hasWatchData: boolean;
		watchStatus: WatchInsightAvailability;
		limited: boolean;
	};
}

export interface RequestedUnwatchedInsightsResponse extends WatchInsightResponse {
	data: {
		items: RequestedUnwatchedItem[];
		unknownItems: RequestedUnwatchedItem[];
		hasPlexData: boolean;
		hasWatchData: boolean;
		hasSeerrData: boolean;
		watchStatus: WatchInsightAvailability;
		requestStatus: WatchInsightAvailability;
		limited: boolean;
	};
}
