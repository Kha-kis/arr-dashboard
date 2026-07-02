"use client";

import type {
	TracearrActivityBundle,
	TracearrLiveSessionsResponse,
	TracearrStatsBundle,
	TracearrTerminateResponse,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	fetchTracearrActivity,
	fetchTracearrLiveSessions,
	fetchTracearrStats,
	terminateTracearrSession,
} from "../../lib/api-client/tracearr";
import { getErrorMessage } from "../../lib/error-utils";
import { anonymizeHealthMessage, useIncognitoMode } from "../../lib/incognito";
import { POLLING_REALTIME, POLLING_STATS } from "../../lib/polling-intervals";
import { tracearrKeys } from "../../lib/query-keys";

type ActivityPeriod = "week" | "month" | "year";

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

interface TerminateSessionVariables {
	instanceId: string;
	streamId: string;
	reason?: string;
}

/**
 * Kill-session mutation (Tracearr-3). On success, invalidates the live-session
 * query so the terminated session drops from the next render, and toasts the
 * outcome. Errors are incognito-sanitized before display (an error body could
 * echo a media title or username).
 */
export const useTerminateSession = () => {
	const queryClient = useQueryClient();
	const [incognito] = useIncognitoMode();

	return useMutation<TracearrTerminateResponse, Error, TerminateSessionVariables>({
		mutationFn: (vars) => terminateTracearrSession(vars),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: tracearrKeys.liveSessions() });
			toast.success("Session terminated");
		},
		onError: (error) => {
			const raw = getErrorMessage(error, "Couldn't terminate the session");
			toast.error(incognito ? anonymizeHealthMessage(raw) : raw);
		},
	});
};

interface TracearrAnalyticsOptions {
	/** Gate on Tracearr being configured (resolved from the services query). */
	enabled?: boolean;
}

/**
 * All-time + today's rollup counters for the Statistics "Tracearr" tab. This
 * is historical analytics, not live data, so it polls at the slow "stats"
 * cadence (2 min) rather than the live-session realtime rate.
 */
export const useTracearrStats = (options: TracearrAnalyticsOptions = {}) =>
	useQuery<TracearrStatsBundle>({
		queryKey: tracearrKeys.stats(),
		queryFn: fetchTracearrStats,
		enabled: options.enabled ?? true,
		staleTime: POLLING_STATS,
	});

/** Aggregated play/quality/platform time-series for the given period. */
export const useTracearrActivity = (
	period: ActivityPeriod,
	options: TracearrAnalyticsOptions = {},
) =>
	useQuery<TracearrActivityBundle>({
		queryKey: tracearrKeys.activity(period),
		queryFn: () => fetchTracearrActivity(period),
		enabled: options.enabled ?? true,
		staleTime: POLLING_STATS,
	});
