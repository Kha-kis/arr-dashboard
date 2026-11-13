import { z } from "zod";

/** Wire marker for retaining an existing server-side notification config value. */
export const REDACTED_NOTIFICATION_CONFIG_VALUE = "••••••••";

/** Controlled evidence categories; provider exception text is never a category. */
export const notificationFailureCategorySchema = z.enum([
	"authentication",
	"rate-limited",
	"provider-unavailable",
	"timeout",
	"transport",
	"rejected",
	"subscription-expired",
	"configuration",
	"unsupported",
	"retry-exhausted",
	"shutdown",
	"unknown",
]);
export type NotificationFailureCategory = z.infer<typeof notificationFailureCategorySchema>;

const NOTIFICATION_FAILURE_MESSAGES: Record<NotificationFailureCategory, string> = {
	authentication: "Provider authentication failed. Check channel credentials and permissions.",
	"rate-limited":
		"Provider rate limited delivery. Wait before retrying; check the provider limits.",
	"provider-unavailable": "Provider is unavailable. Check provider availability before retrying.",
	timeout: "Delivery timed out. Check provider availability and network connectivity.",
	transport: "Network delivery failed. Check connectivity, TLS and proxy settings.",
	rejected: "Provider rejected delivery. Check channel settings and recipient permissions.",
	"subscription-expired": "Browser push subscription expired. Enable browser notifications again.",
	configuration: "Channel configuration could not be read. Check and re-save channel settings.",
	unsupported: "Channel delivery is unsupported. Check the channel type and server setup.",
	"retry-exhausted":
		"Delivery was not confirmed after retries. Check channel settings and provider availability.",
	shutdown:
		"Pending delivery was not confirmed before shutdown. Check delivery history after startup.",
	unknown: "Delivery was not confirmed. Check channel settings and provider availability.",
};

/** Both server and UI derive fixed guidance from the category, never response text. */
export function notificationFailureMessage(category: unknown): string {
	return typeof category === "string" && Object.hasOwn(NOTIFICATION_FAILURE_MESSAGES, category)
		? NOTIFICATION_FAILURE_MESSAGES[category as NotificationFailureCategory]
		: NOTIFICATION_FAILURE_MESSAGES.unknown;
}

/** Provider Test outcome is independent of saving status for its tested connection. */
export type NotificationTestResult =
	| { success: true; statusRecorded: boolean }
	| { success: false; statusRecorded: boolean; failureCategory: NotificationFailureCategory };

// ============================================================================
// Validation Helpers
// ============================================================================

/** Block URLs targeting private/internal networks (SSRF prevention) */
function isPrivateUrl(rawUrl: string): boolean {
	try {
		const u = new URL(rawUrl);

		// Only allow http/https — blocks file://, ftp://, data://, javascript://, etc.
		if (u.protocol !== "http:" && u.protocol !== "https:") return true;

		const host = u.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host.startsWith("127.") ||
			host.startsWith("0.") ||
			host.startsWith("10.") ||
			host.startsWith("100.") ||
			host.startsWith("192.168.") ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
			host === "0.0.0.0" ||
			host === "::1" ||
			host === "[::1]" ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe80") ||
			host.startsWith("[fc") ||
			host.startsWith("[fd") ||
			host.startsWith("[fe80") ||
			host === "169.254.169.254" ||
			host.startsWith("169.254.") ||
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
		message: "URL must use http/https and not target private or internal networks",
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

/** Owned repair admission only. Never include configuration or delivery diagnostics. */
export const notificationChannelEditStateSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.refine((value) => value.trim().length > 0),
		name: z.string().min(1).max(100),
		type: notificationChannelTypeSchema,
		enabled: z.boolean(),
		configRevision: z.string().regex(/^[a-f0-9]{64}$/),
		state: z.enum(["readable", "repair-required"]),
	})
	.strict();

export type NotificationChannelEditState = z.infer<typeof notificationChannelEditStateSchema>;

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
	// qui (torrent layer) — fired on state transitions detected by the
	// periodic qui torrent-state sync. Only *arr-correlated torrents
	// (those with a LibraryCache row) trigger these.
	"QUI_TORRENT_ERRORED",
	"QUI_DOWNLOAD_STALLED",
	// `QUI_TORRENT_COMPLETED` fires when a torrent transitions out of
	// `downloading` or `stalled_dl` and into `seeding` — the precise
	// signal "this just finished downloading and is now sharing." NOT
	// fired on `paused`→`seeding` (resume) or unseen→`seeding`
	// (already-complete at first sync) — those would be noise.
	"QUI_TORRENT_COMPLETED",
	// TRaSH Guides
	"TRASH_PROFILE_UPDATED",
	"TRASH_SYNC_ERROR",
	"TRASH_DEPLOY_FAILED",
	"TRASH_DEPLOY_UNCERTAIN",
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
	// Jellyfin Analytics
	"JELLYFIN_CONCURRENT_PEAK",
	"JELLYFIN_TRANSCODE_HEAVY",
	"JELLYFIN_NEW_DEVICE",
	// System
	"SYSTEM_STARTUP",
	"SYSTEM_ERROR",
	"VALIDATION_HEALTH_DEGRADED",
	// Library Insights
	"LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
	"LIBRARY_INSIGHT_WATCHED_MONITORED",
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

