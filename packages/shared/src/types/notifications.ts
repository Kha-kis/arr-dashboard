import { z } from "zod";

// ============================================================================
// Validation Helpers
// ============================================================================

/** Block URLs targeting private/internal networks (SSRF prevention) */
function isPrivateUrl(rawUrl: string): boolean {
	try {
		const u = new URL(rawUrl);
		const host = u.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host.startsWith("127.") ||
			host.startsWith("10.") ||
			host.startsWith("192.168.") ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
			host === "0.0.0.0" ||
			host === "::1" ||
			host === "[::1]" ||
			host === "169.254.169.254" ||
			host.endsWith(".local") ||
			host.endsWith(".internal")
		);
	} catch {
		return true;
	}
}

const publicUrlSchema = z
	.string()
	.url()
	.refine((url) => !isPrivateUrl(url), {
		message: "URL must not target private or internal networks",
	});

// ============================================================================
// Channel Types
// ============================================================================

export const notificationChannelTypeSchema = z.enum([
	"DISCORD",
	"TELEGRAM",
	"EMAIL",
	"BROWSER_PUSH",
	"PUSHBULLET",
	"PUSHOVER",
	"GOTIFY",
	"WEBHOOK",
	"SLACK",
	"NTFY",
]);

export type NotificationChannelType = z.infer<typeof notificationChannelTypeSchema>;

// ============================================================================
// Event Types
// ============================================================================

export const notificationEventTypeSchema = z.enum([
	// Hunting
	"HUNT_CONTENT_FOUND",
	"HUNT_COMPLETED",
	"HUNT_FAILED",
	// Queue Cleaner
	"QUEUE_ITEMS_REMOVED",
	"QUEUE_STRIKES_ISSUED",
	"QUEUE_CLEANER_FAILED",
	// TRaSH Guides
	"TRASH_PROFILE_UPDATED",
	"TRASH_SYNC_ERROR",
	"TRASH_DEPLOY_FAILED",
	// Backup
	"BACKUP_COMPLETED",
	"BACKUP_FAILED",
	// Library
	"LIBRARY_NEW_CONTENT",
	"CLEANUP_ITEMS_FLAGGED",
	"CLEANUP_ITEMS_REMOVED",
	// Security
	"ACCOUNT_LOCKED",
	"LOGIN_FAILED",
	// Services
	"SERVICE_CONNECTION_FAILED",
	// Cache
	"CACHE_REFRESH_STALE",
	// Plex Analytics
	"PLEX_CONCURRENT_PEAK",
	"PLEX_TRANSCODE_HEAVY",
	"PLEX_NEW_DEVICE",
	// System
	"SYSTEM_STARTUP",
	"SYSTEM_ERROR",
	"VALIDATION_HEALTH_DEGRADED",
]);

export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

// ============================================================================
// Channel Config Schemas (per-type configuration)
// ============================================================================

export const discordConfigSchema = z.object({
	webhookUrl: publicUrlSchema,
});

export const telegramConfigSchema = z.object({
	botToken: z.string().min(1),
	chatId: z.string().min(1),
});

export const emailConfigSchema = z.object({
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535),
	secure: z.boolean(),
	user: z.string().min(1),
	password: z.string().min(1),
	from: z.string().email(),
	to: z.string().email(),
});

export const browserPushConfigSchema = z.object({
	endpoint: publicUrlSchema,
	p256dh: z.string().min(1),
	auth: z.string().min(1),
});

export const pushbulletConfigSchema = z.object({
	apiToken: z.string().min(1),
});

export const pushoverConfigSchema = z.object({
	userKey: z.string().min(1),
	apiToken: z.string().min(1),
});

export const gotifyConfigSchema = z.object({
	serverUrl: publicUrlSchema,
	appToken: z.string().min(1),
});

export const webhookConfigSchema = z.object({
	url: publicUrlSchema,
	method: z.enum(["POST", "PUT"]).default("POST"),
	headers: z.record(z.string(), z.string()).optional(),
	secret: z.string().optional(),
});

export const slackConfigSchema = z.object({
	webhookUrl: publicUrlSchema,
});

export const ntfyConfigSchema = z.object({
	serverUrl: publicUrlSchema,
	topic: z.string().min(1),
	token: z.string().optional(),
});

export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type BrowserPushConfig = z.infer<typeof browserPushConfigSchema>;
export type PushbulletConfig = z.infer<typeof pushbulletConfigSchema>;
export type PushoverConfig = z.infer<typeof pushoverConfigSchema>;
export type GotifyConfig = z.infer<typeof gotifyConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type SlackConfig = z.infer<typeof slackConfigSchema>;
export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;

/** Union of all channel config schemas, discriminated by channel type */
export const channelConfigSchemaMap: Record<NotificationChannelType, z.ZodType> = {
	DISCORD: discordConfigSchema,
	TELEGRAM: telegramConfigSchema,
	EMAIL: emailConfigSchema,
	BROWSER_PUSH: browserPushConfigSchema,
	PUSHBULLET: pushbulletConfigSchema,
	PUSHOVER: pushoverConfigSchema,
	GOTIFY: gotifyConfigSchema,
	WEBHOOK: webhookConfigSchema,
	SLACK: slackConfigSchema,
	NTFY: ntfyConfigSchema,
};

