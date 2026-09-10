"use client";

import type {
	DashboardStatisticsResponse,
	HistoryResponseV2,
	MultiInstanceCalendarResponse,
	MultiInstanceQueueResponse,
} from "@arr/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { HistoryRequest } from "../../lib/api-client/dashboard";
import {
	fetchDashboardStatistics,
	fetchMultiInstanceCalendar,
	fetchMultiInstanceHistory,
	fetchMultiInstanceQueue,
} from "../../lib/api-client/dashboard";
import { POLLING_ACTIVE, POLLING_STANDARD, POLLING_STATS } from "../../lib/polling-intervals";
import { dashboardKeys } from "../../lib/query-keys";

export const useMultiInstanceQueueQuery = () =>
	useQuery<MultiInstanceQueueResponse>({
		queryKey: dashboardKeys.queue,
		queryFn: fetchMultiInstanceQueue,
		staleTime: 25_000,
		gcTime: 60 * 1000, // 1 minute - short gcTime for frequently polled data
		refetchInterval: POLLING_ACTIVE,
	});

export const useMultiInstanceHistoryQuery = (params: HistoryRequest & { chainRevision: number }) =>
	useInfiniteQuery<
		HistoryResponseV2,
		Error,
		InfiniteData<HistoryResponseV2>,
		ReturnType<typeof dashboardKeys.history>,
		string | null
	>({
		queryKey: dashboardKeys.history(
			(({ cursor: _cursor, ...keyParams }) => keyParams)(params) as unknown as Record<
				string,
				unknown
			>,
		),
		initialPageParam: null,
		queryFn: ({ pageParam }) => {
			const { chainRevision: _chainRevision, cursor: _cursor, ...request } = params;
			return fetchMultiInstanceHistory({ ...request, cursor: pageParam });
		},
		getNextPageParam: (lastPage) =>
			lastPage.pageInfo.hasNextPage && lastPage.pageInfo.nextCursor
				? lastPage.pageInfo.nextCursor
				: undefined,
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes - cleanup old param combinations
		retry: false,
		refetchInterval: false,
	});

export const useMultiInstanceCalendarQuery = (params: {
	start: string;
	end: string;
	unmonitored?: boolean;
}) =>
	useQuery<MultiInstanceCalendarResponse>({
		queryKey: dashboardKeys.calendar(params),
		queryFn: () => fetchMultiInstanceCalendar(params),
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes - cleanup old date ranges
		refetchInterval: POLLING_STANDARD,
	});

export const useDashboardStatisticsQuery = () =>
	useQuery<DashboardStatisticsResponse>({
		queryKey: dashboardKeys.statistics,
		queryFn: fetchDashboardStatistics,
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes
		refetchInterval: POLLING_STATS,
	});
