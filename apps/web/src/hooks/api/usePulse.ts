import type { PulseAction, PulseResponse } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	dispatchPulseAction,
	fetchPulse,
	type PulseActionResponse,
} from "../../lib/api-client/pulse";
import { getErrorMessage } from "../../lib/error-utils";
import { POLLING_STATS } from "../../lib/polling-intervals";
import {
	dashboardKeys,
	huntingKeys,
	plexKeys,
	pulseKeys,
	queueCleanerKeys,
	tautulliKeys,
} from "../../lib/query-keys";

export interface UsePulseQueryOptions {
	attentionOnly?: boolean;
}

export const usePulseQuery = (options: UsePulseQueryOptions = {}) => {
	const attentionOnly = options.attentionOnly ?? false;
	return useQuery<PulseResponse>({
		queryKey: attentionOnly ? pulseKeys.attention() : pulseKeys.all,
		queryFn: () => fetchPulse({ attentionOnly }),
		staleTime: 60_000,
		refetchInterval: POLLING_STATS,
	});
};

/**
 * Dispatch a Pulse action for a specific signal. Single source of truth
 * for Pulse action side effects: invalidate the Pulse feeds and any
 * domain-specific keys the action touches, and surface success/error
 * toasts with stable copy.
 */
export interface PulseActionVariables {
	signalId: string;
	action: PulseAction;
}

export const usePulseActionMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<PulseActionResponse, Error, PulseActionVariables>({
		mutationFn: ({ signalId, action }) => dispatchPulseAction(signalId, action),
		onSuccess: (_result, { action }) => {
			// Pulse is always invalidated so the resolved row drops from
			// both the full feed and the dashboard attention panel.
			queryClient.invalidateQueries({ queryKey: pulseKeys.all });
			queryClient.invalidateQueries({ queryKey: pulseKeys.attention() });

			// Domain-specific invalidation so status widgets update in-place.
			switch (action.kind) {
				case "scheduler.enable":
					if (action.target.jobId === "hunting") {
						queryClient.invalidateQueries({ queryKey: huntingKeys.status });
					} else {
						queryClient.invalidateQueries({ queryKey: queueCleanerKeys.status });
					}
					toast.success(successCopyForAction(action));
					break;
				case "cache.refresh":
					// The cache health banner (/api/plex/cache/health) is
					// shared across plex + tautulli, so plexKeys.cacheHealth
					// is the right key for both branches. Also drop the
					// domain root key so downstream Plex/Tautulli widgets
					// that depend on the refreshed cache repaint on next
					// mount without waiting for their own stale window.
					queryClient.invalidateQueries({ queryKey: plexKeys.cacheHealth() });
					if (action.target.cacheType === "plex") {
						queryClient.invalidateQueries({ queryKey: plexKeys.all });
					} else {
						queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
					}
					toast.success(successCopyForAction(action));
					break;
				case "queue.retry":
					// Drop the whole dashboard queue key — the retried item's
					// state changed on the ARR side, so the next poll from
					// GET /dashboard/queue will reflect the new queue
					// contents (most likely: the item is gone from the list
					// entirely, which is the success signal we want).
					queryClient.invalidateQueries({ queryKey: dashboardKeys.queue });
					toast.success(successCopyForAction(action));
					break;
			}
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Action failed"));
		},
	});
};

function successCopyForAction(action: PulseAction): string {
	switch (action.kind) {
		case "scheduler.enable":
			return action.target.jobId === "hunting"
				? "Hunt scheduler enabled"
				: "Queue cleaner scheduler enabled";
		case "cache.refresh":
			return action.target.cacheType === "plex"
				? "Plex cache refresh triggered"
				: "Tautulli cache refresh triggered";
		case "queue.retry":
			return "Retry queued";
	}
}
