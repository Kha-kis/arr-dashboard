import { apiRequest } from "./base";

// ============================================================================
// Types
// ============================================================================

export interface NotificationChannel {
	id: string;
	name: string;
	type: string;
	enabled: boolean;
	lastTestedAt: string | null;
	lastTestResult: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface NotificationChannelWithConfig extends NotificationChannel {
	config: Record<string, unknown>;
}

export interface CreateChannelRequest {
	name: string;
	type: string;
	enabled?: boolean;
	config: Record<string, unknown>;
}

export interface UpdateChannelRequest {
	name?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
}

/** Matches the backend GET /subscriptions response shape */
export interface SubscriptionGridResponse {
	channels: Array<{ id: string; name: string; type: string }>;
	events: string[];
	subscriptions: Array<{ channelId: string; eventType: string }>;
}

/** Entry format for PUT /subscriptions */
export interface SubscriptionUpdateEntry {
	channelId: string;
	eventType: string;
	enabled: boolean;
}

export interface NotificationLogEntry {
	id: string;
	channelId: string;
	channelType: string;
	eventType: string;
	title: string;
	body: string;
	status: string;
	error: string | null;
	sentAt: string;
}

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
