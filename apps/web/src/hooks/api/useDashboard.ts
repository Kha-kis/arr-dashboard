"use client";

import { useQuery } from "@tanstack/react-query";
import type {
	MultiInstanceQueueResponse,
	MultiInstanceHistoryResponse,
	MultiInstanceCalendarResponse,
	DashboardStatisticsResponse,
} from "@arr/shared";
import {
	fetchMultiInstanceQueue,
	fetchMultiInstanceHistory,
	fetchMultiInstanceCalendar,
	fetchDashboardStatistics,
} from "../../lib/api-client/dashboard";

export const useMultiInstanceQueueQuery = () =>
	useQuery<MultiInstanceQueueResponse>({
		queryKey: ["dashboard", "queue"],
		queryFn: fetchMultiInstanceQueue,
		staleTime: 30 * 1000,
		refetchInterval: 30 * 1000,
	});

export const useMultiInstanceHistoryQuery = (params?: {
	startDate?: string;
	endDate?: string;
}) =>
	useQuery<MultiInstanceHistoryResponse>({
		queryKey: ["dashboard", "history", params],
		queryFn: () => fetchMultiInstanceHistory(params),
		staleTime: 60 * 1000,
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
		refetchInterval: 60 * 1000,
	});

export const useDashboardStatisticsQuery = () =>
	useQuery<DashboardStatisticsResponse>({
		queryKey: ["dashboard", "statistics"],
		queryFn: fetchDashboardStatistics,
		staleTime: 60 * 1000,
		refetchInterval: 120 * 1000,
	});
