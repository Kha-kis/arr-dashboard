import type { NotificationChannelType } from "@arr/shared";
import type { NotificationLogger, NotificationPayload, SendResult } from "./types.js";

interface RetryItem {
	channelType: NotificationChannelType;
	config: Record<string, unknown>;
	payload: NotificationPayload;
	channelId: string;
	attempt: number;
	timer: ReturnType<typeof setTimeout>;
}

const BACKOFF_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
const MAX_RETRIES = 3;

export class RetryHandler {
	private queue: Map<string, RetryItem> = new Map();
	private sendFn: (
		type: NotificationChannelType,
		config: Record<string, unknown>,
		payload: NotificationPayload,
	) => Promise<SendResult>;
	private logDeliveryFn: (
		channelId: string,
		channelType: NotificationChannelType,
		payload: NotificationPayload,
		status: "sent" | "failed" | "dead_letter",
		error?: string,
		retryCount?: number,
	) => Promise<void>;
	private logger: NotificationLogger;

	constructor(
		sendFn: (
			type: NotificationChannelType,
			config: Record<string, unknown>,
			payload: NotificationPayload,
		) => Promise<SendResult>,
		logDeliveryFn: (
			channelId: string,
			channelType: NotificationChannelType,
			payload: NotificationPayload,
			status: "sent" | "failed" | "dead_letter",
			error?: string,
			retryCount?: number,
		) => Promise<void>,
		logger: NotificationLogger,
	) {
		this.sendFn = sendFn;
		this.logDeliveryFn = logDeliveryFn;
		this.logger = logger;
	}

	enqueue(item: {
		channelId: string;
		channelType: NotificationChannelType;
		config: Record<string, unknown>;
		payload: NotificationPayload;
		retryAfterMs?: number;
	}): void {
		const key = `${item.channelId}:${item.payload.eventType}:${Date.now()}`;
		this.scheduleRetry(key, { ...item, attempt: 0 });
	}

	private scheduleRetry(
		key: string,
		item: Omit<RetryItem, "timer"> & { retryAfterMs?: number },
	): void {
		if (item.attempt >= MAX_RETRIES) {
			this.logger.warn(
				{ channelId: item.channelId, eventType: item.payload.eventType, attempts: item.attempt },
				"Notification dead-lettered after max retries",
			);
			this.logDeliveryFn(
				item.channelId,
				item.channelType,
				item.payload,
				"dead_letter",
				`Exhausted ${MAX_RETRIES} retries`,
				item.attempt,
			).catch(() => {});
			this.queue.delete(key);
			return;
		}

		const backoffMs =
			item.retryAfterMs ?? BACKOFF_MS[item.attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;

		this.logger.debug(
			{ channelId: item.channelId, attempt: item.attempt + 1, backoffMs },
			"Scheduling notification retry",
		);

		const timer = setTimeout(async () => {
			try {
				const result = await this.sendFn(item.channelType, item.config, item.payload);
				if (result.success) {
					this.logger.info(
						{ channelId: item.channelId, attempt: item.attempt + 1 },
						"Notification retry succeeded",
					);
					await this.logDeliveryFn(
						item.channelId,
						item.channelType,
						item.payload,
						"sent",
						undefined,
						item.attempt + 1,
					).catch(() => {});
					this.queue.delete(key);
				} else if (result.retryable) {
					this.scheduleRetry(key, {
						...item,
						attempt: item.attempt + 1,
						retryAfterMs: result.retryAfterMs,
					});
				} else {
					this.logger.warn(
						{ channelId: item.channelId, error: result.error },
						"Notification retry failed with non-retryable error",
					);
					await this.logDeliveryFn(
						item.channelId,
						item.channelType,
						item.payload,
						"dead_letter",
						result.error,
						item.attempt + 1,
					).catch(() => {});
					this.queue.delete(key);
				}
			} catch {
				this.scheduleRetry(key, { ...item, attempt: item.attempt + 1 });
			}
		}, backoffMs);

		// Prevent timer from blocking Node.js shutdown
		if (timer.unref) timer.unref();

		this.queue.set(key, { ...item, timer, attempt: item.attempt });
	}

	/** Flush all pending retries (for graceful shutdown) */
	flush(): void {
		for (const [, item] of this.queue) {
			clearTimeout(item.timer);
			this.logDeliveryFn(
				item.channelId,
				item.channelType,
				item.payload,
				"dead_letter",
				"Server shutdown — retry abandoned",
				item.attempt,
			).catch(() => {});
		}
		this.queue.clear();
	}

	get pendingCount(): number {
		return this.queue.size;
	}
}
