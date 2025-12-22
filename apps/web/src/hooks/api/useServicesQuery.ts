"use client";

import { useQuery } from "@tanstack/react-query";
import type { ServiceInstanceSummary } from "@arr/shared";
import { fetchServices } from "../../lib/api-client/services";
import { useCurrentUser } from "./useAuth";

interface ServicesQueryOptions {
	/**
	 * Override the default enabled behavior.
	 * By default, query is enabled when user is authenticated.
	 */
	enabled?: boolean;
}

/**
 * Hook to fetch service instances.
 * Automatically waits for user authentication before fetching.
 * This prevents race conditions where services appear as "0" during auth check.
 */
export const useServicesQuery = (options: ServicesQueryOptions = {}) => {
	const { data: currentUser, isLoading: userLoading } = useCurrentUser();

	// Default: enabled when user is authenticated and not loading
	const isEnabled = options.enabled ?? (Boolean(currentUser) && !userLoading);

	return useQuery<ServiceInstanceSummary[]>({
		queryKey: ["services"],
		queryFn: fetchServices,
		staleTime: 30 * 1000, // 30 seconds - services don't change frequently
		enabled: isEnabled,
		// Don't set initialData - let the query be in pending state until it runs
		// This prevents showing "0 instances" during the auth check
		refetchOnMount: true, // Refetch if stale, but not always
	});
};
