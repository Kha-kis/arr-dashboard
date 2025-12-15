import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { FilterOptions } from "../lib/hunting-types";

async function fetchFilterOptions(instanceId: string): Promise<FilterOptions> {
	return apiRequest<FilterOptions>(`/api/hunting/filter-options/${instanceId}`);
}

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
