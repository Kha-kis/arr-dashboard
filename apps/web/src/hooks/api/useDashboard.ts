"use client";

import type {
	DashboardStatisticsResponse,
	MultiInstanceCalendarResponse,
	MultiInstanceHistoryResponse,
	MultiInstanceQueueResponse,
} from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
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

export const useMultiInstanceHistoryQuery = (params?: {
	startDate?: string;
	endDate?: string;
	page?: number;
	pageSize?: number;
}) =>
	useQuery<MultiInstanceHistoryResponse>({
		queryKey: dashboardKeys.history(params ?? {}),
		queryFn: () => fetchMultiInstanceHistory(params),
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes - cleanup old param combinations
		refetchInterval: POLLING_STANDARD,
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
