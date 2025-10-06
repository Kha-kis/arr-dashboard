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
    staleTime: 60 * 1000,
    enabled: options.enabled ?? true,
    initialData: options.enabled === false ? [] : undefined,
  });
