/**
 * Seerr shared types
 *
 * Response shapes and constants for the Seerr (merged Jellyseerr + Overseerr) integration.
 */

// ============================================================================
// Status Constants & Derived Union Types
// ============================================================================

export const SEERR_REQUEST_STATUS = {
	PENDING: 1,
	APPROVED: 2,
	DECLINED: 3,
	FAILED: 4,
	COMPLETED: 5,
} as const;

export type SeerrRequestStatus = (typeof SEERR_REQUEST_STATUS)[keyof typeof SEERR_REQUEST_STATUS];

export const SEERR_REQUEST_STATUS_LABEL: Record<SeerrRequestStatus, string> = {
	1: "Pending",
	2: "Approved",
	3: "Declined",
	4: "Failed",
	5: "Completed",
};

export const SEERR_MEDIA_STATUS = {
	UNKNOWN: 1,
	PENDING: 2,
	PROCESSING: 3,
	PARTIALLY_AVAILABLE: 4,
	AVAILABLE: 5,
	BLOCKLISTED: 6,
	DELETED: 7,
} as const;

export type SeerrMediaStatus = (typeof SEERR_MEDIA_STATUS)[keyof typeof SEERR_MEDIA_STATUS];

export const SEERR_MEDIA_STATUS_LABEL: Record<SeerrMediaStatus, string> = {
	1: "Unavailable",
	2: "Pending",
	3: "Processing",
	4: "Partially Available",
	5: "Available",
	6: "Blocklisted",
	7: "Deleted",
};

export const SEERR_ISSUE_TYPE = {
	VIDEO: 1,
	AUDIO: 2,
	SUBTITLE: 3,
	OTHER: 4,
} as const;

export type SeerrIssueType = (typeof SEERR_ISSUE_TYPE)[keyof typeof SEERR_ISSUE_TYPE];

export const SEERR_ISSUE_TYPE_LABEL: Record<SeerrIssueType, string> = {
	1: "Video",
	2: "Audio",
	3: "Subtitle",
	4: "Other",
};

export const SEERR_ISSUE_STATUS = {
	OPEN: 1,
	RESOLVED: 2,
} as const;

export type SeerrIssueStatus = (typeof SEERR_ISSUE_STATUS)[keyof typeof SEERR_ISSUE_STATUS];

export const SEERR_ISSUE_STATUS_LABEL: Record<SeerrIssueStatus, string> = {
	1: "Open",
	2: "Resolved",
};

/** TMDB keyword ID that marks a series as anime */
export const SEERR_ANIME_KEYWORD_ID = 210024;

/** TMDB genre ID for "Animation" */
export const TMDB_ANIMATION_GENRE_ID = 16;

// ============================================================================
// Response Types
// ============================================================================

export interface SeerrMediaInfo {
	id: number;
	tmdbId: number;
	tvdbId?: number;
	status: SeerrMediaStatus;
	createdAt: string;
	updatedAt: string;
}

export interface SeerrRequest {
	id: number;
	status: SeerrRequestStatus;
	type: "movie" | "tv";
	media: SeerrMediaInfo & {
		posterPath?: string;
		title?: string;
		originalTitle?: string;
		overview?: string;
	};
	createdAt: string;
	updatedAt: string;
	requestedBy: SeerrUser;
	modifiedBy?: SeerrUser;
	is4k: boolean;
	serverId?: number;
	profileId?: number;
	rootFolder?: string;
	languageProfileId?: number;
	tags?: number[];
	seasons?: SeerrSeason[];
}

export interface SeerrSeason {
	id: number;
	seasonNumber: number;
	status: SeerrMediaStatus;
}

export interface SeerrRequestCount {
	total: number;
	movie: number;
	tv: number;
	pending: number;
	approved: number;
	declined: number;
	processing: number;
	available: number;
}

