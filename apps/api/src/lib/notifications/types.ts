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
 * Interface that all channel senders must implement.
 * Each sender handles one NotificationChannelType.
 */
export interface ChannelSender {
	/** Deliver a notification through this channel */
	send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
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
 * Logger interface matching Fastify's pino logger.
 */
export interface NotificationLogger {
	info: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	warn: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	error: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
	debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => void;
}
