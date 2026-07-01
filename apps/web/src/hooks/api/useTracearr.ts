"use client";

import type { TracearrLiveSessionsResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchTracearrLiveSessions } from "../../lib/api-client/tracearr";
import { POLLING_REALTIME } from "../../lib/polling-intervals";
import { tracearrKeys } from "../../lib/query-keys";

interface TracearrLiveSessionsOptions {
	/**
	 * Gate the query on whether the user has an enabled Tracearr instance.
	 * The caller resolves this from the services query so we never poll a
	 * live-session endpoint for a user who hasn't configured Tracearr.
	 */
	enabled?: boolean;
}

/**
 * Aggregate live-session view for the Console "Live Sessions" card. Polls at
 * the "realtime" cadence (15s) — matching the per-server now-playing widgets
 * this card summarizes across, so the "live" surfaces refresh in lockstep.
 */
export const useTracearrLiveSessions = (options: TracearrLiveSessionsOptions = {}) =>
	useQuery<TracearrLiveSessionsResponse>({
		queryKey: tracearrKeys.liveSessions(),
		queryFn: fetchTracearrLiveSessions,
		enabled: options.enabled ?? true,
		refetchInterval: POLLING_REALTIME,
		staleTime: POLLING_REALTIME,
	});
