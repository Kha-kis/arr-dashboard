import type { NotificationChannelType } from "@arr/shared";

const REDACTED_PLACEHOLDER = "••••••••";
const SECRET_FIELD_NAMES = new Set([
	"password",
	"botToken",
	"apiToken",
	"appToken",
	"userKey",
	"auth",
	"secret",
	"token",
]);

function redactSecretFields(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(config).map(([key, value]) => [
			key,
			SECRET_FIELD_NAMES.has(key) && typeof value === "string" ? REDACTED_PLACEHOLDER : value,
		]),
	);
}
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import type { AggregationBuffer, AggregationConfig } from "./aggregation-buffer.js";
import type { DedupGate } from "./dedup-gate.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";
import type { RetryHandler } from "./retry-handler.js";
import type { RuleEngine } from "./rule-engine.js";
import type { NotificationRule } from "./rule-engine.js";
import type { ChannelFormField, NotificationLogger, NotificationPayload } from "./types.js";

/**
 * Orchestrator for the notification system.
 * Resolves subscribed channels for an event → dedup → rules → aggregation → decrypts configs → dispatches → retries/logs results.
 */
export class NotificationService {
	private prisma: PrismaClient;
	private encryptor: Encryptor;
	private dispatcher: NotificationDispatcher;
	private logger: NotificationLogger;
	private dedupGate: DedupGate;
	private retryHandler: RetryHandler;
	private ruleEngine: RuleEngine | null;
	private aggregationBuffer: AggregationBuffer | null;

	constructor(
		prisma: PrismaClient,
		encryptor: Encryptor,
		dispatcher: NotificationDispatcher,
		logger: NotificationLogger,
		dedupGate: DedupGate,
		retryHandler: RetryHandler,
		ruleEngine?: RuleEngine,
		aggregationBuffer?: AggregationBuffer,
	) {
		this.prisma = prisma;
		this.encryptor = encryptor;
		this.dispatcher = dispatcher;
		this.logger = logger;
		this.dedupGate = dedupGate;
		this.retryHandler = retryHandler;
		this.ruleEngine = ruleEngine ?? null;
		this.aggregationBuffer = aggregationBuffer ?? null;
	}

	/**
	 * Send a notification to all channels subscribed to the given event type.
	 * Failures on individual channels are logged but do not throw.
	 */
	async notify(payload: NotificationPayload): Promise<void> {
		// Dedup: skip if an identical payload was dispatched within the TTL window
		if (this.dedupGate.isDuplicate(payload)) {
			this.logger.debug({ eventType: payload.eventType }, "Duplicate notification suppressed");
			return;
		}

		const subscriptions = await this.prisma.notificationSubscription.findMany({
			where: { eventType: payload.eventType },
			include: {
				channel: true,
			},
		});

		// Filter to enabled channels only
		let enabledSubs = subscriptions.filter((sub) => sub.channel.enabled);

		if (enabledSubs.length === 0) {
			this.logger.debug(
				{ eventType: payload.eventType },
				"No channels subscribed to event, skipping notification",
			);
			return;
		}

		// Rule engine: evaluate user-defined rules for suppression, throttling, routing
		const userId = enabledSubs[0]?.channel?.userId;
		if (userId && this.ruleEngine) {
			const rules = await this.loadRules(userId);
			const ruleResult = this.ruleEngine.evaluate(payload, rules);
			if (ruleResult) {
				if (ruleResult.action === "suppress") {
					this.logger.info(
						{ eventType: payload.eventType, ruleId: ruleResult.ruleId },
						"Notification suppressed by rule",
					);
					return;
				}
				if (ruleResult.action === "throttle" && ruleResult.throttleMinutes) {
					const lastSent = await this.getLastSentTime(payload.eventType, userId);
					if (lastSent && Date.now() - lastSent.getTime() < ruleResult.throttleMinutes * 60_000) {
						this.logger.debug(
							{ eventType: payload.eventType, ruleId: ruleResult.ruleId },
							"Notification throttled by rule",
						);
						return;
					}
				}
				if (ruleResult.action === "route" && ruleResult.targetChannelIds) {
					const targetSet = new Set(ruleResult.targetChannelIds);
					const routed = enabledSubs.filter((sub) => targetSet.has(sub.channelId));
					if (routed.length > 0) {
						enabledSubs = routed;
					}
				}
			}
		}

		// Aggregation: batch high-frequency notifications into digests
		if (userId && this.aggregationBuffer) {
			const aggConfigs = await this.loadAggregationConfigs(userId);
			const aggConfig = this.aggregationBuffer.hasConfig(payload.eventType, aggConfigs);
			if (aggConfig) {
				this.aggregationBuffer.push(payload, aggConfig);
				this.logger.debug({ eventType: payload.eventType }, "Notification queued for aggregation");
				return;
			}
		}

		this.logger.info(
			{ eventType: payload.eventType, channelCount: enabledSubs.length },
			"Dispatching notification to subscribed channels",
		);

		for (const sub of enabledSubs) {
			const channelType = sub.channel.type as NotificationChannelType;

			if (!this.dispatcher.hasSender(channelType)) {
				this.logger.error(
					{ channelId: sub.channelId, channelType },
					`No sender for channel type: ${channelType}`,
				);
				await this.logDelivery(
					sub.channelId,
					channelType,
					payload,
					"failed",
					`No sender for channel type: ${channelType}`,
				).catch((logErr) => {
					this.logger.warn(
						{ err: logErr, channelId: sub.channelId },
						"Failed to log notification delivery",
					);
				});
				continue;
			}

			// Decrypt channel config
			let config: Record<string, unknown>;
			try {
				const decryptedJson = this.encryptor.decrypt({
					value: sub.channel.encryptedConfig,
					iv: sub.channel.configIv,
				});
				config = JSON.parse(decryptedJson) as Record<string, unknown>;
			} catch (parseErr) {
				const error = `Failed to parse config for channel "${sub.channel.name}" — config may be corrupted: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`;
				this.logger.error({ channelId: sub.channelId, channelType }, error);
				await this.logDelivery(sub.channelId, channelType, payload, "failed", error).catch(
					(logErr) => {
						this.logger.warn(
							{ err: logErr, channelId: sub.channelId },
							"Failed to log notification delivery",
						);
					},
				);
				continue;
			}

			const result = await this.dispatcher.send(channelType, config, payload);

			if (result.success) {
				await this.logDelivery(sub.channelId, channelType, payload, "sent").catch((logErr) => {
					this.logger.warn(
						{ err: logErr, channelId: sub.channelId },
						"Failed to log notification delivery",
					);
				});
			} else if (result.retryable) {
				this.logger.warn(
					{ channelId: sub.channelId, channelType, error: result.error },
					`Notification delivery failed (retryable) for channel ${sub.channel.name}`,
				);
				await this.logDelivery(sub.channelId, channelType, payload, "failed", result.error).catch(
					(logErr) => {
						this.logger.warn(
							{ err: logErr, channelId: sub.channelId },
							"Failed to log notification delivery",
						);
					},
				);
				this.retryHandler.enqueue({
					channelId: sub.channelId,
					channelType,
					config,
					payload,
					retryAfterMs: result.retryAfterMs,
				});
			} else {
				this.logger.error(
					{ channelId: sub.channelId, channelType, error: result.error },
					`Notification delivery failed for channel ${sub.channel.name}`,
				);
				await this.logDelivery(sub.channelId, channelType, payload, "failed", result.error).catch(
					(logErr) => {
						this.logger.warn(
							{ err: logErr, channelId: sub.channelId },
							"Failed to log notification delivery",
						);
					},
				);
			}
		}
	}

