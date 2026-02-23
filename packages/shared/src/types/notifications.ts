import { z } from "zod";

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
]);

export type NotificationChannelType = z.infer<typeof notificationChannelTypeSchema>;

// ============================================================================
// Event Types
// ============================================================================

export const notificationEventTypeSchema = z.enum([
	"HUNT_CONTENT_FOUND",
	"HUNT_COMPLETED",
	"QUEUE_ITEMS_REMOVED",
	"QUEUE_STRIKES_ISSUED",
	"TRASH_PROFILE_UPDATED",
	"TRASH_SYNC_ERROR",
	"BACKUP_COMPLETED",
	"BACKUP_FAILED",
	"LIBRARY_NEW_CONTENT",
	"SYSTEM_STARTUP",
	"SYSTEM_ERROR",
	"CLEANUP_ITEMS_FLAGGED",
	"CLEANUP_ITEMS_REMOVED",
]);

export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

// ============================================================================
// Channel Config Schemas (per-type configuration)
// ============================================================================

export const discordConfigSchema = z.object({
	webhookUrl: z.string().url(),
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
	from: z.string().min(1),
	to: z.string().min(1),
});

export const browserPushConfigSchema = z.object({
	endpoint: z.string().url(),
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

export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type BrowserPushConfig = z.infer<typeof browserPushConfigSchema>;
export type PushbulletConfig = z.infer<typeof pushbulletConfigSchema>;
export type PushoverConfig = z.infer<typeof pushoverConfigSchema>;

/** Union of all channel config schemas, discriminated by channel type */
export const channelConfigSchemaMap: Record<NotificationChannelType, z.ZodType> = {
	DISCORD: discordConfigSchema,
	TELEGRAM: telegramConfigSchema,
	EMAIL: emailConfigSchema,
	BROWSER_PUSH: browserPushConfigSchema,
	PUSHBULLET: pushbulletConfigSchema,
	PUSHOVER: pushoverConfigSchema,
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
	endpoint: z.string().url(),
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
	status: "sent" | "failed";
	error: string | null;
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
