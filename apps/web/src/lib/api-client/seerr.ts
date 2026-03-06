/**
 * Seerr API Client (Frontend)
 *
 * Functions calling apiRequest() for each Seerr backend route.
 */

import type {
	LibraryEnrichmentResponse,
	SeerrCreateRequestPayload,
	SeerrCreateRequestResponse,
	SeerrDiscoverResponse,
	SeerrGenre,
	SeerrIssue,
	SeerrIssueComment,
	SeerrIssueParams,
	SeerrMovieDetails,
	SeerrNotificationAgent,
	SeerrPageResult,
	SeerrQuota,
	SeerrRequest,
	SeerrRequestCount,
	SeerrRequestOptions,
	SeerrRequestParams,
	SeerrStatus,
	SeerrTvDetails,
	SeerrUser,
	SeerrUserParams,
	SeerrUserUpdateData,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Requests
// ============================================================================

export interface FetchSeerrRequestsParams extends SeerrRequestParams {
	instanceId: string;
}

export async function fetchSeerrRequests(
	params: FetchSeerrRequestsParams,
): Promise<SeerrPageResult<SeerrRequest>> {
	const { instanceId, ...query } = params;
	const qs = buildQueryString(query);
	return apiRequest(`/api/seerr/requests/${instanceId}${qs}`);
}

export async function fetchSeerrRequestCount(instanceId: string): Promise<SeerrRequestCount> {
	return apiRequest(`/api/seerr/requests/${instanceId}/count`);
}

export async function fetchSeerrRequest(
	instanceId: string,
	requestId: number,
): Promise<SeerrRequest> {
	return apiRequest(`/api/seerr/requests/${instanceId}/${requestId}`);
}

export async function approveSeerrRequest(
	instanceId: string,
	requestId: number,
): Promise<SeerrRequest> {
	return apiRequest(`/api/seerr/requests/${instanceId}/${requestId}/approve`, { method: "POST" });
}

export async function declineSeerrRequest(
	instanceId: string,
	requestId: number,
): Promise<SeerrRequest> {
	return apiRequest(`/api/seerr/requests/${instanceId}/${requestId}/decline`, { method: "POST" });
}

export async function deleteSeerrRequest(instanceId: string, requestId: number): Promise<void> {
	return apiRequest(`/api/seerr/requests/${instanceId}/${requestId}`, { method: "DELETE" });
}

export async function retrySeerrRequest(
	instanceId: string,
	requestId: number,
): Promise<SeerrRequest> {
	return apiRequest(`/api/seerr/requests/${instanceId}/${requestId}/retry`, { method: "POST" });
}

// ============================================================================
// Bulk Actions
// ============================================================================

export interface BulkRequestResult {
	results: { requestId: number; success: boolean; error?: string }[];
	totalSuccess: number;
	totalFailed: number;
}

export async function bulkSeerrRequestAction(
	instanceId: string,
	action: "approve" | "decline" | "delete",
	requestIds: number[],
): Promise<BulkRequestResult> {
	return apiRequest(`/api/seerr/requests/${instanceId}/bulk`, {
		method: "POST",
		json: { action, requestIds },
	});
}

// ============================================================================
// Users
// ============================================================================

export interface FetchSeerrUsersParams extends SeerrUserParams {
	instanceId: string;
}

export async function fetchSeerrUsers(
	params: FetchSeerrUsersParams,
): Promise<SeerrPageResult<SeerrUser>> {
	const { instanceId, ...query } = params;
	const qs = buildQueryString(query);
	return apiRequest(`/api/seerr/users/${instanceId}${qs}`);
}

export async function fetchSeerrUserQuota(
	instanceId: string,
	seerrUserId: number,
): Promise<SeerrQuota> {
	return apiRequest(`/api/seerr/users/${instanceId}/${seerrUserId}/quota`);
}

export type { SeerrUserUpdateData as UpdateSeerrUserPayload } from "@arr/shared";

export async function updateSeerrUser(
	instanceId: string,
	seerrUserId: number,
	data: SeerrUserUpdateData,
): Promise<SeerrUser> {
	return apiRequest(`/api/seerr/users/${instanceId}/${seerrUserId}`, { method: "PUT", json: data });
}

// ============================================================================
// Issues
// ============================================================================

export interface FetchSeerrIssuesParams extends SeerrIssueParams {
	instanceId: string;
}

export async function fetchSeerrIssues(
	params: FetchSeerrIssuesParams,
): Promise<SeerrPageResult<SeerrIssue>> {
	const { instanceId, ...query } = params;
	const qs = buildQueryString(query);
	return apiRequest(`/api/seerr/issues/${instanceId}${qs}`);
}

export async function addSeerrIssueComment(
	instanceId: string,
	issueId: number,
	message: string,
): Promise<SeerrIssueComment> {
	return apiRequest(`/api/seerr/issues/${instanceId}/${issueId}/comment`, {
		method: "POST",
		json: { message },
	});
}

export async function updateSeerrIssueStatus(
	instanceId: string,
	issueId: number,
	status: "open" | "resolved",
): Promise<SeerrIssue> {
	return apiRequest(`/api/seerr/issues/${instanceId}/${issueId}`, {
		method: "PUT",
		json: { status },
	});
}

// ============================================================================
// Notifications
// ============================================================================

export async function fetchSeerrNotifications(
	instanceId: string,
): Promise<{ agents: SeerrNotificationAgent[] }> {
	return apiRequest(`/api/seerr/notifications/${instanceId}`);
}

export async function updateSeerrNotification(
	instanceId: string,
	agentId: string,
	config: Partial<SeerrNotificationAgent>,
): Promise<SeerrNotificationAgent> {
	return apiRequest(`/api/seerr/notifications/${instanceId}/${agentId}`, {
		method: "POST",
		json: config,
	});
}

export async function testSeerrNotification(instanceId: string, agentId: string): Promise<void> {
	return apiRequest(`/api/seerr/notifications/${instanceId}/${agentId}/test`, { method: "POST" });
}

// ============================================================================
// Status
// ============================================================================

export async function fetchSeerrStatus(instanceId: string): Promise<SeerrStatus> {
	return apiRequest(`/api/seerr/status/${instanceId}`);
}

export interface SeerrHealthResponse {
	status: "healthy" | "error" | "unknown";
	lastCheckedAt: string | null;
	error: string | null;
}

export async function fetchSeerrHealth(instanceId: string): Promise<SeerrHealthResponse> {
	return apiRequest(`/api/seerr/status/${instanceId}/health`);
}

export interface SeerrAuditLogEntry {
	id: string;
	action: string;
	targetType: string;
	targetId: string;
	detail: Record<string, unknown> | null;
	success: boolean;
	createdAt: string;
}

export async function clearSeerrCache(instanceId: string): Promise<{ cleared: number }> {
	return apiRequest(`/api/seerr/status/${instanceId}/cache/clear`, { method: "POST" });
}

export async function fetchSeerrAuditLog(
	instanceId: string,
	limit = 50,
): Promise<SeerrAuditLogEntry[]> {
	return apiRequest(`/api/seerr/status/${instanceId}/audit?limit=${limit}`);
}

// ============================================================================
// Discover
// ============================================================================

const BASE_DISCOVER = "/api/seerr/discover";

export async function fetchSeerrDiscoverMovies(
	instanceId: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/movies?page=${page}`);
}

export async function fetchSeerrDiscoverTv(
	instanceId: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/tv?page=${page}`);
}

