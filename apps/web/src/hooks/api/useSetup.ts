'use client';

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";

interface SetupRequiredResponse {
  required: boolean;
}

export const useSetupRequired = () =>
  useQuery<boolean>({
    queryKey: ["setup-required"],
    queryFn: async () => {
      try {
        const data = await apiRequest<SetupRequiredResponse>("/auth/setup-required");
        console.log("Setup required response:", data);
        return data.required;
      } catch (error) {
        // If the endpoint fails, assume setup is not required
        console.error("Failed to check setup status:", error);
        return false;
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
