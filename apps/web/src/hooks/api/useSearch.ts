"use client";

import type {
	MultiInstanceSearchResponse,
	ProwlarrIndexerDetails,
	ProwlarrIndexerHealth,
	SearchGrabRequest,
	SearchIndexersResponse,
	SearchIndexerTestRequest,
	SearchIndexerTestResponse,
	SearchIndexerUpdateChanges,
	SearchIndexerUpdateOutcome,
	SearchRequest,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fetchSearchIndexerDetails,
	fetchSearchIndexers,
	grabManualSearchResult,
	performManualSearch,
	testSearchIndexer,
	updateSearchIndexer,
} from "../../lib/api-client/search";
import { QUEUE_QUERY_KEY } from "../../lib/query-keys";

export const useSearchIndexersQuery = () =>
	useQuery<SearchIndexersResponse>({
		queryKey: ["search", "indexers"],
		queryFn: fetchSearchIndexers,
		staleTime: 5 * 60 * 1000,
	});

export const useManualSearchMutation = () =>
	useMutation<MultiInstanceSearchResponse, unknown, SearchRequest>({
		mutationFn: performManualSearch,
	});

export const useGrabSearchResultMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<void, unknown, SearchGrabRequest>({
		mutationFn: grabManualSearchResult,
		retry: false,
		onSuccess: () => {
			// Grabbing a release adds it to the queue
			void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});
};

export const useTestIndexerMutation = () =>
	useMutation<SearchIndexerTestResponse, unknown, SearchIndexerTestRequest>({
		mutationFn: testSearchIndexer,
	});

export const useIndexerDetailsQuery = (
	instanceId: string | null,
	indexerId: number | null,
	enabled = false,
	health?: ProwlarrIndexerHealth,
) =>
	useQuery<ProwlarrIndexerDetails>({
		queryKey: ["search", "indexers", "details", instanceId, indexerId],
		queryFn: () => fetchSearchIndexerDetails(instanceId!, indexerId!, health),
		enabled: Boolean(enabled && instanceId && indexerId !== null),
		staleTime: 60 * 1000,
	});

export const useUpdateIndexerMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SearchIndexerUpdateOutcome,
		unknown,
		{ instanceId: string; indexerId: number; changes: SearchIndexerUpdateChanges }
	>({
		mutationFn: ({ instanceId, indexerId, changes }) =>
			updateSearchIndexer(instanceId, indexerId, changes),
		onSettled: (_data, _error, variables) => {
			void queryClient.invalidateQueries({ queryKey: ["search", "indexers"] });
			void queryClient.invalidateQueries({
				queryKey: ["search", "indexers", "details", variables.instanceId, variables.indexerId],
			});
		},
	});
};
