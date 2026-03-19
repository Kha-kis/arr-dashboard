import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateNotificationRule, UpdateNotificationRule } from "@arr/shared";
import {
	type ChannelTypeInfo,
	type CreateChannelRequest,
	notificationsApi,
	type SubscriptionUpdateEntry,
	type UpdateChannelRequest,
} from "../../lib/api-client/notifications";

// ============================================================================
// Query Keys
// ============================================================================

const KEYS = {
	channels: ["notification-channels"] as const,
	channelTypes: ["notification-channel-types"] as const,
	subscriptions: ["notification-subscriptions"] as const,
	logs: (page: number, filters?: Record<string, string>) =>
		["notification-logs", page, filters] as const,
	rules: ["notification-rules"] as const,
	statistics: (days: number) => ["notification-statistics", days] as const,
	aggregation: ["notification-aggregation"] as const,
};

// ============================================================================
// Queries
// ============================================================================

export function useNotificationChannels() {
	return useQuery({
		queryKey: KEYS.channels,
		queryFn: () => notificationsApi.listChannels(),
		staleTime: 30_000,
	});
}

export function useChannelTypes(): ReturnType<typeof useQuery<ChannelTypeInfo[]>> {
	return useQuery({
		queryKey: KEYS.channelTypes,
		queryFn: () => notificationsApi.getChannelTypes(),
		staleTime: 5 * 60 * 1000,
	});
}

export function useNotificationSubscriptions() {
	return useQuery({
		queryKey: KEYS.subscriptions,
		queryFn: () => notificationsApi.getSubscriptions(),
		staleTime: 60_000,
	});
}

export function useNotificationLogs(
	page = 1,
	limit = 20,
	filters?: { status?: string; eventType?: string; since?: string; until?: string },
) {
	return useQuery({
		queryKey: KEYS.logs(page, filters as Record<string, string> | undefined),
		queryFn: () => notificationsApi.getLogs(page, limit, filters),
	});
}

export function useNotificationRules() {
	return useQuery({
		queryKey: KEYS.rules,
		queryFn: () => notificationsApi.listRules(),
		staleTime: 30_000,
	});
}

export function useNotificationStatistics(days = 30) {
	return useQuery({
		queryKey: KEYS.statistics(days),
		queryFn: () => notificationsApi.getStatistics(days),
		staleTime: 60_000,
	});
}

export function useAggregationConfigs() {
	return useQuery({
		queryKey: KEYS.aggregation,
		queryFn: () => notificationsApi.getAggregationConfigs(),
		staleTime: 60_000,
	});
}

// ============================================================================
// Mutations
// ============================================================================

export function useCreateChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateChannelRequest) => notificationsApi.createChannel(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.channels });
		},
	});
}

export function useUpdateChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateChannelRequest }) =>
			notificationsApi.updateChannel(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.channels });
		},
	});
}

export function useDeleteChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => notificationsApi.deleteChannel(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.channels });
		},
	});
}

export function useTestChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => notificationsApi.testChannel(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.channels });
		},
	});
}

export function useUpdateSubscriptions() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (entries: SubscriptionUpdateEntry[]) =>
			notificationsApi.updateSubscriptions(entries),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.subscriptions });
		},
	});
}

export function useCreateRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateNotificationRule) => notificationsApi.createRule(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.rules });
		},
	});
}

export function useUpdateRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateNotificationRule }) =>
			notificationsApi.updateRule(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.rules });
		},
	});
}

export function useDeleteRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => notificationsApi.deleteRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.rules });
		},
	});
}

export function useUpdateAggregationConfigs() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (
			configs: Array<{
				eventType: string;
				windowSeconds?: number;
				maxBatchSize?: number;
				enabled: boolean;
			}>,
		) => notificationsApi.updateAggregationConfigs(configs),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.aggregation });
		},
	});
}
