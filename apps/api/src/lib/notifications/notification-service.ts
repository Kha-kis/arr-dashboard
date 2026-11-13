import { AsyncLocalStorage } from "node:async_hooks";
import {
	type NotificationChannelType,
	type NotificationEventType,
	type NotificationTestResult,
	notificationFailureCategorySchema,
} from "@arr/shared";

import type { Encryptor } from "../auth/encryption.js";
import {
	assertRestoreRuntimeOperation,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
} from "../backup/restore-runtime-admission.js";
import {
	withCleanupOperationGuard,
	withIndependentCleanupOperationGuard,
} from "../library-cleanup/cleanup-maintenance-gate.js";
import type { PrismaClientInstance } from "../prisma.js";
import type {
	AggregationBuffer,
	AggregationConfig,
	AggregationScope,
} from "./aggregation-buffer.js";
import { channelConfigRevision } from "./channel-config-revision.js";
import { redactNotificationConfig, validateStoredNotificationConfig } from "./config-privacy.js";
import type { DedupGate } from "./dedup-gate.js";
import { NotificationFailureError, safeNotificationFailureMessage } from "./failure-diagnostics.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";
import { createNotificationOutboxRepository } from "./outbox-repository.js";
import { NotificationOutboxError, type NotificationOutboxPolicy } from "./outbox-types.js";
import { createNotificationOutboxWorker } from "./outbox-worker.js";
import type { RetryHandler } from "./retry-handler.js";
import type { NotificationRule, RuleEngine } from "./rule-engine.js";
import {
	type ChannelFormField,
	type DeliveryAttemptContext,
	isDeliveryAttemptContext,
	type NotificationLogger,
	type NotificationPayload,
} from "./types.js";

/**
 * Orchestrator for the notification system.
 * Resolves subscriptions and rules, then durably admits owner-scoped work before dispatch.
 */
