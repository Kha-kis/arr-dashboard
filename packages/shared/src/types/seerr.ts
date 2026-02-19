/**
 * Seerr shared types
 *
 * Response shapes and constants for the Seerr (merged Jellyseerr + Overseerr) integration.
 */

// ============================================================================
// Status Constants
// ============================================================================

export const SEERR_REQUEST_STATUS = {
	PENDING: 1,
	APPROVED: 2,
	DECLINED: 3,
} as const;

export const SEERR_REQUEST_STATUS_LABEL: Record<number, string> = {
	1: "Pending",
	2: "Approved",
	3: "Declined",
};

export const SEERR_MEDIA_STATUS = {
	UNKNOWN: 1,
	PENDING: 2,
	PROCESSING: 3,
	PARTIALLY_AVAILABLE: 4,
	AVAILABLE: 5,
} as const;

export const SEERR_MEDIA_STATUS_LABEL: Record<number, string> = {
	1: "Unknown",
	2: "Pending",
	3: "Processing",
	4: "Partially Available",
	5: "Available",
};

export const SEERR_ISSUE_TYPE = {
	VIDEO: 1,
	AUDIO: 2,
	SUBTITLE: 3,
	OTHER: 4,
} as const;

export const SEERR_ISSUE_TYPE_LABEL: Record<number, string> = {
	1: "Video",
	2: "Audio",
	3: "Subtitle",
	4: "Other",
};

export const SEERR_ISSUE_STATUS = {
	OPEN: 1,
	RESOLVED: 2,
} as const;

export const SEERR_ISSUE_STATUS_LABEL: Record<number, string> = {
	1: "Open",
	2: "Resolved",
};

// ============================================================================
// Response Types
// ============================================================================

export interface SeerrMediaInfo {
	id: number;
	tmdbId: number;
	tvdbId?: number;
	status: number;
	createdAt: string;
	updatedAt: string;
}

export interface SeerrRequest {
	id: number;
	status: number;
	type: "movie" | "tv";
	media: SeerrMediaInfo;
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
	mediaInfo?: {
		posterPath?: string;
		title?: string;
		originalTitle?: string;
		overview?: string;
	};
}

export interface SeerrSeason {
	id: number;
	seasonNumber: number;
	status: number;
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
	issueType: number;
	status: number;
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
	id: number;
	name: string;
	enabled: boolean;
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
