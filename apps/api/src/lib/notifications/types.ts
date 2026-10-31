import type { NotificationEventType, NotificationFailureCategory } from "@arr/shared";

export type { NotificationFailureCategory } from "@arr/shared";

/** Encrypted connection identity captured before an actual delivery attempt. */
export interface DeliveryAttemptContext {
	readonly id: string;
	readonly userId: string;
	readonly type: string;
	readonly encryptedConfig: string;
	readonly configIv: string;
}

/** Retry config and its generation must come from the same recipient resolution. */
export interface DeliveryRecipient {
	readonly config: Record<string, unknown>;
	readonly context: DeliveryAttemptContext;
}

export function captureDeliveryAttempt(channel: DeliveryAttemptContext): DeliveryAttemptContext {
	return Object.freeze({
		id: channel.id,
		userId: channel.userId,
		type: channel.type,
		encryptedConfig: channel.encryptedConfig,
		configIv: channel.configIv,
	});
}

export function isDeliveryAttemptContext(
	context: DeliveryAttemptContext | undefined,
	channelId: string,
	channelType: string,
): context is DeliveryAttemptContext {
	return (
		!!context &&
		context.id === channelId &&
		context.type === channelType &&
		[context.id, context.userId, context.type, context.encryptedConfig, context.configIv].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	);
}

/**
 * Payload sent to channel senders for delivery.
 */
export interface NotificationPayload {
	eventType: NotificationEventType;
	title: string;
	body: string;
	/** Optional URL to link to (e.g., the relevant dashboard page) */
	url?: string;
	/** Optional metadata for templating/enrichment */
	metadata?: Record<string, unknown>;
}

/**
 * Result of a channel send attempt.
 * Replaces throw-on-failure: callers inspect the result to decide retry/log.
 */
export interface SendResult {
	success: boolean;
	retryable: boolean;
	retryAfterMs?: number;
	error?: string;
	/** Evidence-derived category, never provider response or exception text. */
	failureCategory?: NotificationFailureCategory;
}

/**
 * Interface that all channel senders must implement.
 * Each sender handles one NotificationChannelType.
 */
export interface ChannelSender {
	/** Deliver a notification through this channel */
	send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult>;
	/** Test connectivity/authentication for this channel */
	test(config: Record<string, unknown>): Promise<void>;
}

/**
 * Form field descriptor for dynamic channel configuration forms.
 */
export interface ChannelFormField {
	key: string;
	label: string;
	type: "text" | "url" | "email" | "password" | "number" | "boolean" | "headers";
	placeholder?: string;
	required?: boolean;
}

/**
 * Channel plugin manifest — metadata + sender for a channel type.
 * Enables dynamic form rendering and auto-registration.
 */
export interface ChannelPlugin {
	type: string;
	label: string;
	icon: string; // Lucide icon name (resolved on frontend)
	configSchema: string; // Reference to shared Zod schema name
	formFields: ChannelFormField[];
	sender: ChannelSender;
}

/**
 * Logger interface matching Fastify's pino logger.
 */
export interface NotificationLogger {
	info: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
}
