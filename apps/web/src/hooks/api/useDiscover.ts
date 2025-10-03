"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DiscoverAddRequest,
  DiscoverAddResponse,
  DiscoverInstanceOptionsResponse,
  DiscoverSearchResponse,
  DiscoverSearchType,
} from "@arr/shared";
import { addDiscoverItem, fetchDiscoverOptions, fetchDiscoverResults } from "../../lib/api-client/discover";

interface DiscoverSearchQueryOptions {
  query: string;
  type: DiscoverSearchType;
  enabled?: boolean;
}

export const useDiscoverSearchQuery = ({ query, type, enabled = true }: DiscoverSearchQueryOptions) =>
  useQuery<DiscoverSearchResponse>({
    queryKey: ["discover", "search", { query, type }],
    queryFn: () => fetchDiscoverResults({ query, type }),
    enabled: enabled && query.trim().length > 0,
    staleTime: 30 * 1000,
  });

export const useDiscoverOptionsQuery = (
  instanceId: string | null,
  type: DiscoverSearchType,
  enabled = false,
) =>
  useQuery<DiscoverInstanceOptionsResponse | null>({
    queryKey: ["discover", "options", { instanceId, type }],
    queryFn: () => (instanceId ? fetchDiscoverOptions(instanceId, type) : Promise.resolve(null)),
    enabled: enabled && Boolean(instanceId),
    staleTime: 5 * 60 * 1000,
  });

export const useDiscoverAddMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<DiscoverAddResponse, unknown, DiscoverAddRequest>({
    mutationFn: addDiscoverItem,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["discover", "search"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
};
