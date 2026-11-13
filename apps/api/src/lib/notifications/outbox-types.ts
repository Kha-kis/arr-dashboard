import type { NotificationChannelType, NotificationEventType } from "@arr/shared";
import type { DeliveryRecipient, NotificationPayload, SendResult } from "./types.js";

export interface NotificationOutboxRecipient {
	channelId: string;
	channelType: NotificationChannelType;
	subscriptionEventType: NotificationEventType;
}

export type NotificationOutboxPolicy =
	| { stage: "ready" }
	| { stage: "deferred"; dueAt: Date }
	| { stage: "aggregating"; windowSeconds: number; maxBatchSize: number };

/** Internal server admission; destination and Restore binding are never supplied by callers. */
export interface NotificationOutboxAdmission {
	payload: NotificationPayload;
	recipients: readonly NotificationOutboxRecipient[];
	fallbackEventTypes?: readonly NotificationEventType[];
	policy: NotificationOutboxPolicy;
}

/** Internal decrypted work, not an API response or a log payload. */
export interface NotificationOutboxWork {
	eventId: string;
	payload: NotificationPayload;
	recipients: NotificationOutboxRecipient[];
	fallbackEventTypes: NotificationEventType[];
	policy: NotificationOutboxPolicy;
}

/** In-process proof of an actual committed attempt; never an API or portable token. */
export interface NotificationOutboxAttempt {
	readonly deliveryId: string;
	readonly eventId: string;
	readonly userId: string;
	readonly token: string;
	readonly epoch: string;
	readonly ordinal: number;
	readonly configFingerprint: string;
	readonly recipient: DeliveryRecipient;
	readonly payload: NotificationPayload;
}

export type NotificationOutboxOutcome = SendResult | { outcome: "uncertain" };

/** Observed database state, not a count of provider acknowledgements. */
export interface NotificationOutboxQueueStatus {
	events: { ready: number; deferred: number; aggregating: number };
	deliveries: { ready: number; retryWaiting: number; submitting: number; uncertain: number };
	oldestDueAt: Date | null;
}

export class NotificationOutboxError extends Error {
	constructor(
		readonly category:
			| "payload-unavailable"
			| "recipient-unavailable"
			| "owner-unavailable"
			| "binding-unavailable"
			| "attempt-unavailable"
			| "outcome-unavailable"
			| "state-unavailable"
			| "storage-unavailable",
	) {
		super("Notification work is unavailable.");
		this.name = "NotificationOutboxError";
	}
}
