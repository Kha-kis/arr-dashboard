"use client";

import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import type {
	DiscoverAddRequest,
	DiscoverAddResponse,
	DiscoverInstanceOptionsResponse,
	DiscoverSearchResponse,
	DiscoverSearchType,
	DiscoverTestOptionsRequest,
	DiscoverTestOptionsResponse,
	RecommendationsRequest,
	RecommendationsResponse,
} from "@arr/shared";
import {
	addDiscoverItem,
	fetchDiscoverOptions,
	fetchDiscoverResults,
	fetchRecommendations,
	fetchTestOptions,
} from "../../lib/api-client/discover";
import { QUEUE_QUERY_KEY } from "../../lib/query-keys";

interface DiscoverSearchQueryOptions {
	query: string;
	type: DiscoverSearchType;
	enabled?: boolean;
}

export const useDiscoverSearchQuery = ({
	query,
	type,
	enabled = true,
}: DiscoverSearchQueryOptions) =>
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

export const useDiscoverTestOptionsQuery = (
	request: DiscoverTestOptionsRequest | null,
	enabled = false,
) =>
	useQuery<DiscoverTestOptionsResponse | null>({
		queryKey: ["discover", "test-options", request],
		queryFn: () => (request ? fetchTestOptions(request) : Promise.resolve(null)),
		enabled: enabled && Boolean(request?.baseUrl && request?.apiKey && request?.service),
		staleTime: 5 * 60 * 1000,
	});

export const useDiscoverAddMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<DiscoverAddResponse, unknown, DiscoverAddRequest>({
		mutationFn: addDiscoverItem,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["discover", "search"] });
			void queryClient.invalidateQueries({ queryKey: ["library"] });
			// Adding content with search enabled will add items to the queue
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useRecommendationsQuery = (params: RecommendationsRequest, enabled = true) =>
	useQuery<RecommendationsResponse>({
		queryKey: ["recommendations", params.type, params.mediaType],
		queryFn: () => fetchRecommendations(params),
		enabled,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

export const useInfiniteRecommendationsQuery = (
	params: Omit<RecommendationsRequest, "page">,
	enabled = true,
) =>
	useInfiniteQuery<RecommendationsResponse>({
		queryKey: ["recommendations", "infinite", params.type, params.mediaType],
		queryFn: ({ pageParam = 1 }) => fetchRecommendations({ ...params, page: pageParam as number }),
		enabled,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 1000 * 60 * 2, // 2 minutes - shorter for infinite queries to prevent memory buildup
		maxPages: 5, // Limit accumulated pages to prevent memory leaks
		getNextPageParam: (lastPage) => {
			if (lastPage.page < lastPage.totalPages) {
				return lastPage.page + 1;
			}
			return undefined;
		},
		initialPageParam: 1,
	});
