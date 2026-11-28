import type {
	AggregationConfigResponse,
	BrowserPushDisableRequest,
	BrowserPushEnableRequest,
	BrowserPushReconnectRequest,
	BrowserPushState,
	BrowserPushStateRequest,
	CreateNotificationRule,
	NotificationChannelConfigRead,
	NotificationChannelEditState,
	NotificationChannelResponse,
	NotificationChannelType,
	NotificationEventType,
	NotificationRuleResponse,
	NotificationStatisticsResponse,
	NotificationTestResult,
	NotificationLogEntry as SharedNotificationLogEntry,
	SubscriptionGrid,
	SubscriptionUpdateResponse,
	UpdateNotificationRule,
} from "@arr/shared";
import {
	browserPushStateSchema,
	notificationChannelConfigReadSchema,
	notificationChannelEditStateSchema,
	notificationEventTypeSchema,
	notificationFailureCategorySchema,
} from "@arr/shared";
import { ApiError, apiRequest } from "./base";
import {
	projectNotificationChannels,
	projectNotificationRules,
} from "./notification-list-projection";
import {
	projectNotificationLogs,
	projectNotificationStatistics,
} from "./notification-observation-projection";
import { projectNotificationRuleAcknowledgment } from "./notification-rule-acknowledgment";

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
		type: "text" | "url" | "email" | "password" | "number" | "boolean" | "headers";
		placeholder?: string;
		required?: boolean;
	}>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isChannelFormField(value: unknown): value is ChannelTypeInfo["formFields"][number] {
	return (
		isRecord(value) &&
		isNonblankString(value.key) &&
		isNonblankString(value.label) &&
		typeof value.type === "string" &&
		["text", "url", "email", "password", "number", "boolean", "headers"].includes(value.type) &&
		(value.placeholder === undefined || typeof value.placeholder === "string") &&
		(value.required === undefined || typeof value.required === "boolean")
	);
}

function isChannelTypeCatalog(value: unknown): value is ChannelTypeInfo[] {
	if (!Array.isArray(value)) return false;
	const types = new Set<string>();
	for (const descriptor of value) {
		if (
			!isRecord(descriptor) ||
			!isNonblankString(descriptor.type) ||
			!isNonblankString(descriptor.label) ||
			!isNonblankString(descriptor.icon) ||
			types.has(descriptor.type) ||
			!Array.isArray(descriptor.formFields)
		) {
			return false;
		}
		types.add(descriptor.type);
		const keys = new Set<string>();
		for (const field of descriptor.formFields) {
			if (!isChannelFormField(field) || keys.has(field.key)) return false;
			keys.add(field.key);
		}
	}
	return true;
}

/** Re-export shared channel response as the primary channel type */
export type NotificationChannel = NotificationChannelResponse;

/** A dispatched DELETE may have completed without the route's exact acknowledgment. */
export class NotificationChannelDeleteUnverifiedError extends Error {
	constructor() {
		super("Channel deletion outcome could not be verified.");
		this.name = "NotificationChannelDeleteUnverifiedError";
	}
}

/** A dispatched rule DELETE has no verified acknowledgment of its outcome. */
export class NotificationRuleDeleteUnverifiedError extends Error {
	constructor() {
		super("Rule deletion outcome could not be verified.");
		this.name = "NotificationRuleDeleteUnverifiedError";
	}
}

/** A dispatched CREATE may have committed without an admitted acknowledgment. */
export class NotificationChannelCreateUnverifiedError extends Error {
	constructor() {
		super("Channel creation outcome could not be verified.");
		this.name = "NotificationChannelCreateUnverifiedError";
	}
}

