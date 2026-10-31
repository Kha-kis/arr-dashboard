import type {
	AggregationConfigResponse,
	CreateNotificationRule,
	NotificationChannelResponse,
	NotificationEventType,
	NotificationRuleResponse,
	UpdateNotificationRule,
} from "@arr/shared";
import { notificationChannelTypeSchema } from "@arr/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ChannelTypeInfo,
	type CreateChannelRequest,
	NotificationChannelCreateUnverifiedError,
	NotificationChannelDeleteUnverifiedError,
	NotificationChannelUpdateUnverifiedError,
	NotificationRuleDeleteUnverifiedError,
	NotificationRuleSaveUnverifiedError,
	notificationsApi,
	type SubscriptionUpdateEntry,
	type UpdateChannelRequest,
} from "../../lib/api-client/notifications";
import { notificationKeys } from "../../lib/query-keys";

// ============================================================================
// Queries
// ============================================================================

export function useNotificationChannels() {
	return useQuery({
		queryKey: notificationKeys.channels,
		queryFn: () => notificationsApi.listChannels(),
		staleTime: 30_000,
	});
}

export function useChannelTypes(): ReturnType<typeof useQuery<ChannelTypeInfo[]>> {
	return useQuery({
		queryKey: notificationKeys.channelTypes,
		queryFn: () => notificationsApi.getChannelTypes(),
		staleTime: 5 * 60 * 1000,
	});
}

export function useNotificationSubscriptions() {
	return useQuery({
		queryKey: notificationKeys.subscriptions,
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
		queryKey: notificationKeys.logs(page, filters as Record<string, string> | undefined),
		queryFn: () => notificationsApi.getLogs(page, limit, filters),
	});
}

export function useNotificationRules() {
	return useQuery({
		queryKey: notificationKeys.rules,
		queryFn: () => notificationsApi.listRules(),
		staleTime: 30_000,
	});
}

export function useNotificationStatistics(days = 30) {
	return useQuery({
		queryKey: notificationKeys.statistics(days),
		queryFn: () => notificationsApi.getStatistics(days),
		staleTime: 60_000,
	});
}

export function useAggregationConfigs() {
	return useQuery({
		queryKey: notificationKeys.aggregation,
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
		retry: false,
		mutationFn: (data: CreateChannelRequest) => notificationsApi.createChannel(data),
		onSuccess: async (created) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.channels });
			queryClient.setQueryData<NotificationChannelResponse[]>(
				notificationKeys.channels,
				(previous) => {
					if (!Array.isArray(previous) || previous.some((channel) => channel.id === created.id))
						return previous;
					return [...previous, created];
				},
			);
			// Publish admitted metadata without fabricating a complete list or replacing
			// an already-known ID. Freshness must not hold the acknowledged editor open.
			void queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
		},
		onError: (error) => {
			if (error instanceof NotificationChannelCreateUnverifiedError) {
				// Read only: neither names nor absence establish this POST's outcome.
				void queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
			}
		},
	});
}

export function useUpdateChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateChannelRequest }) =>
			notificationsApi.updateChannel(id, data),
		onSuccess: async (updated, { id }) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.channels });
			queryClient.setQueryData<NotificationChannelResponse[]>(
				notificationKeys.channels,
				(previous) =>
					previous?.map((channel) =>
						channel.id === id && updated.id === id ? { ...channel, ...updated } : channel,
					),
			);
			// Apply acknowledged settings, preserving list-only delivery metadata.
			// An independent reread must not keep a successful editor locked.
			void queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
		},
		onError: (error) => {
			if (error instanceof NotificationChannelUpdateUnverifiedError) {
				// The write may have committed. Read back without publishing its invalid ACK
				// or replaying the write; active consumers label retained metadata last-known.
				void queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
			}
		},
	});
}

function isDeleteReviewTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isDeleteReviewStatus(value: unknown) {
	return value === null || value === "success" || value === "failed";
}

/** Validate the actual shared response DTO only at the new DELETE recovery read.
 * Preserve legacy string subscription tags and optional list delivery metadata;
 * neither grants deletion authority. Ordinary list callers are unchanged. */
