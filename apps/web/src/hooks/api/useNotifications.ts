import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
	subscriptions: ["notification-subscriptions"] as const,
	logs: (page: number) => ["notification-logs", page] as const,
	vapid: ["notification-vapid"] as const,
};

// ============================================================================
// Queries
// ============================================================================

export function useNotificationChannels() {
	return useQuery({
		queryKey: KEYS.channels,
		queryFn: () => notificationsApi.listChannels(),
	});
}

export function useNotificationSubscriptions() {
	return useQuery({
		queryKey: KEYS.subscriptions,
		queryFn: () => notificationsApi.getSubscriptions(),
	});
}

export function useNotificationLogs(page = 1, limit = 20) {
	return useQuery({
		queryKey: KEYS.logs(page),
		queryFn: () => notificationsApi.getLogs(page, limit),
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