/** A timeout or malformed acknowledgment does not establish mutation completion. */
async function pushLifecycleRequest(
	action: "state" | "enable" | "disable" | "reconnect",
	data:
		| BrowserPushStateRequest
		| BrowserPushDisableRequest
		| BrowserPushEnableRequest
		| BrowserPushReconnectRequest,
): Promise<BrowserPushState> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = await Promise.race([
			apiRequest<unknown>(`/api/notifications/push-subscription/${action}`, {
				method: "POST",
				json: data,
				signal: controller.signal,
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("unverified"));
				}, 10_000);
			}),
		]);
		const parsed = browserPushStateSchema.safeParse(response);
		if (
			!parsed.success ||
			(data.channelId !== undefined && parsed.data.channelId !== data.channelId) ||
			(action === "enable" && parsed.data.state !== "enabled") ||
			(action === "disable" && parsed.data.state !== "disabled") ||
			(action === "reconnect" &&
				(parsed.data.state === "unregistered" ||
					!isRecord(response) ||
					Object.keys(response).some(
						(key) =>
							!["channelId", "configRevision", "state", "subscribedEventCount"].includes(key),
					)))
		)
			throw new Error("unverified");
		return parsed.data;
	} catch {
		throw new Error(
			"Browser push device state could not be verified. Recheck before trying again.",
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** A dispatched update has no verified acknowledgment of committed settings. */
export class NotificationChannelUpdateUnverifiedError extends Error {
	constructor() {
		super("Channel save outcome could not be verified.");
		this.name = "NotificationChannelUpdateUnverifiedError";
	}
}

/** A dispatched rule write has no admitted acknowledgment of its completion. */
export class NotificationRuleSaveUnverifiedError extends Error {
	constructor() {
		super(
			"Rule save outcome could not be verified. The rule may have been saved. Review the current rule list before a new save.",
		);
		this.name = "NotificationRuleSaveUnverifiedError";
	}
}

/** A dispatched aggregation PUT has no admitted acknowledgement of its outcome. */
export class NotificationAggregationSaveUnverifiedError extends Error {
	constructor() {
		super(
			"Aggregation save outcome could not be verified. Changes may have been saved. Review current aggregation settings before a new save.",
		);
		this.name = "NotificationAggregationSaveUnverifiedError";
	}
}

/** Admit a complete public settings list for ordinary and explicit review reads. */
function projectAggregationConfigs(value: unknown): AggregationConfigResponse[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const events = new Set<NotificationEventType>();
	const rows: AggregationConfigResponse[] = [];
	for (const row of value) {
		if (!isRecord(row)) return undefined;
		const event = notificationEventTypeSchema.safeParse(row.eventType);
		if (
			!event.success ||
			events.has(event.data) ||
			typeof row.windowSeconds !== "number" ||
			!Number.isInteger(row.windowSeconds) ||
			typeof row.maxBatchSize !== "number" ||
			!Number.isInteger(row.maxBatchSize) ||
			typeof row.enabled !== "boolean"
		)
			return undefined;
		// Legacy integer metadata is read-only evidence, not creation-range policy.
		events.add(event.data);
		rows.push({
			eventType: event.data,
			windowSeconds: row.windowSeconds,
			maxBatchSize: row.maxBatchSize,
			enabled: row.enabled,
		});
	}
	return rows;
}

/** A dispatched Test may have completed without an admitted acknowledgment. */
export class NotificationTestUnverifiedError extends Error {
	constructor() {
		super("Notification Test outcome could not be verified.");
		this.name = "NotificationTestUnverifiedError";
	}
}

function isChannelTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isChannelUpdateAcknowledgment(
	value: unknown,
	id: string,
): value is NotificationChannelResponse {
	return (
		isRecord(value) &&
		value.id === id &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		isNonblankString(value.type) &&
		typeof value.enabled === "boolean" &&
		(value.lastTestedAt === null || isChannelTimestamp(value.lastTestedAt)) &&
		(value.lastTestResult === null ||
			value.lastTestResult === "success" ||
			value.lastTestResult === "failed") &&
		isChannelTimestamp(value.createdAt) &&
		isChannelTimestamp(value.updatedAt) &&
		Array.isArray(value.subscriptions) &&
		// Preserve legacy string tags; they do not confer mutation or delivery authority.
		value.subscriptions.every(isNonblankString)
	);
}

export type NotificationChannelWithConfig = NotificationChannelConfigRead;

export interface CreateChannelRequest {
	name: string;
	type: NotificationChannelType;
	enabled?: boolean;
	config: Record<string, unknown>;
}

function projectChannelCreateAcknowledgment(
	value: unknown,
	request: CreateChannelRequest,
): NotificationChannelResponse | undefined {
	if (
		!isRecord(value) ||
		!isNonblankString(value.id) ||
		!isChannelUpdateAcknowledgment(value, value.id) ||
		value.name !== request.name ||
		value.type !== request.type ||
		value.enabled !== (request.enabled ?? true) ||
		value.lastTestedAt !== null ||
		value.lastTestResult !== null ||
		value.subscriptions.length !== 0
	)
		return undefined;
	// Fresh CREATE returns metadata only, never provider/config/diagnostic extras.
	return {
		id: value.id,
		name: value.name,
		type: value.type,
		enabled: value.enabled,
		lastTestedAt: null,
		lastTestResult: null,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		subscriptions: [],
	};
}

export interface UpdateChannelRequest {
	name?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
	expectedRevision?: string;
}

/** Re-export shared subscription grid */
export type SubscriptionGridResponse = SubscriptionGrid;

/** Legacy readback confirms current rows but cannot establish omissions. */
export type SubscriptionSaveConfirmation = Omit<SubscriptionUpdateResponse, "omittedCount"> & {
	omittedCount: number | null;
};

export class SubscriptionSaveUnverifiedError extends Error {
	constructor() {
		super(
			"Subscription save outcome could not be verified. Reload saved subscriptions and review before saving again.",
		);
		this.name = "SubscriptionSaveUnverifiedError";
	}
}

/** Admit public grid fields only; legacy nonblank tags remain read metadata. */
function projectSubscriptionGrid(value: unknown): SubscriptionGridResponse | undefined {
	if (
		!isRecord(value) ||
		!Array.isArray(value.channels) ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.subscriptions)
	)
		return undefined;
	const channelIds = new Set<string>();
	const channels: SubscriptionGridResponse["channels"] = [];
	for (const channel of value.channels) {
		if (
			!isRecord(channel) ||
			!isNonblankString(channel.id) ||
			typeof channel.name !== "string" ||
			channel.name.length === 0 ||
			!isNonblankString(channel.type) ||
			channelIds.has(channel.id)
		)
			return undefined;
		channelIds.add(channel.id);
		channels.push({
			id: channel.id,
			name: channel.name,
			type: channel.type as NotificationChannelType,
		});
	}
	const eventTypes = new Set<string>();
	for (const event of value.events) {
		if (!isNonblankString(event) || eventTypes.has(event)) return undefined;
		eventTypes.add(event);
	}
	const pairs = new Set<string>();
	const subscriptions: SubscriptionGridResponse["subscriptions"] = [];
	for (const subscription of value.subscriptions) {
		if (
			!isRecord(subscription) ||
			!isNonblankString(subscription.channelId) ||
			!isNonblankString(subscription.eventType) ||
			!channelIds.has(subscription.channelId)
		)
			return undefined;
		const pair = JSON.stringify([subscription.channelId, subscription.eventType]);
		if (pairs.has(pair)) return undefined;
		pairs.add(pair);
		subscriptions.push({
			channelId: subscription.channelId,
			eventType: subscription.eventType as NotificationEventType,
		});
	}
	return { channels, events: [...eventTypes] as NotificationEventType[], subscriptions };
}

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
export type {
	AggregationConfigResponse,
	CreateNotificationRule,
	NotificationRuleResponse,
	NotificationStatisticsResponse,
	UpdateNotificationRule,
};

// ============================================================================
// API Client
// ============================================================================

export const notificationsApi = {
	// Channels
	async listChannels(): Promise<NotificationChannel[]> {
		const channels = projectNotificationChannels(
			await apiRequest<unknown>("/api/notifications/channels"),
		);
		if (channels === undefined) throw new Error("Notification channels could not be loaded.");
		return channels;
	},

	async createChannel(data: CreateChannelRequest): Promise<NotificationChannel> {
		let result: unknown;
		try {
			result = await apiRequest<unknown>("/api/notifications/channels", {
				method: "POST",
				json: data,
			});
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationChannelCreateUnverifiedError();
		}
		const acknowledged = projectChannelCreateAcknowledgment(result, data);
		if (!acknowledged) throw new NotificationChannelCreateUnverifiedError();
		return acknowledged;
	},

	async updateChannel(id: string, data: UpdateChannelRequest): Promise<NotificationChannel> {
		let result: unknown;
		try {
			result = await apiRequest<unknown>(`/api/notifications/channels/${id}`, {
				method: "PUT",
				json: data,
			});
		} catch (error) {
			// A dispatched write may have committed despite a lost response or server failure.
			// Preserve known client rejections; all uncertain outcomes need domain readback.
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationChannelUpdateUnverifiedError();
		}
		if (!isChannelUpdateAcknowledgment(result, id)) {
			throw new NotificationChannelUpdateUnverifiedError();
		}
		// Publish only the update route's metadata, never unexpected config/provider fields.
		return {
			id: result.id,
			name: result.name,
			type: result.type,
			enabled: result.enabled,
			lastTestedAt: result.lastTestedAt,
			lastTestResult: result.lastTestResult,
			createdAt: result.createdAt,
			updatedAt: result.updatedAt,
			subscriptions: result.subscriptions,
		};
	},

	async deleteChannel(id: string): Promise<void> {
		try {
			await apiRequest(`/api/notifications/channels/${id}`, {
				method: "DELETE",
				expectedSuccessStatus: 204,
			});
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationChannelDeleteUnverifiedError();
		}
	},

	async testChannel(id: string): Promise<NotificationTestResult> {
		let result: unknown;
		try {
			result = await apiRequest<unknown>(`/api/notifications/channels/${id}/test`, {
				method: "POST",
			});
		} catch (error) {
			// A missing response cannot establish whether this Test already completed.
			// Keep known client rejections and their authentication/category semantics.
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationTestUnverifiedError();
		}
		if (
			typeof result !== "object" ||
			result === null ||
			!("success" in result) ||
			typeof result.success !== "boolean"
		) {
			throw new NotificationTestUnverifiedError();
		}
		// Missing or malformed legacy status metadata cannot certify a saved badge.
		const statusRecorded = "statusRecorded" in result && result.statusRecorded === true;
		if (result.success) return { success: true, statusRecorded };
		const category = notificationFailureCategorySchema.safeParse(
			"failureCategory" in result ? result.failureCategory : undefined,
		);
		return {
			success: false,
			statusRecorded,
			failureCategory: category.success ? category.data : "unknown",
		};
	},

	async getChannelConfig(id: string): Promise<NotificationChannelWithConfig> {
		const response = await apiRequest<unknown>(`/api/notifications/channels/${id}/config`);
		const parsed = notificationChannelConfigReadSchema.safeParse(response);
		if (!parsed.success || parsed.data.id !== id)
			throw new Error("Channel settings could not be verified.");
		return parsed.data;
	},

	async getChannelEditState(
		id: string,
		signal?: AbortSignal,
	): Promise<NotificationChannelEditState> {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (signal?.aborted) throw new Error("unverified");
			const result = await Promise.race([
				apiRequest<unknown>(`/api/notifications/channels/${id}/edit-state`, {
					signal: controller.signal,
				}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("unverified"));
					}, 10_000);
				}),
			]);
			const parsed = notificationChannelEditStateSchema.safeParse(result);
			if (controller.signal.aborted || !parsed.success || parsed.data.id !== id)
				throw new Error("unverified");
			return parsed.data;
		} catch {
			throw new Error("Channel repair options could not be verified.");
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
	},

	// Subscriptions
	async getSubscriptions(): Promise<SubscriptionGridResponse> {
		const value = await apiRequest<unknown>("/api/notifications/subscriptions");
		const grid = projectSubscriptionGrid(value);
		if (!grid) throw new Error("Saved subscriptions could not be read. Please try again.");
		return grid;
	},

	async updateSubscriptions(
		entries: SubscriptionUpdateEntry[],
	): Promise<SubscriptionSaveConfirmation> {
		let value: unknown;
		try {
			value = await apiRequest<unknown>("/api/notifications/subscriptions", {
				method: "PUT",
				json: { subscriptions: entries },
			});
		} catch (error) {
			// Deterministic client rejections retain ordinary draft semantics.
			// Timeout/proxy/server failures do not establish whether PUT committed.
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new SubscriptionSaveUnverifiedError();
		}
		if (!isRecord(value) || value.success !== true) throw new SubscriptionSaveUnverifiedError();
		if (!Object.hasOwn(value, "grid") && !Object.hasOwn(value, "omittedCount")) {
			try {
				return { success: true, grid: await this.getSubscriptions(), omittedCount: null };
			} catch {
				throw new SubscriptionSaveUnverifiedError();
			}
		}
		const grid = projectSubscriptionGrid(value.grid);
		if (
			!grid ||
			typeof value.omittedCount !== "number" ||
			!Number.isSafeInteger(value.omittedCount) ||
			value.omittedCount < 0 ||
			value.omittedCount > entries.length
		)
			throw new SubscriptionSaveUnverifiedError();
		return { success: true, grid, omittedCount: value.omittedCount };
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
		try {
			const result = projectNotificationLogs(
				await apiRequest<unknown>(`/api/notifications/logs?${params}`),
				page,
				limit,
			);
			if (!result) throw new Error("unverified");
			return result;
		} catch {
			throw new Error("Notification logs could not be loaded.");
		}
	},

	// VAPID
	readPushState(data: BrowserPushStateRequest): Promise<BrowserPushState> {
		return pushLifecycleRequest("state", data);
	},
	disablePushSubscription(data: BrowserPushDisableRequest): Promise<BrowserPushState> {
		return pushLifecycleRequest("disable", data);
	},
	enablePushSubscription(data: BrowserPushEnableRequest): Promise<BrowserPushState> {
		return pushLifecycleRequest("enable", data);
	},
	reconnectPushSubscription(data: BrowserPushReconnectRequest): Promise<BrowserPushState> {
		return pushLifecycleRequest("reconnect", data);
	},
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
		const catalog = await apiRequest<unknown>("/api/notifications/channel-types");
		// Reject an invalid catalog as a whole: dropping fields or duplicate types
		// would falsely present incomplete configuration definitions as usable.
		if (!isChannelTypeCatalog(catalog)) {
			throw new Error("Channel field definitions could not be loaded.");
		}
		return catalog;
	},

	// Rules
	async listRules(): Promise<NotificationRuleResponse[]> {
		const rules = projectNotificationRules(await apiRequest<unknown>("/api/notifications/rules"));
		if (rules === undefined) throw new Error("Notification rules could not be loaded.");
		return rules;
	},

	async createRule(data: CreateNotificationRule): Promise<NotificationRuleResponse> {
		try {
			const response = await apiRequest<unknown>("/api/notifications/rules", {
				method: "POST",
				json: data,
				expectedSuccessStatus: 201,
			});
			const rule = projectNotificationRuleAcknowledgment(response);
			if (!rule) throw new NotificationRuleSaveUnverifiedError();
			return rule;
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			// Never retain a raw response or transport detail in uncertainty state.
			throw new NotificationRuleSaveUnverifiedError();
		}
	},

	async updateRule(id: string, data: UpdateNotificationRule): Promise<NotificationRuleResponse> {
		try {
			const response = await apiRequest<unknown>(`/api/notifications/rules/${id}`, {
				method: "PUT",
				json: data,
				expectedSuccessStatus: 200,
			});
			const rule = projectNotificationRuleAcknowledgment(response, id);
			if (!rule) throw new NotificationRuleSaveUnverifiedError();
			return rule;
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationRuleSaveUnverifiedError();
		}
	},

	async deleteRule(id: string): Promise<void> {
		try {
			await apiRequest(`/api/notifications/rules/${id}`, {
				method: "DELETE",
				expectedSuccessStatus: 204,
			});
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationRuleDeleteUnverifiedError();
		}
	},

	// Statistics
	async getStatistics(days = 30): Promise<NotificationStatisticsResponse> {
		try {
			const result = projectNotificationStatistics(
				await apiRequest<unknown>(`/api/notifications/statistics?days=${days}`),
				days,
			);
			if (!result) throw new Error("unverified");
			return result;
		} catch {
			throw new Error("Notification statistics could not be loaded.");
		}
	},

	// Aggregation
	async getAggregationConfigs(): Promise<AggregationConfigResponse[]> {
		try {
			const rows = projectAggregationConfigs(
				await apiRequest<unknown>("/api/notifications/aggregation"),
			);
			if (!rows) throw new Error("unverified");
			return rows;
		} catch {
			throw new Error("Event aggregation settings could not be loaded.");
		}
	},

	async getAggregationConfigsForReview(): Promise<AggregationConfigResponse[]> {
		try {
			const rows = projectAggregationConfigs(
				await apiRequest<unknown>("/api/notifications/aggregation"),
			);
			if (!rows) throw new Error("unverified");
			return rows;
		} catch {
			// A review error must not retain a raw list, transport detail or payload.
			throw new Error("Current aggregation settings could not be reviewed.");
		}
	},

	async updateAggregationConfigs(
		configs: Array<{
			eventType: string;
			windowSeconds?: number;
			maxBatchSize?: number;
			enabled: boolean;
		}>,
	): Promise<{ success: boolean }> {
		try {
			const response = await apiRequest<unknown>("/api/notifications/aggregation", {
				method: "PUT",
				json: { configs },
				expectedSuccessStatus: 200,
			});
			if (!isRecord(response) || response.success !== true)
				throw new NotificationAggregationSaveUnverifiedError();
			return { success: true };
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			)
				throw error;
			throw new NotificationAggregationSaveUnverifiedError();
		}
	},
};
