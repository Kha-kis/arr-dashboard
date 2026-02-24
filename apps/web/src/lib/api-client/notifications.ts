import type {
	NotificationChannelResponse,
	NotificationChannelType,
	NotificationEventType,
	NotificationLogEntry as SharedNotificationLogEntry,
	SubscriptionGrid,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Types (extending shared types where needed)
// ============================================================================

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
	async getLogs(page = 1, limit = 20): Promise<PaginatedLogs> {
		return apiRequest<PaginatedLogs>(`/api/notifications/logs?page=${page}&limit=${limit}`);
	},

	// VAPID
	async getVapidPublicKey(): Promise<{ publicKey: string }> {
		return apiRequest<{ publicKey: string }>("/api/notifications/vapid-public-key");
	},
};
