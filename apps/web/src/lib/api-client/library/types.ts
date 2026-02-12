import type { LibraryService } from "@arr/shared";

export interface LibraryQueryParams {
	// Pagination
	page?: number;
	limit?: number;
	// Filters
	service?: LibraryService;
	instanceId?: string;
	search?: string;
	monitored?: "true" | "false" | "all";
	hasFile?: "true" | "false" | "all";
	status?: string;
	qualityProfileId?: number;
	yearMin?: number;
	yearMax?: number;
	// Sorting
	sortBy?: "title" | "sortTitle" | "year" | "sizeOnDisk" | "added";
	sortOrder?: "asc" | "desc";
}

export interface FetchEpisodesParams {
	instanceId: string;
	seriesId: number | string;
	seasonNumber?: number;
}

export interface FetchAlbumsParams {
	instanceId: string;
	artistId: number | string;
}

export interface FetchTracksParams {
	instanceId: string;
	albumId: number | string;
}

export interface FetchBooksParams {
	instanceId: string;
	authorId: number | string;
}

// ============================================================================
// Library Sync API
// ============================================================================

export interface LibrarySyncStatus {
	instanceId: string;
	instanceName: string;
	service: string;
	syncStatus: {
		lastFullSync: string | null;
		lastSyncDurationMs: number | null;
		syncInProgress: boolean;
		lastError: string | null;
		itemCount: number;
		pollingEnabled: boolean;
		pollingIntervalMins: number;
	};
}

export interface LibrarySyncStatusResponse {
	instances: LibrarySyncStatus[];
}

export interface LibrarySyncSettings {
	pollingEnabled?: boolean;
	pollingIntervalMins?: number;
}
