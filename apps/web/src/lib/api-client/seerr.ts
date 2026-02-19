/**
 * Seerr API Client (Frontend)
 *
 * Functions calling apiRequest() for each Seerr backend route.
 */

import type {
	SeerrRequest,
	SeerrRequestCount,
	SeerrUser,
	SeerrQuota,
	SeerrIssue,
	SeerrIssueComment,
	SeerrNotificationAgent,
	SeerrStatus,
	SeerrPageResult,
	SeerrRequestParams,
	SeerrIssueParams,
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

export { type SeerrUserUpdateData as UpdateSeerrUserPayload } from "@arr/shared";

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
