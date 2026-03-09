/**
 * Seerr shared types
 *
 * Response shapes and constants for the Seerr (merged Jellyseerr + Overseerr) integration.
 * Zod schemas are provided for critical response types to enable runtime validation.
 */

import { z } from "zod";

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
	mediaType?: "movie" | "tv";
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

// ============================================================================
// Zod Schemas for Runtime Validation
// ============================================================================

// All schemas use z.looseObject() to tolerate extra fields from different Seerr versions.
// This ensures required fields are validated while unknown fields are preserved (not stripped).
//
// Status fields use z.number().int().min/max (not literal unions) for forward-compatibility
// with new Seerr versions that may add statuses. The corresponding TS interfaces use literal
// union types (e.g. SeerrRequestStatus) for stricter downstream safety.

/** Mirrors SeerrStatus */
export const seerrStatusSchema = z.looseObject({
	version: z.string(),
	commitTag: z.string(),
	updateAvailable: z.boolean(),
	commitsBehind: z.number(),
});

/** Mirrors SeerrRequestCount */
export const seerrRequestCountSchema = z.looseObject({
	total: z.number(),
	movie: z.number(),
	tv: z.number(),
	pending: z.number(),
	approved: z.number(),
	declined: z.number(),
	processing: z.number(),
	available: z.number(),
});

/** Mirrors SeerrUser */
export const seerrUserSchema = z.looseObject({
	id: z.number(),
	email: z.string().optional(),
	displayName: z.string(),
	avatar: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	permissions: z.number(),
	requestCount: z.number(),
	movieQuotaLimit: z.number().optional(),
	movieQuotaDays: z.number().optional(),
	tvQuotaLimit: z.number().optional(),
	tvQuotaDays: z.number().optional(),
	userType: z.number(),
});

/** Mirrors SeerrMediaInfo — status range 1-7 matches SeerrMediaStatus */
const seerrMediaInfoSchema = z.looseObject({
	id: z.number(),
	tmdbId: z.number(),
	tvdbId: z.number().optional(),
	mediaType: z.enum(["movie", "tv"]).optional(),
	status: z.number().int().min(1).max(7),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/** Mirrors SeerrSeason — status range 1-7 matches SeerrMediaStatus */
const seerrSeasonSchema = z.looseObject({
	id: z.number(),
	seasonNumber: z.number(),
	status: z.number().int().min(1).max(7),
});

/** Mirrors SeerrRequest — status range 1-5 matches SeerrRequestStatus */
export const seerrRequestSchema = z.looseObject({
	id: z.number(),
	status: z.number().int().min(1).max(5),
	type: z.enum(["movie", "tv"]),
	media: seerrMediaInfoSchema.extend({
		posterPath: z.string().optional(),
		title: z.string().optional(),
		originalTitle: z.string().optional(),
		overview: z.string().optional(),
	}),
	createdAt: z.string(),
	updatedAt: z.string(),
	requestedBy: seerrUserSchema,
	modifiedBy: seerrUserSchema.optional(),
	is4k: z.boolean(),
	serverId: z.number().optional(),
	profileId: z.number().optional(),
	rootFolder: z.string().optional(),
	languageProfileId: z.number().optional(),
	tags: z.array(z.number()).optional(),
	seasons: z.array(seerrSeasonSchema).optional(),
});

export function seerrPageResultSchema<T extends z.ZodTypeAny>(itemSchema: T) {
	return z.looseObject({
		pageInfo: z.looseObject({
			pages: z.number(),
			pageSize: z.number(),
			results: z.number(),
			page: z.number(),
		}),
		results: z.array(itemSchema),
	});
}

/** Mirrors SeerrDiscoverResult */
export const seerrDiscoverResultSchema = z.looseObject({
	id: z.number(),
	mediaType: z.enum(["movie", "tv"]),
	title: z.string().optional(),
	name: z.string().optional(),
	originalTitle: z.string().optional(),
	originalName: z.string().optional(),
	overview: z.string().optional(),
	posterPath: z.string().nullable().optional(),
	backdropPath: z.string().nullable().optional(),
	releaseDate: z.string().optional(),
	firstAirDate: z.string().optional(),
	voteAverage: z.number().optional(),
	voteCount: z.number().optional(),
	popularity: z.number().optional(),
	genreIds: z.array(z.number()).optional(),
	originalLanguage: z.string().optional(),
	adult: z.boolean().optional(),
	mediaInfo: seerrMediaInfoSchema.optional(),
});

/** Mirrors SeerrDiscoverResponse */
export const seerrDiscoverResponseSchema = z.looseObject({
	page: z.number(),
	totalPages: z.number(),
	totalResults: z.number(),
	results: z.array(seerrDiscoverResultSchema),
});

// ============================================================================
// Additional Schemas (Phase 1B — gap closure for unvalidated endpoints)
// ============================================================================

/** Mirrors SeerrIssueComment */
export const seerrIssueCommentSchema = z.looseObject({
	id: z.number(),
	message: z.string(),
	createdAt: z.string(),
	user: seerrUserSchema,
});

/** Mirrors SeerrIssue — issueType 1-4 matches SeerrIssueType, status 1-2 matches SeerrIssueStatus */
export const seerrIssueSchema = z.looseObject({
	id: z.number(),
	issueType: z.number().int().min(1).max(4),
	status: z.number().int().min(1).max(2),
	problemSeason: z.number(),
	problemEpisode: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
	createdBy: seerrUserSchema,
	comments: z.array(seerrIssueCommentSchema),
	media: seerrMediaInfoSchema.extend({
		posterPath: z.string().optional(),
		title: z.string().optional(),
	}),
});

/** Mirrors SeerrQuota */
export const seerrQuotaSchema = z.looseObject({
	movie: z.looseObject({
		used: z.number(),
		remaining: z.number(),
		restricted: z.boolean(),
		limit: z.number(),
		days: z.number(),
	}),
	tv: z.looseObject({
		used: z.number(),
		remaining: z.number(),
		restricted: z.boolean(),
		limit: z.number(),
		days: z.number(),
	}),
});

/** Mirrors SeerrGenre */
export const seerrGenreSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
});

