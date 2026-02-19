"use client";

/**
 * React Query hooks for Seerr integration
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	SeerrRequest,
	SeerrRequestCount,
	SeerrUser,
	SeerrQuota,
	SeerrIssue,
	SeerrIssueComment,
	SeerrNotificationAgent,
	SeerrStatus,
	SeerrPageResult,
} from "@arr/shared";
import {
	fetchSeerrRequests,
	fetchSeerrRequestCount,
	approveSeerrRequest,
	declineSeerrRequest,
	deleteSeerrRequest,
	retrySeerrRequest,
	fetchSeerrUsers,
	fetchSeerrUserQuota,
	updateSeerrUser,
	fetchSeerrIssues,
	addSeerrIssueComment,
	updateSeerrIssueStatus,
	fetchSeerrNotifications,
	updateSeerrNotification,
	testSeerrNotification,
	fetchSeerrStatus,
	type FetchSeerrRequestsParams,
	type FetchSeerrUsersParams,
	type FetchSeerrIssuesParams,
	type UpdateSeerrUserPayload,
} from "../../lib/api-client/seerr";

// ============================================================================
// Query Keys
// ============================================================================

const seerrKeys = {
	all: ["seerr"] as const,
	requests: (instanceId: string, params?: Omit<FetchSeerrRequestsParams, "instanceId">) =>
		["seerr", "requests", instanceId, params] as const,
	requestCount: (instanceId: string) => ["seerr", "request-count", instanceId] as const,
	users: (instanceId: string, params?: Omit<FetchSeerrUsersParams, "instanceId">) =>
		["seerr", "users", instanceId, params] as const,
	userQuota: (instanceId: string, userId: number) =>
		["seerr", "user-quota", instanceId, userId] as const,
	issues: (instanceId: string, params?: Omit<FetchSeerrIssuesParams, "instanceId">) =>
		["seerr", "issues", instanceId, params] as const,
	notifications: (instanceId: string) => ["seerr", "notifications", instanceId] as const,
	status: (instanceId: string) => ["seerr", "status", instanceId] as const,
};

// ============================================================================
// Request Hooks
// ============================================================================

export const useSeerrRequests = (params: FetchSeerrRequestsParams) =>
	useQuery<SeerrPageResult<SeerrRequest>>({
		queryKey: seerrKeys.requests(params.instanceId, params),
		queryFn: () => fetchSeerrRequests(params),
		refetchInterval: 30_000,
		enabled: !!params.instanceId,
	});

export const useSeerrRequestCount = (instanceId: string) =>
	useQuery<SeerrRequestCount>({
		queryKey: seerrKeys.requestCount(instanceId),
		queryFn: () => fetchSeerrRequestCount(instanceId),
		refetchInterval: 30_000,
		enabled: !!instanceId,
	});

export const useApproveSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => approveSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useDeclineSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => declineSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useDeleteSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => deleteSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useRetrySeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => retrySeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

// ============================================================================
// User Hooks
// ============================================================================

export const useSeerrUsers = (params: FetchSeerrUsersParams) =>
	useQuery<SeerrPageResult<SeerrUser>>({
		queryKey: seerrKeys.users(params.instanceId, params),
		queryFn: () => fetchSeerrUsers(params),
		refetchInterval: 60_000,
		enabled: !!params.instanceId,
	});

export const useSeerrUserQuota = (instanceId: string, userId: number) =>
	useQuery<SeerrQuota>({
		queryKey: seerrKeys.userQuota(instanceId, userId),
		queryFn: () => fetchSeerrUserQuota(instanceId, userId),
		refetchInterval: 60_000,
		enabled: !!instanceId && !!userId,
	});

export const useUpdateSeerrUser = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrUser,
		Error,
		{ instanceId: string; seerrUserId: number; data: UpdateSeerrUserPayload }
	>({
		mutationFn: ({ instanceId, seerrUserId, data }) =>
			updateSeerrUser(instanceId, seerrUserId, data),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "users", instanceId] });
			queryClient.invalidateQueries({ queryKey: ["seerr", "user-quota", instanceId] });
		},
	});
};

// ============================================================================
// Issue Hooks
// ============================================================================

export const useSeerrIssues = (params: FetchSeerrIssuesParams) =>
	useQuery<SeerrPageResult<SeerrIssue>>({
		queryKey: seerrKeys.issues(params.instanceId, params),
		queryFn: () => fetchSeerrIssues(params),
		refetchInterval: 60_000,
		enabled: !!params.instanceId,
	});

export const useAddSeerrIssueComment = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrIssueComment,
		Error,
		{ instanceId: string; issueId: number; message: string }
	>({
		mutationFn: ({ instanceId, issueId, message }) =>
			addSeerrIssueComment(instanceId, issueId, message),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "issues", instanceId] });
		},
	});
};

export const useUpdateSeerrIssueStatus = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrIssue,
		Error,
		{ instanceId: string; issueId: number; status: "open" | "resolved" }
	>({
		mutationFn: ({ instanceId, issueId, status }) =>
			updateSeerrIssueStatus(instanceId, issueId, status),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "issues", instanceId] });
		},
	});
};

// ============================================================================
// Notification Hooks
// ============================================================================

export const useSeerrNotifications = (instanceId: string) =>
	useQuery<{ agents: SeerrNotificationAgent[] }>({
		queryKey: seerrKeys.notifications(instanceId),
		queryFn: () => fetchSeerrNotifications(instanceId),
		refetchInterval: 5 * 60_000,
		enabled: !!instanceId,
	});

export const useUpdateSeerrNotification = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrNotificationAgent,
		Error,
		{ instanceId: string; agentId: string; config: Partial<SeerrNotificationAgent> }
	>({
		mutationFn: ({ instanceId, agentId, config }) =>
			updateSeerrNotification(instanceId, agentId, config),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: seerrKeys.notifications(instanceId) });
		},
	});
};

export const useTestSeerrNotification = () =>
	useMutation<void, Error, { instanceId: string; agentId: string }>({
		mutationFn: ({ instanceId, agentId }) => testSeerrNotification(instanceId, agentId),
	});

// ============================================================================
// Status Hook
// ============================================================================

export const useSeerrStatus = (instanceId: string) =>
	useQuery<SeerrStatus>({
		queryKey: seerrKeys.status(instanceId),
		queryFn: () => fetchSeerrStatus(instanceId),
		refetchInterval: 5 * 60_000,
		enabled: !!instanceId,
	});
