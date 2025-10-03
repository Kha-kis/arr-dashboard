'use client';

import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@arr/shared";
import { fetchCurrentUser } from "../../lib/api-client";

export const useCurrentUser = (enabled: boolean = true) =>
  useQuery<CurrentUser | null>({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    staleTime: 5 * 60 * 1000,
    retry: false,
    enabled,
  });