/** Mirrors SeerrCastMember */
const seerrCastMemberSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	character: z.string().optional(),
	profilePath: z.string().nullable().optional(),
	order: z.number().optional(),
});

/** Mirrors SeerrCrewMember */
const seerrCrewMemberSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	job: z.string().optional(),
	department: z.string().optional(),
	profilePath: z.string().nullable().optional(),
});

/** Mirrors SeerrCredits */
const seerrCreditsSchema = z.looseObject({
	cast: z.array(seerrCastMemberSchema),
	crew: z.array(seerrCrewMemberSchema),
});

/** Mirrors SeerrVideo */
const seerrVideoSchema = z.looseObject({
	key: z.string(),
	name: z.string().optional(),
	site: z.string(),
	type: z.string().optional(),
	size: z.number().optional(),
});

/** Mirrors SeerrExternalIds */
const seerrExternalIdsSchema = z.looseObject({
	imdbId: z.string().optional(),
	tvdbId: z.number().optional(),
	facebookId: z.string().optional(),
	instagramId: z.string().optional(),
	twitterId: z.string().optional(),
});

/** Mirrors SeerrMovieDetails */
export const seerrMovieDetailsSchema = z.looseObject({
	id: z.number(),
	title: z.string(),
	originalTitle: z.string().optional(),
	overview: z.string().optional(),
	posterPath: z.string().nullable().optional(),
	backdropPath: z.string().nullable().optional(),
	releaseDate: z.string().optional(),
	runtime: z.number().optional(),
	budget: z.number().optional(),
	revenue: z.number().optional(),
	voteAverage: z.number().optional(),
	voteCount: z.number().optional(),
	popularity: z.number().optional(),
	status: z.string().optional(),
	originalLanguage: z.string().optional(),
	genres: z.array(seerrGenreSchema),
	productionCompanies: z.array(z.looseObject({
		id: z.number(),
		name: z.string(),
		logoPath: z.string().nullable().optional(),
	})).optional(),
	credits: seerrCreditsSchema,
	relatedVideos: z.array(seerrVideoSchema).optional(),
	mediaInfo: seerrMediaInfoSchema.optional(),
	externalIds: seerrExternalIdsSchema.optional(),
	recommendations: seerrDiscoverResponseSchema,
	similar: seerrDiscoverResponseSchema,
});

