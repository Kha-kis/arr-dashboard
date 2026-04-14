import type { PulseResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchPulse } from "../../lib/api-client/pulse";
import { POLLING_STATS } from "../../lib/polling-intervals";
import { pulseKeys } from "../../lib/query-keys";

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