async function recheckChannelDeletion(queryClient: QueryClient) {
	await queryClient.cancelQueries({ queryKey: notificationKeys.channels });
	return queryClient.fetchQuery({
		queryKey: notificationKeys.channels,
		staleTime: 0,
		retry: false,
		queryFn: async () => {
			const channels = await notificationsApi.listChannels();
			if (!Array.isArray(channels)) throw new Error("Current channels could not be verified.");
			const ids = new Set<string>();
			for (const channel of channels) {
				if (
					typeof channel !== "object" ||
					channel === null ||
					typeof channel.id !== "string" ||
					!channel.id.trim() ||
					ids.has(channel.id) ||
					typeof channel.name !== "string" ||
					channel.name.length === 0 ||
					!notificationChannelTypeSchema.safeParse(channel.type).success ||
					typeof channel.enabled !== "boolean" ||
					!isDeleteReviewTimestamp(channel.createdAt) ||
					!isDeleteReviewTimestamp(channel.updatedAt) ||
					(channel.lastTestedAt !== null && !isDeleteReviewTimestamp(channel.lastTestedAt)) ||
					!isDeleteReviewStatus(channel.lastTestResult) ||
					!Array.isArray(channel.subscriptions) ||
					!channel.subscriptions.every((tag) => typeof tag === "string" && tag.trim().length > 0) ||
					("lastSentAt" in channel &&
						channel.lastSentAt !== undefined &&
						channel.lastSentAt !== null &&
						!isDeleteReviewTimestamp(channel.lastSentAt)) ||
					("lastSendResult" in channel &&
						channel.lastSendResult !== undefined &&
						!isDeleteReviewStatus(channel.lastSendResult))
				)
					throw new Error("Current channels could not be verified.");
				ids.add(channel.id);
			}
			return channels;
		},
	});
}

export function useDeleteChannel() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		retry: false,
		mutationFn: (id: string) => notificationsApi.deleteChannel(id),
		onSuccess: async (_acknowledged, id) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.channels });
			queryClient.setQueryData<NotificationChannelResponse[]>(
				notificationKeys.channels,
				(previous) =>
					Array.isArray(previous) ? previous.filter((channel) => channel.id !== id) : previous,
			);
			// GET is independent of the admitted deletion and its component lifetime.
			void recheckChannelDeletion(queryClient).catch(() => {});
		},
		onError: (error) => {
			if (error instanceof NotificationChannelDeleteUnverifiedError) {
				// Neither current absence nor a same-name row establishes this DELETE's ACK.
				void recheckChannelDeletion(queryClient).catch(() => {});
			}
		},
	});
	return { ...mutation, recheckChannels: () => recheckChannelDeletion(queryClient) };
}

export function useTestChannel() {
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: (id: string) => notificationsApi.testChannel(id),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
		},
	});
}

export function useUpdateSubscriptions() {
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.subscriptions });
		},
		mutationFn: (entries: SubscriptionUpdateEntry[]) =>
			notificationsApi.updateSubscriptions(entries),
		onSuccess: async (confirmed) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.subscriptions });
			queryClient.setQueryData(notificationKeys.subscriptions, confirmed.grid);
			// Confirmation is complete; background freshness cannot hold save open.
			void queryClient.invalidateQueries({ queryKey: notificationKeys.subscriptions });
		},
	});
}

export function useCreateRule() {
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: (data: CreateNotificationRule) => notificationsApi.createRule(data),
		onSuccess: async (created) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.rules });
			queryClient.setQueryData<NotificationRuleResponse[]>(notificationKeys.rules, (previous) => {
				if (!Array.isArray(previous) || previous.some((rule) => rule.id === created.id))
					return previous;
				return [...previous, created].sort((a, b) => a.priority - b.priority);
			});
			// Publish the server acknowledgement, not the submitted draft. The
			// independent reread must not hold a successful editor open.
			void queryClient.invalidateQueries({ queryKey: notificationKeys.rules });
		},
		onError: (error) => {
			if (error instanceof NotificationRuleSaveUnverifiedError) {
				// Current rows are read metadata, never proof of this POST's outcome.
				void queryClient.invalidateQueries({ queryKey: notificationKeys.rules });
			}
		},
	});
}

export function useUpdateRule() {
	const queryClient = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: ({ id, data }: { id: string; data: UpdateNotificationRule }) =>
			notificationsApi.updateRule(id, data),
		onSuccess: async (updated, { id }) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.rules });
			queryClient.setQueryData<NotificationRuleResponse[]>(notificationKeys.rules, (previous) =>
				previous
					?.map((rule) => (rule.id === id && updated.id === id ? updated : rule))
					.sort((a, b) => a.priority - b.priority),
			);
			void queryClient.invalidateQueries({ queryKey: notificationKeys.rules });
		},
		onError: (error) => {
			if (error instanceof NotificationRuleSaveUnverifiedError) {
				void queryClient.invalidateQueries({ queryKey: notificationKeys.rules });
			}
		},
	});
}

function isRuleDeleteReviewCondition(value: unknown) {
	if (typeof value !== "object" || value === null) return false;
	if (!("field" in value) || typeof value.field !== "string") return false;
	if (
		!("operator" in value) ||
		typeof value.operator !== "string" ||
		!["equals", "not_equals", "contains", "greater_than", "in"].includes(value.operator)
	)
		return false;
	if (!("value" in value)) return false;
	return (
		typeof value.value === "string" ||
		(typeof value.value === "number" && Number.isFinite(value.value)) ||
		(Array.isArray(value.value) && value.value.every((entry) => typeof entry === "string"))
	);
}

