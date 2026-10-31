import type { NotificationChannelType } from "@arr/shared";
import {
	CleanupMaintenanceConflictError,
	retainCleanupOperation,
} from "../library-cleanup/cleanup-maintenance-gate.js";
import { notificationFailureMessage } from "./failure-diagnostics.js";
import {
	captureDeliveryAttempt,
	isDeliveryAttemptContext,
	type DeliveryAttemptContext,
	type DeliveryRecipient,
	type NotificationLogger,
	type NotificationPayload,
	type SendResult,
} from "./types.js";

interface RetryItem {
	channelType: NotificationChannelType;
	resolveRecipient: () => Promise<DeliveryRecipient | null>;
	attemptContext: DeliveryAttemptContext;
	payload: NotificationPayload;
	channelId: string;
	attempt: number;
	resolutionFailed: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	operation: ReturnType<typeof retainCleanupOperation>;
}

const BACKOFF_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
const MAX_RETRIES = 3;

export class RetryHandler {
	private queue: Map<string, RetryItem> = new Map();
	private nextRetryId = 0;
	private timersPaused = false;
	private admissionClosed = false;
	private activeRetries = new Set<Promise<void>>();
	private flushPromise: Promise<void> | null = null;
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
		attemptContext?: DeliveryAttemptContext,
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
			attemptContext?: DeliveryAttemptContext,
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
		resolveRecipient: () => Promise<DeliveryRecipient | null>;
		attemptContext: DeliveryAttemptContext;
		payload: NotificationPayload;
		retryAfterMs?: number;
	}): void {
		if (this.admissionClosed) throw new Error("Notification retries are shutting down");
		if (!isDeliveryAttemptContext(item.attemptContext, item.channelId, item.channelType)) return;
		const key = `${item.channelId}:${item.payload.eventType}:${Date.now()}:${this.nextRetryId++}`;
		const operation = retainCleanupOperation();
		try {
			this.scheduleRetry(key, {
				...item,
				operation,
				attemptContext: captureDeliveryAttempt(item.attemptContext),
				attempt: 0,
				resolutionFailed: false,
			});
		} catch (error) {
			void operation.release();
			throw error;
		}
	}

	private scheduleRetry(
		key: string,
		item: Omit<RetryItem, "timer"> & { retryAfterMs?: number },
	): Promise<void> | void {
		if (item.attempt >= MAX_RETRIES) {
			this.logger.warn(
				{ channelId: item.channelId, eventType: item.payload.eventType, attempts: item.attempt },
				item.resolutionFailed
					? "Notification retry canceled after recipient could not be revalidated"
					: "Notification dead-lettered after max retries",
			);
			const deadLetter = item.resolutionFailed
				? Promise.resolve()
				: item.operation
						.run(() =>
							this.logDeliveryFn(
								item.channelId,
								item.channelType,
								item.payload,
								"dead_letter",
								notificationFailureMessage("retry-exhausted"),
								item.attempt,
								item.attemptContext,
							),
						)
						.catch(() => {});
			this.queue.delete(key);
			return deadLetter;
		}

		const backoffMs =
			item.retryAfterMs ?? BACKOFF_MS[item.attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;

		this.logger.debug(
			{ channelId: item.channelId, attempt: item.attempt + 1, backoffMs },
			"Scheduling notification retry",
		);

		const queuedItem: RetryItem = { ...item, timer: null };
		let started = false;
		const runRetry = async () => {
			if (this.timersPaused || started || this.queue.get(key) !== queuedItem) return;
			started = true;
			// Timer removal is not completion: retain ownership through send, logs and rescheduling.
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			this.activeRetries.add(completion);
			let retryItem = item;
			try {
				await item.operation.run(async () => {
					let recipient: DeliveryRecipient | null;
					try {
						recipient = await item.resolveRecipient();
					} catch (resolveErr) {
						if (resolveErr instanceof CleanupMaintenanceConflictError) throw resolveErr;
						this.logger.warn(
							{ channelId: item.channelId, attempt: item.attempt + 1 },
							"Notification retry recipient could not be revalidated; retrying",
						);
						await this.scheduleRetry(key, {
							...item,
							attempt: item.attempt + 1,
							resolutionFailed: true,
						});
						return;
					}
					if (!this.matchesRecipient(item, recipient)) {
						this.logger.info(
							{ channelId: item.channelId, attempt: item.attempt + 1 },
							"Notification retry canceled because recipient is no longer eligible",
						);
						this.queue.delete(key);
						return;
					}

					// Capture before send; later revalidation cannot become evidence of an attempt.
					retryItem = {
						...item,
						attemptContext: captureDeliveryAttempt(recipient.context),
						resolutionFailed: false,
					};
					const result = await this.sendFn(item.channelType, recipient.config, item.payload);
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
							retryItem.attemptContext,
						).catch(() => {});
						this.queue.delete(key);
					} else if (result.retryable) {
						await this.scheduleRetry(key, {
							...retryItem,
							attempt: item.attempt + 1,
							retryAfterMs: result.retryAfterMs,
						});
					} else {
						this.logger.warn(
							{
								channelId: item.channelId,
								error: notificationFailureMessage(result.failureCategory),
							},
							"Notification retry failed with non-retryable error",
						);
						await this.logDeliveryFn(
							item.channelId,
							item.channelType,
							item.payload,
							"dead_letter",
							notificationFailureMessage(result.failureCategory),
							item.attempt + 1,
							retryItem.attemptContext,
						).catch(() => {});
						this.queue.delete(key);
					}
				});
			} catch (retryErr) {
				if (retryErr instanceof CleanupMaintenanceConflictError) {
					this.logger.debug(
						{ channelId: item.channelId, attempt: item.attempt + 1 },
						"Notification retry paused during database maintenance",
					);
					await this.scheduleRetry(key, { ...retryItem, attempt: item.attempt });
					return;
				}
				this.logger.warn(
					{ channelId: item.channelId, attempt: item.attempt + 1 },
					"Notification retry threw unexpected error, re-queuing",
				);
				await this.scheduleRetry(key, { ...retryItem, attempt: item.attempt + 1 });
			} finally {
				if (!this.queue.has(key)) await item.operation.release();
				this.activeRetries.delete(completion);
				settle();
			}
		};
		const timer = this.timersPaused ? null : setTimeout(runRetry, backoffMs);

		// Prevent timer from blocking Node.js shutdown
		timer?.unref();

		queuedItem.timer = timer;
		this.queue.set(key, queuedItem);
	}

	private matchesRecipient(
		item: RetryItem | Omit<RetryItem, "timer">,
		recipient: DeliveryRecipient | null,
	): recipient is DeliveryRecipient {
		return (
			!!recipient &&
			isDeliveryAttemptContext(recipient.context, item.channelId, item.channelType) &&
			recipient.context.userId === item.attemptContext.userId &&
			!!recipient.config &&
			typeof recipient.config === "object" &&
			!Array.isArray(recipient.config)
		);
	}

	/** Pause automatic attempts while already-admitted producers may still enqueue retries. */
	pauseTimers(): void {
		this.timersPaused = true;
		for (const item of this.queue.values()) {
			if (item.timer) clearTimeout(item.timer);
		}
	}

	/** Finish active attempts before abandoning queued retries, once, during shutdown. */
	flush(): Promise<void> {
		this.admissionClosed = true;
		this.pauseTimers();
		this.flushPromise ??= this.flushPending();
		return this.flushPromise;
	}

	private async flushPending(): Promise<void> {
		while (this.activeRetries.size > 0) await Promise.all(this.activeRetries);
		const pendingLogs: Promise<void>[] = [];
		for (const [, item] of this.queue) {
			if (item.timer) clearTimeout(item.timer);
			pendingLogs.push(
				item.operation
					.run(async () => {
						let recipient: DeliveryRecipient | null;
						try {
							recipient = await item.resolveRecipient();
						} catch {
							this.logger.warn(
								{ channelId: item.channelId, attempt: item.attempt },
								"Notification retry abandoned during shutdown because recipient could not be revalidated",
							);
							return;
						}

						if (!this.matchesRecipient(item, recipient)) {
							this.logger.info(
								{ channelId: item.channelId, attempt: item.attempt },
								"Notification retry abandoned during shutdown because recipient is no longer eligible",
							);
							return;
						}

						await this.logDeliveryFn(
							item.channelId,
							item.channelType,
							item.payload,
							"dead_letter",
							notificationFailureMessage("shutdown"),
							item.attempt,
							item.attemptContext,
						);
					})
					.catch(() => {})
					.finally(() => item.operation.release()),
			);
		}
		this.queue.clear();
		await Promise.all(pendingLogs);
	}

	get pendingCount(): number {
		return this.queue.size;
	}
}