	/**
	 * Test a specific channel's connectivity by decrypting its config and calling the test method.
	 */
	async testChannel(channelId: string, userId: string): Promise<void> {
		const channel = await this.prisma.notificationChannel.findFirst({
			where: { id: channelId, userId },
		});

		if (!channel) {
			throw new Error("Channel not found");
		}

		const channelType = channel.type as NotificationChannelType;
		const decryptedJson = this.encryptor.decrypt({
			value: channel.encryptedConfig,
			iv: channel.configIv,
		});
		let config: Record<string, unknown>;
		try {
			config = JSON.parse(decryptedJson) as Record<string, unknown>;
		} catch (parseErr) {
			throw new Error(
				`Failed to parse config for channel "${channel.name}" — config may be corrupted: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Try re-saving the channel settings.`,
			);
		}

		await this.dispatcher.test(channelType, config);

		// Update last tested timestamp
		await this.prisma.notificationChannel.update({
			where: { id: channelId },
			data: {
				lastTestedAt: new Date(),
				lastTestResult: "success",
			},
		});
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
		} catch (parseErr) {
			throw new Error(
				`Failed to parse config for channel "${channel.name}" — config may be corrupted: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Try re-saving the channel settings.`,
			);
		}

		// Redact secret fields — frontend should only send non-placeholder values on update
		const redacted = redactSecretFields(config);

		return {
			id: channel.id,
			name: channel.name,
			type: channel.type,
			enabled: channel.enabled,
			config: redacted,
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
					action: r.action as "suppress" | "throttle" | "route",
					conditions: JSON.parse(r.conditions),
					targetChannelIds: r.targetChannelIds ? JSON.parse(r.targetChannelIds) : null,
					throttleMinutes: r.throttleMinutes,
				});
			} catch (err) {
				this.logger.error({ err, ruleId: r.id }, "Skipping notification rule with corrupted JSON");
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
	): Promise<void> {
		await Promise.all([
			this.prisma.notificationLog.create({
				data: {
					channelId,
					channelType,
					eventType: payload.eventType,
					title: payload.title,
					body: payload.body,
					status,
					error: error ?? null,
					retryCount: retryCount ?? 0,
				},
			}),
			// Update denormalized last-send status on the channel for quick lookups
			this.prisma.notificationChannel.update({
				where: { id: channelId },
				data: {
					lastSentAt: new Date(),
					lastSendResult: status === "sent" ? "success" : (error ?? "unknown error"),
				},
			}),
		]);
	}
}