function isRuleDeleteReviewNullableString(value: unknown) {
	return value === null || typeof value === "string";
}

/** Admission applies only to DELETE recovery, not ordinary list reads or rule
 * creation policy. Preserve empty/null legacy settings and the server's order. */
async function recheckRuleDeletion(queryClient: QueryClient) {
	await queryClient.cancelQueries({ queryKey: notificationKeys.rules });
	return queryClient.fetchQuery({
		queryKey: notificationKeys.rules,
		staleTime: 0,
		retry: false,
		queryFn: async () => {
			const rules = await notificationsApi.listRules();
			if (!Array.isArray(rules)) throw new Error("Current rules could not be verified.");
			const ids = new Set<string>();
			for (const rule of rules) {
				if (
					typeof rule !== "object" ||
					rule === null ||
					typeof rule.id !== "string" ||
					!rule.id.trim() ||
					ids.has(rule.id) ||
					typeof rule.name !== "string" ||
					typeof rule.enabled !== "boolean" ||
					typeof rule.priority !== "number" ||
					!Number.isFinite(rule.priority) ||
					!["suppress", "throttle", "route", "quiet_hours"].includes(rule.action) ||
					!Array.isArray(rule.conditions) ||
					!rule.conditions.every(isRuleDeleteReviewCondition) ||
					(rule.targetChannelIds !== null &&
						(!Array.isArray(rule.targetChannelIds) ||
							!rule.targetChannelIds.every((id) => typeof id === "string"))) ||
					(rule.throttleMinutes !== null &&
						(typeof rule.throttleMinutes !== "number" || !Number.isFinite(rule.throttleMinutes))) ||
					!isRuleDeleteReviewNullableString(rule.quietHoursStart) ||
					!isRuleDeleteReviewNullableString(rule.quietHoursEnd) ||
					!isRuleDeleteReviewNullableString(rule.quietHoursTimezone) ||
					typeof rule.createdAt !== "string" ||
					typeof rule.updatedAt !== "string"
				)
					throw new Error("Current rules could not be verified.");
				ids.add(rule.id);
			}
			return rules;
		},
	});
}

export function useDeleteRule() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		retry: false,
		mutationFn: (id: string) => notificationsApi.deleteRule(id),
		onSuccess: async (_result, id) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.rules });
			queryClient.setQueryData<NotificationRuleResponse[]>(notificationKeys.rules, (previous) =>
				Array.isArray(previous) ? previous.filter((rule) => rule.id !== id) : previous,
			);
			// Removal is acknowledged only after DELETE succeeds. Recovering
			// from a failed list read never dispatches DELETE again.
			void recheckRuleDeletion(queryClient).catch(() => {});
		},
		onError: (error) => {
			if (error instanceof NotificationRuleDeleteUnverifiedError) {
				void recheckRuleDeletion(queryClient).catch(() => {});
			}
		},
	});
	return { ...mutation, recheckRules: () => recheckRuleDeletion(queryClient) };
}

async function recheckAggregationConfigs(queryClient: QueryClient) {
	await queryClient.cancelQueries({ queryKey: notificationKeys.aggregation });
	return queryClient.fetchQuery({
		queryKey: notificationKeys.aggregation,
		staleTime: 0,
		retry: false,
		queryFn: () => notificationsApi.getAggregationConfigsForReview(),
	});
}

export function useUpdateAggregationConfigs() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		retry: false,
		mutationFn: (
			configs: Array<{
				eventType: NotificationEventType;
				windowSeconds?: number;
				maxBatchSize?: number;
				enabled: boolean;
			}>,
		) => notificationsApi.updateAggregationConfigs(configs),
		onSuccess: async (_result, configs) => {
			await queryClient.cancelQueries({ queryKey: notificationKeys.aggregation });
			// The PUT acknowledged these row updates. Preserve that fact even if
			// the following read fails; do not revert to pre-save cached settings.
			queryClient.setQueryData<AggregationConfigResponse[]>(
				notificationKeys.aggregation,
				(previous) => {
					if (!Array.isArray(previous)) return previous;
					const rows = new Map(previous.map((row) => [row.eventType, row]));
					for (const config of configs) {
						rows.set(config.eventType, {
							eventType: config.eventType,
							windowSeconds: config.windowSeconds ?? 300,
							maxBatchSize: config.maxBatchSize ?? 10,
							enabled: config.enabled,
						});
					}
					return [...rows.values()];
				},
			);
			// Revalidation is independent of the acknowledged write. A slow read
			// must not keep the editor locked after a successful save.
			void queryClient.invalidateQueries({ queryKey: notificationKeys.aggregation });
		},
	});
	return { ...mutation, recheckAggregation: () => recheckAggregationConfigs(queryClient) };
}
