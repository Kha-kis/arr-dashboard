/**
 * Tracearr API Client
 *
 * Frontend API functions for the Tracearr integration (charter §2.2).
 * All requests are proxied through Next.js rewrites → Fastify backend.
 */

import type { TracearrLiveSessionsResponse } from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Aggregate live-session view for the Console "Live Sessions" card. Sums the
 * stream summaries of every enabled Tracearr instance server-side; an
 * unreachable instance degrades to `reachable: false` rather than failing.
 */
export async function fetchTracearrLiveSessions(): Promise<TracearrLiveSessionsResponse> {
	return apiRequest("/api/tracearr/streams");
}
