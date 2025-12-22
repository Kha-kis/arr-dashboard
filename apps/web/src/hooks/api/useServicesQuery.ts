"use client";

import { useQuery } from "@tanstack/react-query";
import type { ServiceInstanceSummary } from "@arr/shared";
import { fetchServices } from "../../lib/api-client/services";

interface ServicesQueryOptions {
	enabled?: boolean;
}

export const useServicesQuery = (options: ServicesQueryOptions = {}) =>
	useQuery<ServiceInstanceSummary[]>({
		queryKey: ["services"],
		queryFn: fetchServices,
		staleTime: 30 * 1000, // 30 seconds - services don't change frequently
		enabled: options.enabled ?? true,
		// Don't set initialData - let the query be in pending state until it runs
		// This prevents showing "0 instances" during the auth check
		refetchOnMount: true, // Refetch if stale, but not always
	});
