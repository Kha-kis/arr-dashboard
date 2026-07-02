/**
 * Tracearr API Client
 *
 * Frontend API functions for the Tracearr integration (charter §2.2).
 * All requests are proxied through Next.js rewrites → Fastify backend.
 */

import type { TracearrLiveSessionsResponse, TracearrTerminateResponse } from "@arr/shared";
import { apiRequest } from "./base";

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
