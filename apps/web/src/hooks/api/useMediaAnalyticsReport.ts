import type { MediaAnalyticsReport } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchMediaAnalyticsReport } from "../../lib/api-client/media-analytics-report";
import { POLLING_BACKGROUND } from "../../lib/polling-intervals";
import { jellyfinKeys, plexKeys } from "../../lib/query-keys";

export function useMediaAnalyticsReport(provider: MediaAnalyticsReport["provider"], days = 30) {
	const keys = provider === "plex" ? plexKeys : jellyfinKeys;
	return useQuery({
		queryKey: keys.analyticsReport(days),
		queryFn: ({ signal }) => fetchMediaAnalyticsReport(provider, days, signal),
		staleTime: POLLING_BACKGROUND,
		// A report is atomic. Retain same-scope query data on failure, but never
		// borrow a previous period/provider via a global placeholder policy.
		placeholderData: undefined,
		retry: false,
	});
}
