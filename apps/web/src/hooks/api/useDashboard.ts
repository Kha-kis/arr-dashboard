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

export const useMultiInstanceQueueQuery = () =>
	useQuery<MultiInstanceQueueResponse>({
		queryKey: ["dashboard", "queue"],
		queryFn: fetchMultiInstanceQueue,
		staleTime: 10 * 1000,
		gcTime: 60 * 1000, // 1 minute - short gcTime for frequently polled data
		refetchInterval: 10 * 1000,
	});

export const useMultiInstanceHistoryQuery = (params?: {
	startDate?: string;
	endDate?: string;
	page?: number;
	pageSize?: number;
}) =>
	useQuery<MultiInstanceHistoryResponse>({
		queryKey: ["dashboard", "history", params],
		queryFn: () => fetchMultiInstanceHistory(params),
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes - cleanup old param combinations
		refetchInterval: 60 * 1000,
	});

export const useMultiInstanceCalendarQuery = (params: {
	start: string;
	end: string;
	unmonitored?: boolean;
}) =>
	useQuery<MultiInstanceCalendarResponse>({
		queryKey: ["dashboard", "calendar", params],
		queryFn: () => fetchMultiInstanceCalendar(params),
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes - cleanup old date ranges
		refetchInterval: 60 * 1000,
	});

export const useDashboardStatisticsQuery = () =>
	useQuery<DashboardStatisticsResponse>({
		queryKey: ["dashboard", "statistics"],
		queryFn: fetchDashboardStatistics,
		staleTime: 60 * 1000,
		gcTime: 2 * 60 * 1000, // 2 minutes
		refetchInterval: 120 * 1000,
	});
