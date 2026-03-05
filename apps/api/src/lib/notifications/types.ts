import type { NotificationChannelType, NotificationEventType } from "@arr/shared";

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
 * Decrypted channel config as stored in the database.
 */
export interface DecryptedChannelConfig {
	channelId: string;
	channelType: NotificationChannelType;
	config: Record<string, unknown>;
}

/**
 * Form field descriptor for dynamic channel configuration forms.
 */
export interface ChannelFormField {
	key: string;
	label: string;
	type: "text" | "url" | "email" | "password" | "number" | "boolean";
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