export class NotificationService {
	private prisma: PrismaClientInstance;
	private encryptor: Encryptor;
	private dispatcher: NotificationDispatcher;
	private logger: NotificationLogger;
	private ruleEngine: RuleEngine | null;
	private readonly outboxRuntime: RestoreRuntime | null;
	private readonly clock: () => Date;
	private readonly workers = new Map<string, ReturnType<typeof createNotificationOutboxWorker>>();
	private baseUrl: string;
	private admissionClosed = false;
	private pendingNotifications = new Set<Promise<void>>();
	private readonly producerContext = new AsyncLocalStorage<{ active: boolean }>();
	private shutdownPromise: Promise<void> | null = null;
	private startupPromise: Promise<void> | null = null;
	private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		prisma: PrismaClientInstance,
		encryptor: Encryptor,
		dispatcher: NotificationDispatcher,
		logger: NotificationLogger,
		_dedupGate: DedupGate | undefined,
		_retryHandler: RetryHandler | undefined,
		baseUrl: string,
		ruleEngine?: RuleEngine,
		_createAggregationBuffer?: (
			deliverDigest: (digest: NotificationPayload, scope: AggregationScope) => Promise<void>,
		) => AggregationBuffer,
		outbox?: { runtime: RestoreRuntime; clock?: () => Date },
	) {
		this.prisma = prisma;
		this.encryptor = encryptor;
		this.dispatcher = dispatcher;
		this.logger = logger;
		this.baseUrl = normalizeBaseUrl(baseUrl);
		this.ruleEngine = ruleEngine ?? null;
		this.outboxRuntime = outbox?.runtime ?? null;
		this.clock = outbox?.clock ?? (() => new Date());
	}

	/** Update the public URL used to resolve relative notification links. */
	setBaseUrl(baseUrl: string): void {
		this.baseUrl = normalizeBaseUrl(baseUrl);
	}

	/** Stop worker wakeups; committed future work remains in the database. */
	dispose(): void {
		this.closeAdmission();
	}

	/** Stop incoming work without delaying sibling shutdown admission hooks. */
	closeAdmission(): void {
		this.admissionClosed = true;
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		for (const worker of this.workers.values()) worker.closeAdmission();
	}

	/** Join accepted producers and actual sends, without forcing future work to run. */
	shutdown(): Promise<void> {
		this.closeAdmission();
		if (!this.shutdownPromise) {
			this.shutdownPromise = this.drain();
		}
		return this.shutdownPromise;
	}

	/** Join discovery, accepted producers and actual sends, not idle future deadlines. */
	async drain(): Promise<void> {
		while (this.pendingNotifications.size > 0) await Promise.all(this.pendingNotifications);
		await Promise.all([...this.workers.values()].map((worker) => worker.drain()));
	}

	/** Called only after actual runtime activation; provider I/O does not block readiness. */
	start(): Promise<void> {
		if (this.admissionClosed || !this.outboxRuntime) {
			return Promise.reject(new NotificationOutboxError("binding-unavailable"));
		}
		if (this.startupPromise) return this.startupPromise;
		if (this.recoveryTimer) {
			clearTimeout(this.recoveryTimer);
			this.recoveryTimer = null;
		}
		const runtime = this.outboxRuntime;
		this.startupPromise = this.trackNotification(async () => {
			// Running native authority is mandatory, even when optional discovery fails.
			await runtime.runOperation(() => assertRestoreRuntimeOperation(runtime));
			try {
				let lastOwner: string | undefined;
				while (!this.admissionClosed) {
					const owners = await runtime.runIndependentOperation(() =>
						withCleanupOperationGuard(() =>
							this.prisma.user.findMany({
								where: {
									...(lastOwner ? { id: { gt: lastOwner } } : {}),
									notificationOutboxEvents: {
										some: { stage: { in: ["ready", "deferred", "aggregating"] } },
									},
								},
								select: { id: true },
								orderBy: { id: "asc" },
								take: 100,
							}),
						),
					);
					for (const owner of owners) {
						if (this.admissionClosed) break;
						void this.worker(owner.id)
							.start()
							.catch(() => {
								this.logger.warn(
									{ operation: "notification-recovery", status: "unavailable" },
									"Accepted notification work remains pending or unconfirmed",
								);
							});
					}
					if (owners.length < 100) break;
					lastOwner = owners[owners.length - 1]!.id;
				}
			} catch (error) {
				if (error instanceof RestoreRuntimeAdmissionError) throw error;
				this.startupPromise = null;
				this.logger.warn(
					{ operation: "notification-discovery", status: "unavailable" },
					"Accepted notification work remains pending or unconfirmed",
				);
				if (!this.admissionClosed) {
					// A wakeup holds no native/cleanup lease and never grants dispatch authority.
					this.recoveryTimer = setTimeout(() => {
						this.recoveryTimer = null;
						void this.start().catch(() => {
							this.logger.warn(
								{ operation: "notification-recovery", status: "unavailable" },
								"Accepted notification work remains pending or unconfirmed",
							);
						});
					}, 30_000);
					this.recoveryTimer.unref();
				}
			}
		}).catch((error) => {
			this.startupPromise = null;
			throw error;
		});
		return this.startupPromise;
	}

	private repository(userId: string) {
		if (!this.outboxRuntime) throw new NotificationOutboxError("binding-unavailable");
		return createNotificationOutboxRepository(
			this.prisma,
			this.outboxRuntime,
			this.encryptor,
			userId,
			{ clock: this.clock },
		);
	}

	private worker(userId: string) {
		if (!this.outboxRuntime) throw new NotificationOutboxError("binding-unavailable");
		let worker = this.workers.get(userId);
		if (!worker) {
			worker = createNotificationOutboxWorker({
				repository: this.repository(userId),
				runtime: this.outboxRuntime,
				dispatcher: this.dispatcher,
				logger: this.logger,
				clock: this.clock,
			});
			this.workers.set(userId, worker);
		}
		return worker;
	}

	private async trackNotification<T>(operation: () => Promise<T>): Promise<T> {
		let settle!: () => void;
		const completion = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.pendingNotifications.add(completion);
		try {
			return await operation();
		} finally {
			this.pendingNotifications.delete(completion);
			settle();
		}
	}

	/** Retain an accepted server-side producer and its notification handoffs during drain. */
	async runProducer<T>(operation: () => Promise<T>): Promise<T> {
		if (this.admissionClosed) throw new Error("Notification service is shutting down");
		return this.trackNotification(async () => {
			const scope = { active: true };
			try {
				return await withIndependentCleanupOperationGuard(() =>
					this.producerContext.run(scope, operation),
				);
			} finally {
				// Escaped async descendants cannot reuse a completed producer's admission.
				scope.active = false;
			}
		});
	}

	/**
	 * Persist selected work before returning or sending. Admission failures reject;
	 * post-acceptance processing failures leave durable pending/unconfirmed work.
	 */
	async notify(
		payload: NotificationPayload,
		options?: {
			skipRules?: boolean;
			userId?: string;
			fallbackEventTypes?: NotificationEventType[];
			recipientChannelIds?: string[];
		},
	): Promise<void> {
		if (this.admissionClosed && this.producerContext.getStore()?.active !== true) {
			throw new Error("Notification service is shutting down");
		}
		if (!this.outboxRuntime) throw new NotificationOutboxError("binding-unavailable");
		return this.trackNotification(() =>
			this.outboxRuntime!.runOperation(() =>
				withIndependentCleanupOperationGuard(() => this.notifyGuarded(payload, options)),
			),
		);
	}

	private async notifyGuarded(
		payload: NotificationPayload,
		options?: {
			skipRules?: boolean;
			userId?: string;
			fallbackEventTypes?: NotificationEventType[];
			recipientChannelIds?: string[];
		},
	): Promise<void> {
		const subscriptionEventTypes = [
			payload.eventType,
			...new Set(options?.fallbackEventTypes ?? []),
		];
		const subscriptions = await this.prisma.notificationSubscription.findMany({
			where: {
				eventType:
					subscriptionEventTypes.length === 1 ? payload.eventType : { in: subscriptionEventTypes },
				...(options?.userId !== undefined ? { channel: { userId: options.userId } } : {}),
				...(options?.recipientChannelIds ? { channelId: { in: options.recipientChannelIds } } : {}),
			},
			include: {
				channel: true,
			},
		});
		if (subscriptions.length === 0) {
			this.logger.debug(
				{ eventType: payload.eventType },
				"No channels subscribed to event, skipping notification",
			);
			return;
		}

		const subscriptionsByOwner = new Map<string, typeof subscriptions>();
		for (const subscription of subscriptions) {
			const ownerId = subscription.channel.userId;
			if (!ownerId || (options?.userId !== undefined && ownerId !== options.userId)) continue;
			const ownerSubscriptions = subscriptionsByOwner.get(ownerId) ?? [];
			ownerSubscriptions.push(subscription);
			subscriptionsByOwner.set(ownerId, ownerSubscriptions);
		}

		for (const [userId, ownerSubscriptions] of subscriptionsByOwner) {
			await this.notifyOwner(payload, options ?? {}, userId, ownerSubscriptions);
		}
	}

	private async notifyOwner(
		payload: NotificationPayload,
		options: {
			skipRules?: boolean;
			fallbackEventTypes?: NotificationEventType[];
			recipientChannelIds?: string[];
		},
		userId: string,
		subscriptions: Array<{
			channelId: string;
			eventType: string;
			channel: {
				id: string;
				userId: string;
				name: string;
				type: string;
				enabled: boolean;
				encryptedConfig: string;
				configIv: string;
			};
		}>,
	): Promise<void> {
		const enabledByChannel = new Map<string, (typeof subscriptions)[number]>();
		for (const subscription of subscriptions
			.filter(
				(sub) =>
					sub.channel.enabled &&
					(!options.recipientChannelIds || options.recipientChannelIds.includes(sub.channelId)),
			)
			.sort(
				(left, right) =>
					Number(left.eventType !== payload.eventType) -
					Number(right.eventType !== payload.eventType),
			)) {
			if (!enabledByChannel.has(subscription.channelId)) {
				enabledByChannel.set(subscription.channelId, subscription);
			}
		}
		let enabledSubs = [...enabledByChannel.values()];
		if (enabledSubs.length === 0) {
			this.logger.debug(
				{ eventType: payload.eventType, userId },
				"No channels subscribed to event, skipping notification",
			);
			return;
		}

		let policy: NotificationOutboxPolicy = { stage: "ready" };
		if (this.ruleEngine && !options.skipRules) {
			const rules = await this.loadRules(userId);
			const ruleResult = this.ruleEngine.evaluate(payload, rules);
			if (ruleResult) {
				if (ruleResult.action === "suppress") {
					this.logger.info(
						{ eventType: payload.eventType, ruleId: ruleResult.ruleId, userId },
						"Notification suppressed by rule",
					);
					return;
				}
				if (ruleResult.action === "defer" && ruleResult.deferUntil) {
					policy = { stage: "deferred", dueAt: new Date(ruleResult.deferUntil) };
				}
				if (ruleResult.action === "throttle" && ruleResult.throttleMinutes) {
					const lastSent = await this.getLastSentTime(payload.eventType, userId);
					if (
						lastSent &&
						this.clock().getTime() - lastSent.getTime() < ruleResult.throttleMinutes * 60_000
					) {
						this.logger.debug(
							{ eventType: payload.eventType, ruleId: ruleResult.ruleId, userId },
							"Notification throttled by rule",
						);
						return;
					}
				}
				if (ruleResult.action === "route") {
					const targetSet = new Set(ruleResult.targetChannelIds ?? []);
					enabledSubs = enabledSubs.filter((sub) => targetSet.has(sub.channelId));
					if (enabledSubs.length === 0) return;
				}
			}
		}

		if (
			policy.stage === "ready" &&
			!options.fallbackEventTypes?.length &&
			payload.metadata?.aggregated !== true
		) {
			const config = (await this.loadAggregationConfigs(userId)).find(
				(config) => config.eventType === payload.eventType,
			);
			if (config)
				policy = {
					stage: "aggregating",
					windowSeconds: config.windowSeconds,
					maxBatchSize: config.maxBatchSize,
				};
		}
		if (payload.url) payload = { ...payload, url: resolveUrl(payload.url, this.baseUrl) };
		await this.repository(userId).admit({
			payload,
			fallbackEventTypes: options.fallbackEventTypes,
			policy,
			recipients: enabledSubs.map((sub) => ({
				channelId: sub.channelId,
				channelType: sub.channel.type as NotificationChannelType,
				subscriptionEventType: sub.eventType as NotificationEventType,
			})),
		});
		// A producer already admitted before close may hand off work, but cannot
		// create a new physical send during shutdown. The next startup resumes it.
		if (this.admissionClosed) return;
		try {
			await this.worker(userId).start();
		} catch {
			this.logger.warn(
				{ operation: "notification-processing", status: "unavailable" },
				"Accepted notification work remains pending or unconfirmed",
			);
		}
	}

	/**
	 * Test a specific channel's connectivity by decrypting its config and calling the test method.
	 */
	async testChannel(channelId: string, userId: string): Promise<NotificationTestResult> {
		return withCleanupOperationGuard(() => this.testChannelGuarded(channelId, userId));
	}

	private async testChannelGuarded(
		channelId: string,
		userId: string,
	): Promise<NotificationTestResult> {
		const channel = await this.prisma.notificationChannel.findFirst({
			where: { id: channelId, userId },
		});

		if (!channel) {
			return { success: false, failureCategory: "unknown", statusRecorded: false };
		}

		const channelType = channel.type as NotificationChannelType;
		let outcome: NotificationTestResult;
		try {
			let config: Record<string, unknown>;
			try {
				const decryptedJson = this.encryptor.decrypt({
					value: channel.encryptedConfig,
					iv: channel.configIv,
				});
				config = validateStoredNotificationConfig(channelType, JSON.parse(decryptedJson));
			} catch {
				throw new NotificationFailureError("configuration");
			}
			await this.dispatcher.test(channelType, config);
			outcome = { success: true, statusRecorded: false };
		} catch (error: unknown) {
			const category = notificationFailureCategorySchema.safeParse(
				error instanceof NotificationFailureError ? error.category : undefined,
			);
			outcome = {
				success: false,
				failureCategory: category.success ? category.data : "unknown",
				statusRecorded: false,
			};
		}

		// Record only against the exact owned connection that was tested. A later
		// settings edit may win while the provider Test is still in flight.
		try {
			const recorded = await this.prisma.notificationChannel.updateMany({
				where: {
					id: channel.id,
					userId: channel.userId,
					type: channel.type,
					encryptedConfig: channel.encryptedConfig,
					configIv: channel.configIv,
				},
				data: { lastTestedAt: new Date(), lastTestResult: outcome.success ? "success" : "failed" },
			});
			return { ...outcome, statusRecorded: recorded.count === 1 };
		} catch {
			// A database failure cannot undo a confirmed provider Test. Never log
			// exception text, which may include connection settings or credentials.
			this.logger.debug(
				{ operation: "notification-test-status-write", status: "failed" },
				"Failed to update notification test result in database",
			);
			return outcome;
		}
	}

	/**
	 * Decrypt a channel's config for reading (e.g., editing form pre-fill).
	 * Returns full channel metadata + redacted config so the frontend edit form can pre-populate.
	 * Secret fields are replaced with a placeholder to prevent credential exposure.
	 */
	async getDecryptedConfig(
		channelId: string,
		userId: string,
	): Promise<{
		id: string;
		name: string;
		type: string;
		enabled: boolean;
		config: Record<string, unknown>;
		configRevision: string;
		lastTestedAt: Date | null;
		lastTestResult: string | null;
		lastSentAt: Date | null;
		lastSendResult: string | null;
	}> {
		const channel = await this.prisma.notificationChannel.findFirst({
			where: { id: channelId, userId },
		});

		if (!channel) {
			throw new Error("Channel not found");
		}

		const decryptedJson = this.encryptor.decrypt({
			value: channel.encryptedConfig,
			iv: channel.configIv,
		});
		let config: Record<string, unknown>;
		try {
			config = JSON.parse(decryptedJson) as Record<string, unknown>;
		} catch {
			throw new NotificationFailureError("configuration");
		}

		// Retained markers are resolved only against this owned channel on update.
		const redacted = redactNotificationConfig(channel.type as NotificationChannelType, config);

		return {
			id: channel.id,
			name: channel.name,
			type: channel.type,
			enabled: channel.enabled,
			config: redacted,
			configRevision: channelConfigRevision(channel),
			lastTestedAt: channel.lastTestedAt,
			lastTestResult: channel.lastTestResult,
			lastSentAt: channel.lastSentAt,
			lastSendResult: channel.lastSendResult,
		};
	}

	/**
	 * Return available channel types with form metadata for dynamic UI rendering.
	 */
	getChannelTypes(): Array<{
		type: string;
		label: string;
		icon: string;
		formFields: ChannelFormField[];
	}> {
		return this.dispatcher.getPluginManifests();
	}

	// ── Rule & Aggregation Helpers ─────────────────────────────────────

	private async loadRules(userId: string): Promise<NotificationRule[]> {
		const dbRules = await this.prisma.notificationRule.findMany({
			where: { userId, enabled: true },
			orderBy: { priority: "asc" },
		});
		const rules: NotificationRule[] = [];
		for (const r of dbRules) {
			try {
				rules.push({
					id: r.id,
					enabled: r.enabled,
					priority: r.priority,
					action: r.action as "suppress" | "throttle" | "route" | "quiet_hours",
					conditions: JSON.parse(r.conditions),
					targetChannelIds: r.targetChannelIds ? JSON.parse(r.targetChannelIds) : null,
					throttleMinutes: r.throttleMinutes,
					quietHoursStart: r.quietHoursStart,
					quietHoursEnd: r.quietHoursEnd,
					quietHoursTimezone: r.quietHoursTimezone,
				});
			} catch {
				this.logger.error(
					{ ruleId: r.id, operation: "rule-configuration-read", status: "failed" },
					"Skipping notification rule with corrupted JSON",
				);
			}
		}
		return rules;
	}

	private async loadAggregationConfigs(userId: string): Promise<AggregationConfig[]> {
		const configs = await this.prisma.notificationAggregationConfig.findMany({
			where: { userId, enabled: true },
		});
		return configs.map((c) => ({
			eventType: c.eventType,
			windowSeconds: c.windowSeconds,
			maxBatchSize: c.maxBatchSize,
		}));
	}

	private async getLastSentTime(eventType: string, userId: string): Promise<Date | null> {
		const userChannelIds = (
			await this.prisma.notificationChannel.findMany({
				where: { userId },
				select: { id: true },
			})
		).map((ch) => ch.id);

		if (userChannelIds.length === 0) return null;

		const lastLog = await this.prisma.notificationLog.findFirst({
			where: {
				channelId: { in: userChannelIds },
				eventType,
				status: "sent",
			},
			orderBy: { sentAt: "desc" },
			select: { sentAt: true },
		});

		return lastLog?.sentAt ?? null;
	}

	/**
	 * Log a notification delivery attempt to the database.
	 * Public so that RetryHandler can call it for retry/dead-letter logging.
	 */
	async logDelivery(
		channelId: string,
		channelType: NotificationChannelType,
		payload: NotificationPayload,
		status: "sent" | "failed" | "dead_letter",
		error?: string,
		retryCount?: number,
		attemptContext?: DeliveryAttemptContext,
	): Promise<void> {
		return withCleanupOperationGuard(() =>
			this.logDeliveryGuarded(
				channelId,
				channelType,
				payload,
				status,
				error,
				retryCount,
				attemptContext,
			),
		);
	}

	private async logDeliveryGuarded(
		channelId: string,
		channelType: NotificationChannelType,
		payload: NotificationPayload,
		status: "sent" | "failed" | "dead_letter",
		error?: string,
		retryCount?: number,
		attemptContext?: DeliveryAttemptContext,
	): Promise<void> {
		if (!isDeliveryAttemptContext(attemptContext, channelId, channelType)) return;
		const results = await Promise.allSettled([
			this.prisma.$transaction(async (tx) => {
				// An UPDATE obtains the same row lock used by owner changes/deletion.
				// Hold it through history insertion, even when settings have rotated.
				const owned = await tx.notificationChannel.updateMany({
					where: { id: channelId, userId: attemptContext.userId },
					data: { id: channelId },
				});
				if (owned.count !== 1) return;
				await tx.notificationLog.create({
					data: {
						channelId,
						channelType,
						eventType: payload.eventType,
						title: payload.title,
						body: payload.body,
						status,
						error: status === "sent" ? null : safeNotificationFailureMessage(error),
						retryCount: retryCount ?? 0,
					},
				});
			}),
			// Update denormalized last-send status on the channel for quick lookups
			this.prisma.notificationChannel.updateMany({
				where: {
					id: attemptContext.id,
					userId: attemptContext.userId,
					type: attemptContext.type,
					encryptedConfig: attemptContext.encryptedConfig,
					configIv: attemptContext.configIv,
				},
				data: {
					lastSentAt: new Date(),
					lastSendResult: status === "sent" ? "success" : "failed",
				},
			}),
		]);
		// A rejected log must not release its parent's lifetime while the status write is active.
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
	}
}

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns absolute URLs unchanged; resolves relative paths against baseUrl.
 */
function resolveUrl(url: string, baseUrl: string): string {
	if (/^https?:\/\//i.test(url)) return url;
	if (url.startsWith("/")) return `${baseUrl}${url}`;
	return `${baseUrl}/${url}`;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}
