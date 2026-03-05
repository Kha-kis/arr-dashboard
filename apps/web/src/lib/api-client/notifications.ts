import type {
	AggregationConfigResponse,
	CreateNotificationRule,
	NotificationChannelResponse,
	NotificationChannelType,
	NotificationEventType,
	NotificationLogEntry as SharedNotificationLogEntry,
	NotificationRuleResponse,
	NotificationStatisticsResponse,
	SubscriptionGrid,
	UpdateNotificationRule,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Types (extending shared types where needed)
// ============================================================================

export interface ChannelTypeInfo {
	type: string;
	label: string;
	icon: string;
	formFields: Array<{
		key: string;
		label: string;
		type: "text" | "url" | "email" | "password" | "number" | "boolean";
		placeholder?: string;
		required?: boolean;
	}>;
}

/** Re-export shared channel response as the primary channel type */
export type NotificationChannel = NotificationChannelResponse;

export interface NotificationChannelWithConfig extends NotificationChannel {
	config: Record<string, unknown>;
}

export interface CreateChannelRequest {
	name: string;
	type: NotificationChannelType;
	enabled?: boolean;
	config: Record<string, unknown>;
}

export interface UpdateChannelRequest {
	name?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
}

/** Re-export shared subscription grid */
export type SubscriptionGridResponse = SubscriptionGrid;

/** Entry format for PUT /subscriptions */
export interface SubscriptionUpdateEntry {
	channelId: string;
	eventType: NotificationEventType;
	enabled: boolean;
}

/** Re-export shared log entry */
export type NotificationLogEntry = SharedNotificationLogEntry;

/** Matches the backend GET /logs response shape */
export interface PaginatedLogs {
	logs: NotificationLogEntry[];
	total: number;
	page: number;
	limit: number;
}

// Re-export shared types for convenience
export type { NotificationRuleResponse, CreateNotificationRule, UpdateNotificationRule, NotificationStatisticsResponse, AggregationConfigResponse };

// ============================================================================
// API Client
// ============================================================================

export const notificationsApi = {
	// Channels
	async listChannels(): Promise<NotificationChannel[]> {
		return apiRequest<NotificationChannel[]>("/api/notifications/channels");
	},

	async createChannel(data: CreateChannelRequest): Promise<NotificationChannel> {
		return apiRequest<NotificationChannel>("/api/notifications/channels", {
			method: "POST",
			json: data,
		});
	},

	async updateChannel(id: string, data: UpdateChannelRequest): Promise<NotificationChannel> {
		return apiRequest<NotificationChannel>(`/api/notifications/channels/${id}`, {
			method: "PUT",
			json: data,
		});
	},

	async deleteChannel(id: string): Promise<void> {
		await apiRequest(`/api/notifications/channels/${id}`, { method: "DELETE" });
	},

	async testChannel(id: string): Promise<{ success: boolean; error?: string }> {
		return apiRequest(`/api/notifications/channels/${id}/test`, { method: "POST" });
	},

	async getChannelConfig(id: string): Promise<NotificationChannelWithConfig> {
		return apiRequest<NotificationChannelWithConfig>(`/api/notifications/channels/${id}/config`);
	},

	// Subscriptions
	async getSubscriptions(): Promise<SubscriptionGridResponse> {
		return apiRequest<SubscriptionGridResponse>("/api/notifications/subscriptions");
	},

	async updateSubscriptions(entries: SubscriptionUpdateEntry[]): Promise<{ success: boolean }> {
		return apiRequest<{ success: boolean }>("/api/notifications/subscriptions", {
			method: "PUT",
			json: { subscriptions: entries },
		});
	},

	// Logs
	async getLogs(
		page = 1,
		limit = 20,
		filters?: { status?: string; eventType?: string; since?: string; until?: string },
	): Promise<PaginatedLogs> {
		const params = new URLSearchParams({ page: String(page), limit: String(limit) });
		if (filters?.status) params.set("status", filters.status);
		if (filters?.eventType) params.set("eventType", filters.eventType);
		if (filters?.since) params.set("since", filters.since);
		if (filters?.until) params.set("until", filters.until);
		return apiRequest<PaginatedLogs>(`/api/notifications/logs?${params}`);
	},

	// VAPID
	async getVapidPublicKey(): Promise<{ publicKey: string }> {
		return apiRequest<{ publicKey: string }>("/api/notifications/vapid-public-key");
	},

	async registerPushSubscription(data: {
		endpoint: string;
		keys: { p256dh: string; auth: string };
	}): Promise<{ id: string; updated: boolean }> {
		return apiRequest<{ id: string; updated: boolean }>("/api/notifications/push-subscription", {
			method: "POST",
			json: data,
		});
	},

	// Channel Types
	async getChannelTypes(): Promise<ChannelTypeInfo[]> {
		return apiRequest<ChannelTypeInfo[]>("/api/notifications/channel-types");
	},

	// Rules
	async listRules(): Promise<NotificationRuleResponse[]> {
		return apiRequest<NotificationRuleResponse[]>("/api/notifications/rules");
	},

	async createRule(data: CreateNotificationRule): Promise<NotificationRuleResponse> {
		return apiRequest<NotificationRuleResponse>("/api/notifications/rules", {
			method: "POST",
			json: data,
		});
	},

	async updateRule(id: string, data: UpdateNotificationRule): Promise<NotificationRuleResponse> {
		return apiRequest<NotificationRuleResponse>(`/api/notifications/rules/${id}`, {
			method: "PUT",
			json: data,
		});
	},

	async deleteRule(id: string): Promise<void> {
		await apiRequest(`/api/notifications/rules/${id}`, { method: "DELETE" });
	},

	// Statistics
	async getStatistics(days = 30): Promise<NotificationStatisticsResponse> {
		return apiRequest<NotificationStatisticsResponse>(`/api/notifications/statistics?days=${days}`);
	},

	// Aggregation
	async getAggregationConfigs(): Promise<AggregationConfigResponse[]> {
		return apiRequest<AggregationConfigResponse[]>("/api/notifications/aggregation");
	},

	async updateAggregationConfigs(
		configs: Array<{
			eventType: string;
			windowSeconds?: number;
			maxBatchSize?: number;
			enabled: boolean;
		}>,
	): Promise<{ success: boolean }> {
		return apiRequest<{ success: boolean }>("/api/notifications/aggregation", {
			method: "PUT",
			json: { configs },
		});
	},
};