/** Mirrors SeerrSeasonSummary */
const seerrSeasonSummarySchema = z.looseObject({
	id: z.number(),
	seasonNumber: z.number(),
	name: z.string().optional(),
	overview: z.string().optional(),
	episodeCount: z.number(),
	airDate: z.string().optional(),
	posterPath: z.string().nullable().optional(),
});

/** Mirrors SeerrTvDetails */
export const seerrTvDetailsSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	originalName: z.string().optional(),
	overview: z.string().optional(),
	posterPath: z.string().nullable().optional(),
	backdropPath: z.string().nullable().optional(),
	firstAirDate: z.string().optional(),
	lastAirDate: z.string().optional(),
	numberOfSeasons: z.number().optional(),
	numberOfEpisodes: z.number().optional(),
	episodeRunTime: z.array(z.number()).optional(),
	voteAverage: z.number().optional(),
	voteCount: z.number().optional(),
	popularity: z.number().optional(),
	status: z.string().optional(),
	originalLanguage: z.string().optional(),
	genres: z.array(seerrGenreSchema),
	networks: z.array(z.looseObject({
		id: z.number(),
		name: z.string(),
		logoPath: z.string().nullable().optional(),
	})).optional(),
	credits: seerrCreditsSchema,
	relatedVideos: z.array(seerrVideoSchema).optional(),
	mediaInfo: seerrMediaInfoSchema.optional(),
	externalIds: seerrExternalIdsSchema.optional(),
	keywords: z.array(z.looseObject({ id: z.number(), name: z.string() })),
	seasons: z.array(seerrSeasonSummarySchema),
	recommendations: seerrDiscoverResponseSchema,
	similar: seerrDiscoverResponseSchema,
});

/** Lightweight schema for getMediaSummary — only validates fields we extract */
export const seerrMediaSummarySchema = z.looseObject({
	voteAverage: z.number().optional(),
	backdropPath: z.string().nullable().optional(),
	posterPath: z.string().nullable().optional(),
});

/** Mirrors SeerrCreateRequestResponse */
export const seerrCreateRequestResponseSchema = z.looseObject({
	id: z.number(),
	status: z.number().int().min(1).max(5),
	type: z.enum(["movie", "tv"]),
	media: seerrMediaInfoSchema,
	createdAt: z.string(),
	is4k: z.boolean(),
	seasons: z.array(seerrSeasonSchema).optional(),
});

/** Mirrors SeerrServiceServer */
export const seerrServiceServerSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	is4k: z.boolean(),
	isDefault: z.boolean(),
	activeProfileId: z.number(),
	activeDirectory: z.string(),
	activeLanguageProfileId: z.number().optional(),
	activeAnimeProfileId: z.number().optional(),
	activeAnimeDirectory: z.string().optional(),
	activeAnimeLanguageProfileId: z.number().optional(),
	activeTags: z.array(z.number()),
});

/** Mirrors SeerrQualityProfile */
const seerrQualityProfileSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
});

/** Mirrors SeerrRootFolder */
const seerrRootFolderSchema = z.looseObject({
	id: z.number(),
	path: z.string(),
	freeSpace: z.number().optional(),
	totalSpace: z.number().optional(),
});

/** Mirrors SeerrTag */
const seerrTagSchema = z.looseObject({
	id: z.number(),
	label: z.string(),
});

/** Mirrors SeerrServerWithDetails */
export const seerrServerWithDetailsSchema = z.looseObject({
	server: seerrServiceServerSchema,
	profiles: z.array(seerrQualityProfileSchema),
	rootFolders: z.array(seerrRootFolderSchema),
	languageProfiles: z.array(z.looseObject({ id: z.number(), name: z.string() })).optional(),
	tags: z.array(seerrTagSchema),
});

// ============================================================================
// Library Enrichment Types
// ============================================================================

/** TMDB enrichment data for a single library item */
export interface LibraryEnrichmentItem {
	voteAverage: number | null;
	backdropPath: string | null;
	posterPath: string | null;
	openIssueCount: number;
}

/** Batch enrichment response keyed by "movie:{tmdbId}" or "tv:{tmdbId}" */
export interface LibraryEnrichmentResponse {
	items: Record<string, LibraryEnrichmentItem>;
	/** False when issue count fetch failed — openIssueCount values are unreliable */
	issueCountsAvailable?: boolean;
	/** Number of media enrichment lookups that failed */
	enrichmentFailures?: number;
}
