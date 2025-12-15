import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntingStatus } from "../lib/hunting-types";

async function fetchHuntingStatus(): Promise<HuntingStatus> {
	return apiRequest<HuntingStatus>("/api/hunting/status");
}

export function useHuntingStatus() {
	const query = useQuery({
		queryKey: ["hunting", "status"],
		queryFn: fetchHuntingStatus,
		refetchInterval: 30000, // Refresh every 30 seconds
	});

	return {
		status: query.data ?? null,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}
