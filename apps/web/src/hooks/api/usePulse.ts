import type { PulseResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchPulse } from "../../lib/api-client/pulse";
import { POLLING_STATS } from "../../lib/polling-intervals";
import { pulseKeys } from "../../lib/query-keys";

export const usePulseQuery = () =>
	useQuery<PulseResponse>({
		queryKey: pulseKeys.all,
		queryFn: fetchPulse,
		staleTime: 60_000,
		refetchInterval: POLLING_STATS,
	});
