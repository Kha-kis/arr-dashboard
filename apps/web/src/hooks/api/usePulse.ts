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
import { huntingKeys, pulseKeys, queueCleanerKeys } from "../../lib/query-keys";

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
					// No cache.refresh collector emits yet (PR 3), but keep
					// the success toast generic so the mutation hook is
					// future-ready without extra code churn.
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
			return "Cache refresh triggered";
	}
}