const pushChannelIdSchema = z.string().trim().min(1).max(256);
const pushRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pushSelectorFields = {
	endpoint: publicUrlSchema.optional(),
	channelId: pushChannelIdSchema.optional(),
};
export const browserPushStateRequestSchema = z
	.object(pushSelectorFields)
	.refine(
		(value) => value.endpoint !== undefined || value.channelId !== undefined,
		"A device selector is required",
	);
export const browserPushDisableRequestSchema = z
	.object({
		...pushSelectorFields,
		expectedRevision: pushRevisionSchema.optional(),
	})
	.refine(
		(value) => value.endpoint !== undefined || value.channelId !== undefined,
		"A device selector is required",
	)
	.refine(
		(value) => (value.channelId !== undefined) === (value.expectedRevision !== undefined),
		"A retained device requires its current revision",
	);
export const browserPushEnableRequestSchema = z
	.object({
		endpoint: publicUrlSchema,
		keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
		channelId: pushChannelIdSchema.optional(),
		expectedRevision: pushRevisionSchema.optional(),
	})
	.refine(
		(value) => (value.channelId !== undefined) === (value.expectedRevision !== undefined),
		"A retained device requires its current revision",
	);
export const browserPushStateSchema = z.discriminatedUnion("state", [
	z.object({
		channelId: z.null(),
		configRevision: z.null(),
		state: z.literal("unregistered"),
		subscribedEventCount: z.literal(0),
	}),
	z.object({
		channelId: pushChannelIdSchema,
		configRevision: pushRevisionSchema,
		state: z.literal("enabled"),
		subscribedEventCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		channelId: pushChannelIdSchema,
		configRevision: pushRevisionSchema,
		state: z.literal("disabled"),
		subscribedEventCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	}),
]);
/** Explicit replacement of one selected channel, including unreadable old settings. */
export const browserPushReconnectRequestSchema = z
	.object({
		channelId: pushChannelIdSchema,
		expectedRevision: pushRevisionSchema,
		endpoint: browserPushConfigSchema.shape.endpoint,
		keys: z
			.object({
				p256dh: browserPushConfigSchema.shape.p256dh,
				auth: browserPushConfigSchema.shape.auth,
			})
			.strict(),
	})
	.strict();
export type BrowserPushReconnectRequest = z.infer<typeof browserPushReconnectRequestSchema>;
export type BrowserPushStateRequest = z.infer<typeof browserPushStateRequestSchema>;
export type BrowserPushDisableRequest = z.infer<typeof browserPushDisableRequestSchema>;
export type BrowserPushEnableRequest = z.infer<typeof browserPushEnableRequestSchema>;
export type BrowserPushState = z.infer<typeof browserPushStateSchema>;

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

// URLs may contain credentials; arbitrary headers are retained as one private
// container. This membership is shared by redaction, retention and read admission.
export const NOTIFICATION_CONFIG_PRIVATE_FIELDS = {
	DISCORD: ["webhookUrl"],
	SLACK: ["webhookUrl"],
	TELEGRAM: ["botToken"],
	EMAIL: ["password"],
	BROWSER_PUSH: ["endpoint", "p256dh", "auth"],
	PUSHBULLET: ["apiToken"],
	PUSHOVER: ["userKey", "apiToken"],
	GOTIFY: ["serverUrl", "appToken"],
	NTFY: ["serverUrl", "token"],
	WEBHOOK: ["url", "headers", "secret"],
} as const satisfies Record<NotificationChannelType, readonly string[]>;

function redactedConfigSchema(
	type: NotificationChannelType,
	schema: z.ZodObject<Record<string, z.ZodType>>,
) {
	const privateFields: readonly string[] = NOTIFICATION_CONFIG_PRIVATE_FIELDS[type];
	const shape: Record<string, z.ZodType> = {};
	for (const [key, field] of Object.entries(schema.shape)) {
		shape[key] = privateFields.includes(key)
			? z.union([field, z.literal(REDACTED_NOTIFICATION_CONFIG_VALUE)])
			: field.refine((value) => value !== REDACTED_NOTIFICATION_CONFIG_VALUE);
	}
	return z.object(shape);
}

