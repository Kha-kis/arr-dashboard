/**
 * Tracearr API Client
 *
 * Frontend API functions for the Tracearr integration (charter §2.2).
 * All requests are proxied through Next.js rewrites → Fastify backend.
 */

import type {
	TracearrActivityBundle,
	TracearrHistoryBundle,
	TracearrLiveSessionsResponse,
	TracearrStatsBundle,
	TracearrTerminateResponse,
	TracearrUsersBundle,
	TracearrViolationsBundle,
} from "@arr/shared";
import { apiRequest } from "./base";

type ActivityPeriod = "week" | "month" | "year";

/**
 * Aggregate live-session view for the Console "Live Sessions" card. Sums the
 * stream summaries of every enabled Tracearr instance server-side; an
 * unreachable instance degrades to `reachable: false` rather than failing.
 */
export async function fetchTracearrLiveSessions(): Promise<TracearrLiveSessionsResponse> {
	return apiRequest("/api/tracearr/streams");
}

/**
 * Kill a live session (Tracearr-3). Both ids are required: `instanceId`
 * routes + ownership-checks the owning Tracearr, `streamId` is the target.
 * `reason`, when given, is forwarded to the terminated user's player.
 */
export async function terminateTracearrSession(args: {
	instanceId: string;
	streamId: string;
	reason?: string;
}): Promise<TracearrTerminateResponse> {
	const { instanceId, streamId, reason } = args;
	return apiRequest(
		`/api/tracearr/instances/${encodeURIComponent(instanceId)}/streams/${encodeURIComponent(streamId)}/terminate`,
		{ method: "POST", json: reason ? { reason } : {} },
	);
}

/**
 * All-time + today's rollup counters from the user's Tracearr hub instance
 * (charter C2 Statistics tab).
 */
export async function fetchTracearrStats(): Promise<TracearrStatsBundle> {
	return apiRequest("/api/tracearr/stats");
}

/** Aggregated play/quality/platform time-series for the given period. */
export async function fetchTracearrActivity(
	period: ActivityPeriod,
): Promise<TracearrActivityBundle> {
	return apiRequest(`/api/tracearr/activity?period=${encodeURIComponent(period)}`);
}

/** Paginated watch history (C2b). Fixed pageSize; `page` is 1-based. */
export async function fetchTracearrHistory(page: number): Promise<TracearrHistoryBundle> {
	return apiRequest(`/api/tracearr/history?page=${page}&pageSize=25`);
}

/** Paginated Tracearr users with trust scores + violation counts (C2b). */
export async function fetchTracearrUsers(page: number): Promise<TracearrUsersBundle> {
	return apiRequest(`/api/tracearr/users?page=${page}&pageSize=25`);
}

/** Paginated account-sharing violations (C2b). */
export async function fetchTracearrViolations(page: number): Promise<TracearrViolationsBundle> {
	return apiRequest(`/api/tracearr/violations?page=${page}&pageSize=25`);
}
