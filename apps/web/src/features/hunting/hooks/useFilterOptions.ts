import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { FilterOptions } from "../lib/hunting-types";

/**
 * Fetches hunting filter options for the specified instance.
 *
 * @param instanceId - The identifier of the hunting instance to retrieve filter options for
 * @returns The `FilterOptions` for the specified instance
 */
async function fetchFilterOptions(instanceId: string): Promise<FilterOptions> {
	return apiRequest<FilterOptions>(`/api/hunting/filter-options/${instanceId}`);
}

/**
 * Provides cached filter options and query controls for a hunting instance.
 *
 * @param instanceId - The hunting instance identifier used to fetch filter options; the hook is disabled when this value is falsy.
 * @returns An object containing the current `filterOptions`, `isLoading` state, any query `error`, and a `refetch` function to reload the options.
 */
export function useFilterOptions(instanceId: string) {
	const query = useQuery({
		queryKey: ["hunting", "filter-options", instanceId],
		queryFn: () => fetchFilterOptions(instanceId),
		staleTime: 5 * 60 * 1000, // 5 minutes - filter options don't change often
		enabled: !!instanceId,
	});

	return {
		filterOptions: query.data,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}