export async function fetchSeerrDiscoverTrending(
	instanceId: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/trending?page=${page}`);
}

export async function fetchSeerrDiscoverMoviesUpcoming(
	instanceId: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/movies/upcoming?page=${page}`);
}

export async function fetchSeerrDiscoverTvUpcoming(
	instanceId: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/tv/upcoming?page=${page}`);
}

export async function fetchSeerrDiscoverByGenre(
	instanceId: string,
	mediaType: "movie" | "tv",
	genreId: number,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	const segment = mediaType === "movie" ? "movies" : "tv";
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/${segment}/genre/${genreId}?page=${page}`);
}

export async function fetchSeerrSearch(
	instanceId: string,
	query: string,
	page = 1,
): Promise<SeerrDiscoverResponse> {
	const qs = buildQueryString({ query, page });
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/search${qs}`);
}

export async function fetchSeerrMovieDetails(
	instanceId: string,
	tmdbId: number,
): Promise<SeerrMovieDetails> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/movie/${tmdbId}`);
}

export async function fetchSeerrTvDetails(
	instanceId: string,
	tmdbId: number,
): Promise<SeerrTvDetails> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/tv/${tmdbId}`);
}

export async function fetchSeerrGenres(
	instanceId: string,
	mediaType: "movie" | "tv",
): Promise<SeerrGenre[]> {
	const segment = mediaType === "movie" ? "movie" : "tv";
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/genres/${segment}`);
}

export async function fetchSeerrRequestOptions(
	instanceId: string,
	mediaType: "movie" | "tv",
): Promise<SeerrRequestOptions> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/request-options?mediaType=${mediaType}`);
}

export async function createSeerrRequest(
	instanceId: string,
	payload: SeerrCreateRequestPayload,
): Promise<SeerrCreateRequestResponse> {
	return apiRequest(`${BASE_DISCOVER}/${instanceId}/request`, { json: payload });
}

// ============================================================================
// Library Enrichment
// ============================================================================

export async function fetchLibraryEnrichment(
	instanceId: string,
	tmdbIds: number[],
	types: ("movie" | "tv")[],
): Promise<LibraryEnrichmentResponse> {
	const qs = buildQueryString({
		tmdbIds: tmdbIds.join(","),
		types: types.join(","),
	});
	return apiRequest(`/api/seerr/library-enrichment/${instanceId}${qs}`);
}

// ============================================================================
// Helpers
// ============================================================================

function buildQueryString(params: Record<string, unknown>): string {
	const entries = Object.entries(params).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return "";
	const qs = new URLSearchParams();
	for (const [key, value] of entries) {
		qs.set(key, String(value));
	}
	return `?${qs.toString()}`;
}
