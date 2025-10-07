"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import type {
	MultiInstanceSearchResponse,
	ProwlarrIndexerDetails,
	SearchGrabRequest,
	SearchIndexersResponse,
	SearchIndexerTestRequest,
	SearchIndexerTestResponse,
	SearchRequest,
} from "@arr/shared";
import {
	fetchSearchIndexers,
	fetchSearchIndexerDetails,
	performManualSearch,
	grabManualSearchResult,
	testSearchIndexer,
	updateSearchIndexer,
} from "../../lib/api-client/search";

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

export const useGrabSearchResultMutation = () =>
	useMutation<void, unknown, SearchGrabRequest>({
		mutationFn: grabManualSearchResult,
	});

export const useTestIndexerMutation = () =>
	useMutation<SearchIndexerTestResponse, unknown, SearchIndexerTestRequest>({
		mutationFn: testSearchIndexer,
	});

export const useIndexerDetailsQuery = (
	instanceId: string | null,
	indexerId: number | null,
	enabled = false,
) =>
	useQuery<ProwlarrIndexerDetails>({
		queryKey: ["search", "indexers", "details", instanceId, indexerId],
		queryFn: () => fetchSearchIndexerDetails(instanceId!, indexerId!),
		enabled: Boolean(enabled && instanceId && indexerId !== null),
		staleTime: 60 * 1000,
	});

export const useUpdateIndexerMutation = () =>
	useMutation<
		ProwlarrIndexerDetails,
		unknown,
		{ instanceId: string; indexerId: number; indexer: ProwlarrIndexerDetails }
	>({
		mutationFn: ({ instanceId, indexerId, indexer }) =>
			updateSearchIndexer(instanceId, indexerId, indexer),
	});