// ============================================================================
// API Request/Response Types
// ============================================================================

/** Create/update a notification channel */
export const createNotificationChannelSchema = z.object({
	name: z.string().min(1).max(100),
	type: notificationChannelTypeSchema,
	enabled: z.boolean().optional().default(true),
	config: z.record(z.string(), z.unknown()), // Validated per-type at runtime
});

export const updateNotificationChannelSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	enabled: z.boolean().optional(),
	config: z.record(z.string(), z.unknown()).optional(),
});

/** Bulk update event subscriptions */
export const updateSubscriptionsSchema = z.object({
	subscriptions: z.array(
		z.object({
			channelId: z.string(),
			eventType: notificationEventTypeSchema,
			enabled: z.boolean(),
		}),
	),
});

/** Register a browser push subscription */
export const pushSubscriptionSchema = z.object({
	endpoint: publicUrlSchema,
	keys: z.object({
		p256dh: z.string().min(1),
		auth: z.string().min(1),
	}),
});

export type CreateNotificationChannel = z.infer<typeof createNotificationChannelSchema>;
export type UpdateNotificationChannel = z.infer<typeof updateNotificationChannelSchema>;
export type UpdateSubscriptions = z.infer<typeof updateSubscriptionsSchema>;
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

// ============================================================================
// Notification Rules
// ============================================================================

export const ruleConditionSchema = z.object({
	field: z.string().min(1), // "eventType", "title", "body", "metadata.*"
	operator: z.enum(["equals", "not_equals", "contains", "greater_than", "in"]),
	value: z.union([z.string(), z.number(), z.array(z.string())]),
});

export const createNotificationRuleSchema = z.object({
	name: z.string().min(1).max(100),
	enabled: z.boolean().optional().default(true),
	priority: z.number().int().min(0).max(1000).optional().default(0),
	action: z.enum(["suppress", "throttle", "route"]),
	conditions: z.array(ruleConditionSchema).min(1),
	targetChannelIds: z.array(z.string()).optional(),
	throttleMinutes: z.number().int().min(1).max(1440).optional(),
});

export const updateNotificationRuleSchema = createNotificationRuleSchema.partial();

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type CreateNotificationRule = z.infer<typeof createNotificationRuleSchema>;
export type UpdateNotificationRule = z.infer<typeof updateNotificationRuleSchema>;

export interface NotificationRuleResponse {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	action: "suppress" | "throttle" | "route";
	conditions: RuleCondition[];
	targetChannelIds: string[] | null;
	throttleMinutes: number | null;
	createdAt: string;
	updatedAt: string;
}

// ============================================================================
// Aggregation Config
// ============================================================================

export const updateAggregationConfigSchema = z.object({
	configs: z.array(
		z.object({
			eventType: notificationEventTypeSchema,
			windowSeconds: z.number().int().min(60).max(3600).optional().default(300),
			maxBatchSize: z.number().int().min(2).max(100).optional().default(10),
			enabled: z.boolean(),
		}),
	),
});

export type UpdateAggregationConfig = z.infer<typeof updateAggregationConfigSchema>;

export interface AggregationConfigResponse {
	eventType: NotificationEventType;
	windowSeconds: number;
	maxBatchSize: number;
	enabled: boolean;
}

// ============================================================================
// Statistics
// ============================================================================

export interface NotificationStatisticsResponse {
	period: { days: number; since: string; until: string };
	totals: {
		sent: number;
		failed: number;
		deadLetter: number;
		total: number;
		successRate: number;
	};
	perChannel: Array<{
		channelId: string;
		channelType: NotificationChannelType;
		sent: number;
		failed: number;
		successRate: number;
	}>;
	perEventType: Array<{
		eventType: NotificationEventType;
		count: number;
	}>;
	dailyTrend: Array<{
		date: string;
		sent: number;
		failed: number;
	}>;
}

// ============================================================================
// Response Types
// ============================================================================

/** Channel as returned by the API (config omitted for security, only metadata) */
export interface NotificationChannelResponse {
	id: string;
	name: string;
	type: NotificationChannelType;
	enabled: boolean;
	lastTestedAt: string | null;
	lastTestResult: string | null;
	createdAt: string;
	updatedAt: string;
	subscriptions: NotificationEventType[];
}

/** Notification delivery log entry */
export interface NotificationLogEntry {
	id: string;
	channelId: string;
	channelType: NotificationChannelType;
	eventType: NotificationEventType;
	title: string;
	body: string;
	status: "sent" | "failed" | "dead_letter";
	error: string | null;
	retryCount: number;
	sentAt: string;
}

/** Subscription grid: which events are enabled for which channels */
export interface SubscriptionGrid {
	channels: Array<{ id: string; name: string; type: NotificationChannelType }>;
	events: NotificationEventType[];
	subscriptions: Array<{
		channelId: string;
		eventType: NotificationEventType;
	}>;
}
