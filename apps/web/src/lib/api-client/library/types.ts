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
	cutoffUnmet?: "true" | "false" | "all";
	/**
	 * qui torrent-state filter (Phase 2.1). `all` (or omitted) skips the filter,
	 * `none` matches items without qui state yet, other values match the
	 * normalized vocabulary (`seeding`/`stalled_dl`/etc.) exactly.
	 */
	torrentState?:
		| "all"
		| "none"
		| "seeding"
		| "downloading"
		| "stalled_dl"
		| "paused"
		| "queued"
		| "checking"
		| "moving"
		| "error"
		| "unknown";
	status?: string;
	qualityProfileId?: number;
	yearMin?: number;
	yearMax?: number;
	// Sorting
	sortBy?: "title" | "sortTitle" | "year" | "sizeOnDisk" | "added" | "torrentRatio";
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