export interface SeerrUser {
	id: number;
	email?: string;
	displayName: string;
	avatar?: string;
	createdAt: string;
	updatedAt: string;
	/** Bitmask of Seerr permission flags */
	permissions: number;
	requestCount: number;
	movieQuotaLimit?: number;
	movieQuotaDays?: number;
	tvQuotaLimit?: number;
	tvQuotaDays?: number;
	userType: number;
}

export interface SeerrQuota {
	movie: { used: number; remaining: number; restricted: boolean; limit: number; days: number };
	tv: { used: number; remaining: number; restricted: boolean; limit: number; days: number };
}

export interface SeerrIssue {
	id: number;
	issueType: SeerrIssueType;
	status: SeerrIssueStatus;
	problemSeason: number;
	problemEpisode: number;
	createdAt: string;
	updatedAt: string;
	createdBy: SeerrUser;
	comments: SeerrIssueComment[];
	media: SeerrMediaInfo & {
		posterPath?: string;
		title?: string;
	};
}

export interface SeerrIssueComment {
	id: number;
	message: string;
	createdAt: string;
	user: SeerrUser;
}

export interface SeerrNotificationAgent {
	id: string;
	name: string;
	enabled: boolean;
	/** Bitmask of notification event types */
	types: number;
	options: Record<string, unknown>;
}

export interface SeerrStatus {
	version: string;
	commitTag: string;
	updateAvailable: boolean;
	commitsBehind: number;
}

export interface SeerrPageResult<T> {
	pageInfo: { pages: number; pageSize: number; results: number; page: number };
	results: T[];
}

// ============================================================================
// Request Parameter Types
// ============================================================================

export interface SeerrRequestParams {
	take?: number;
	skip?: number;
	filter?: "all" | "approved" | "available" | "pending" | "processing" | "unavailable" | "failed";
	sort?: "added" | "modified";
	requestedBy?: number;
}

export interface SeerrIssueParams {
	take?: number;
	skip?: number;
	filter?: "all" | "open" | "resolved";
	sort?: "added" | "modified";
}

export interface SeerrUserParams {
	take?: number;
	skip?: number;
	sort?: "created" | "updated" | "displayname" | "requests";
}

export interface SeerrUserUpdateData {
	permissions?: number;
	movieQuotaLimit?: number | null;
	movieQuotaDays?: number | null;
	tvQuotaLimit?: number | null;
	tvQuotaDays?: number | null;
}

// ============================================================================
// Discovery Types
// ============================================================================

/** Single result from Seerr's discover/search endpoints, enriched with mediaInfo */
export interface SeerrDiscoverResult {
	id: number;
	mediaType: "movie" | "tv";
	title?: string;
	name?: string;
	originalTitle?: string;
	originalName?: string;
	overview?: string;
	posterPath?: string;
	backdropPath?: string;
	releaseDate?: string;
	firstAirDate?: string;
	voteAverage?: number;
	voteCount?: number;
	popularity?: number;
	genreIds?: number[];
	originalLanguage?: string;
	adult?: boolean;
	mediaInfo?: SeerrMediaInfo;
}

/** Paginated discover/search response */
export interface SeerrDiscoverResponse {
	page: number;
	totalPages: number;
	totalResults: number;
	results: SeerrDiscoverResult[];
}

/** Full movie details from /api/v1/movie/{tmdbId} */
export interface SeerrMovieDetails {
	id: number;
	title: string;
	originalTitle?: string;
	overview?: string;
	posterPath?: string;
	backdropPath?: string;
	releaseDate?: string;
	runtime?: number;
	budget?: number;
	revenue?: number;
	voteAverage?: number;
	voteCount?: number;
	popularity?: number;
	status?: string;
	originalLanguage?: string;
	genres: SeerrGenre[];
	productionCompanies?: { id: number; name: string; logoPath?: string }[];
	credits: SeerrCredits;
	relatedVideos?: SeerrVideo[];
	mediaInfo?: SeerrMediaInfo;
	externalIds?: SeerrExternalIds;
	recommendations: SeerrDiscoverResponse;
	similar: SeerrDiscoverResponse;
}