// Retained markers are a read-only wire representation, not write validation.
const redactedChannelConfigSchemaMap: Record<NotificationChannelType, z.ZodType> = {
	DISCORD: redactedConfigSchema("DISCORD", discordConfigSchema),
	TELEGRAM: redactedConfigSchema("TELEGRAM", telegramConfigSchema),
	EMAIL: redactedConfigSchema("EMAIL", emailConfigSchema),
	BROWSER_PUSH: redactedConfigSchema("BROWSER_PUSH", browserPushConfigSchema),
	PUSHBULLET: redactedConfigSchema("PUSHBULLET", pushbulletConfigSchema),
	PUSHOVER: redactedConfigSchema("PUSHOVER", pushoverConfigSchema),
	GOTIFY: redactedConfigSchema("GOTIFY", gotifyConfigSchema),
	WEBHOOK: redactedConfigSchema("WEBHOOK", webhookConfigSchema),
	SLACK: redactedConfigSchema("SLACK", slackConfigSchema),
	NTFY: redactedConfigSchema("NTFY", ntfyConfigSchema),
};

/** Only the six editor fields; delivery/list/debug metadata confers no admission. */
export const notificationChannelConfigReadSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.refine((value) => value.trim().length > 0),
		name: z.string().min(1).max(100),
		type: notificationChannelTypeSchema,
		enabled: z.boolean(),
		config: z.unknown(),
		configRevision: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.transform((value, ctx) => {
		const config = redactedChannelConfigSchemaMap[value.type].safeParse(value.config);
		if (!config.success) {
			ctx.addIssue({ code: "custom", message: "Invalid channel configuration" });
			return z.NEVER;
		}
		return { ...value, config: config.data as Record<string, unknown> };
	});

export type NotificationChannelConfigRead = z.infer<typeof notificationChannelConfigReadSchema>;

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
	/** Conditional edit precondition; omitted only by intentionally blind legacy patches. */
	expectedRevision: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
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

const timeFormatRegex = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const createNotificationRuleSchema = z.object({
	name: z.string().min(1).max(100),
	enabled: z.boolean().optional().default(true),
	priority: z.number().int().min(0).max(1000).optional().default(0),
	action: z.enum(["suppress", "throttle", "route", "quiet_hours"]),
	conditions: z.array(ruleConditionSchema).min(1),
	targetChannelIds: z.array(z.string()).optional(),
	throttleMinutes: z.number().int().min(1).max(1440).optional(),
	quietHoursStart: z.string().regex(timeFormatRegex, "Must be HH:MM (00:00–23:59)").optional(),
	quietHoursEnd: z.string().regex(timeFormatRegex, "Must be HH:MM (00:00–23:59)").optional(),
	quietHoursTimezone: z.string().min(1).max(64).optional(),
});

export const updateNotificationRuleSchema = createNotificationRuleSchema.partial().extend({
	enabled: z.boolean().optional(),
	priority: z.number().int().min(0).max(1000).optional(),
});

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type CreateNotificationRule = z.infer<typeof createNotificationRuleSchema>;
export type UpdateNotificationRule = z.infer<typeof updateNotificationRuleSchema>;

export interface NotificationRuleResponse {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	action: "suppress" | "throttle" | "route" | "quiet_hours";
	conditions: RuleCondition[];
	targetChannelIds: string[] | null;
	throttleMinutes: number | null;
	quietHoursStart: string | null;
	quietHoursEnd: string | null;
	quietHoursTimezone: string | null;
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

/** Read observation only: event and recipient counts have different units. */
export type NotificationQueueObservation =
	| {
			state: "observed";
			observedAt: string;
			events: { ready: number; deferred: number; aggregating: number };
			deliveries: { ready: number; retryWaiting: number; submitting: number; uncertain: number };
			oldestDueAt: string | null;
	  }
	| { state: "unavailable"; reason: "storage-unavailable" | "state-unavailable" };

export interface NotificationStatisticsResponse {
	/** Legacy absence is unavailable evidence, never an observed empty queue. */
	queue?: NotificationQueueObservation;
	period: { days: number; since: string; until: string };
	totals: {
		sent: number;
		failed: number;
		deadLetter: number;
		/** Absent on legacy observations; absence does not establish zero. */
		unclassified?: number;
		total: number;
		successRate: number;
	};
	perChannel: Array<{
		channelId: string;
		channelType: NotificationChannelType;
		sent: number;
		failed: number;
		unclassified?: number;
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
		unclassified?: number;
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

/** Owned grid read inside the save transaction, returned only after commit. */
export interface SubscriptionUpdateResponse {
	success: true;
	grid: SubscriptionGrid;
	omittedCount: number;
}