/** Full TV details from /api/v1/tv/{tmdbId} */
export interface SeerrTvDetails {
	id: number;
	name: string;
	originalName?: string;
	overview?: string;
	posterPath?: string;
	backdropPath?: string;
	firstAirDate?: string;
	lastAirDate?: string;
	numberOfSeasons?: number;
	numberOfEpisodes?: number;
	episodeRunTime?: number[];
	voteAverage?: number;
	voteCount?: number;
	popularity?: number;
	status?: string;
	originalLanguage?: string;
	genres: SeerrGenre[];
	networks?: { id: number; name: string; logoPath?: string }[];
	credits: SeerrCredits;
	relatedVideos?: SeerrVideo[];
	mediaInfo?: SeerrMediaInfo;
	externalIds?: SeerrExternalIds;
	keywords: { id: number; name: string }[];
	seasons: SeerrSeasonSummary[];
	recommendations: SeerrDiscoverResponse;
	similar: SeerrDiscoverResponse;
}

export interface SeerrSeasonSummary {
	id: number;
	seasonNumber: number;
	name?: string;
	overview?: string;
	episodeCount: number;
	airDate?: string;
	posterPath?: string;
}

export interface SeerrCredits {
	cast: SeerrCastMember[];
	crew: SeerrCrewMember[];
}

export interface SeerrCastMember {
	id: number;
	name: string;
	character?: string;
	profilePath?: string;
	order?: number;
}

export interface SeerrCrewMember {
	id: number;
	name: string;
	job?: string;
	department?: string;
	profilePath?: string;
}

export interface SeerrVideo {
	key: string;
	name?: string;
	site: string;
	type?: string;
	size?: number;
}

export interface SeerrGenre {
	id: number;
	name: string;
}

export interface SeerrExternalIds {
	imdbId?: string;
	tvdbId?: number;
	facebookId?: string;
	instagramId?: string;
	twitterId?: string;
}

/** Payload for POST /api/v1/request */
export interface SeerrCreateRequestPayload {
	mediaId: number;
	mediaType: "movie" | "tv";
	seasons?: number[];
	is4k?: boolean;
	serverId?: number;
	profileId?: number;
	rootFolder?: string;
	languageProfileId?: number;
	tags?: number[];
}

/** Response from POST /api/v1/request */
export interface SeerrCreateRequestResponse {
	id: number;
	status: SeerrRequestStatus;
	type: "movie" | "tv";
	media: SeerrMediaInfo;
	createdAt: string;
	is4k: boolean;
	seasons?: SeerrSeason[];
}

// ============================================================================
// Service Servers (for request options)
// ============================================================================

/** Summary of a configured Radarr/Sonarr server in Seerr */
export interface SeerrServiceServer {
	id: number;
	name: string;
	is4k: boolean;
	isDefault: boolean;
	activeProfileId: number;
	activeDirectory: string;
	activeLanguageProfileId?: number;
	activeAnimeProfileId?: number;
	activeAnimeDirectory?: string;
	activeAnimeLanguageProfileId?: number;
	activeTags: number[];
}

export interface SeerrQualityProfile {
	id: number;
	name: string;
}

export interface SeerrRootFolder {
	id: number;
	path: string;
	freeSpace?: number;
	totalSpace?: number;
}

export interface SeerrTag {
	id: number;
	label: string;
}

/** Full server details including profiles, root folders, and tags */
export interface SeerrServerWithDetails {
	server: SeerrServiceServer;
	profiles: SeerrQualityProfile[];
	rootFolders: SeerrRootFolder[];
	languageProfiles?: { id: number; name: string }[];
	tags: SeerrTag[];
}

/** Combined request options for the request dialog */
export interface SeerrRequestOptions {
	servers: SeerrServerWithDetails[];
}

/** Params for discover endpoints */
export interface SeerrDiscoverParams {
	page?: number;
	language?: string;
}

/** Params for search endpoint */
export interface SeerrSearchParams {
	query: string;
	page?: number;
	language?: string;
}
