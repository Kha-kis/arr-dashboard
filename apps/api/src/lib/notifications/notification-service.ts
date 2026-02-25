import type { NotificationChannelType } from "@arr/shared";

const REDACTED_PLACEHOLDER = "••••••••";
const SECRET_FIELD_NAMES = new Set(["password", "botToken", "apiToken", "appToken", "userKey", "auth"]);

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
import { getErrorMessage } from "../utils/error-message.js";
import type { NotificationDispatcher } from "./notification-dispatcher.js";
import type { NotificationLogger, NotificationPayload } from "./types.js";

/**
 * Orchestrator for the notification system.
 * Resolves subscribed channels for an event → decrypts configs → dispatches → logs results.
 */
export class NotificationService {
	private prisma: PrismaClient;
	private encryptor: Encryptor;
	private dispatcher: NotificationDispatcher;
	private logger: NotificationLogger;

	constructor(
		prisma: PrismaClient,
		encryptor: Encryptor,
		dispatcher: NotificationDispatcher,
		logger: NotificationLogger,
	) {
		this.prisma = prisma;
		this.encryptor = encryptor;
		this.dispatcher = dispatcher;
		this.logger = logger;
	}

	/**
	 * Send a notification to all channels subscribed to the given event type.
	 * Failures on individual channels are logged but do not throw.
	 */
	async notify(payload: NotificationPayload): Promise<void> {
		const subscriptions = await this.prisma.notificationSubscription.findMany({
			where: { eventType: payload.eventType },
			include: {
				channel: true,
			},
		});

		// Filter to enabled channels only
		const enabledSubs = subscriptions.filter((sub) => sub.channel.enabled);

		if (enabledSubs.length === 0) {
			this.logger.debug(
				{ eventType: payload.eventType },
				"No channels subscribed to event, skipping notification",
			);
			return;
		}

		this.logger.info(
			{ eventType: payload.eventType, channelCount: enabledSubs.length },
			"Dispatching notification to subscribed channels",
		);

		const results = await Promise.allSettled(
			enabledSubs.map(async (sub) => {
				const channelType = sub.channel.type as NotificationChannelType;

				if (!this.dispatcher.hasSender(channelType)) {
					throw new Error(`No sender for channel type: ${channelType}`);
				}

				// Decrypt channel config
				const decryptedJson = this.encryptor.decrypt({
					value: sub.channel.encryptedConfig,
					iv: sub.channel.configIv,
				});
				let config: Record<string, unknown>;
				try {
					config = JSON.parse(decryptedJson) as Record<string, unknown>;
				} catch {
					throw new Error(`Failed to parse config for channel "${sub.channel.name}" — config may be corrupted`);
				}

				await this.dispatcher.send(channelType, config, payload);
				return { channelId: sub.channelId, channelType };
			}),
		);

		// Log results
		for (let i = 0; i < results.length; i++) {
			const result = results[i]!;
			const sub = enabledSubs[i]!;
			const channelType = sub.channel.type as NotificationChannelType;

			if (result.status === "fulfilled") {
				await this.logDelivery(sub.channelId, channelType, payload, "sent").catch((logErr) => {
					this.logger.warn({ err: logErr, channelId: sub.channelId }, "Failed to log notification delivery");
				});
			} else {
				const errorMsg = getErrorMessage(result.reason);
				this.logger.error(
					{
						channelId: sub.channelId,
						channelType,
						err: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
					},
					`Notification delivery failed for channel ${sub.channel.name}`,
				);
				await this.logDelivery(sub.channelId, channelType, payload, "failed", errorMsg).catch(
					(logErr) => {
						this.logger.warn({ err: logErr, channelId: sub.channelId }, "Failed to log notification delivery");
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
		} catch {
			throw new Error(`Failed to parse config for channel "${channel.name}" — config may be corrupted. Try re-saving the channel settings.`);
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
			throw new Error(`Failed to parse config for channel "${channel.name}" — config may be corrupted. Try re-saving the channel settings.`);
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
		};
	}

	private async logDelivery(
		channelId: string,
		channelType: NotificationChannelType,
		payload: NotificationPayload,
		status: "sent" | "failed",
		error?: string,
	): Promise<void> {
		await this.prisma.notificationLog.create({
			data: {
				channelId,
				channelType,
				eventType: payload.eventType,
				title: payload.title,
				body: payload.body,
				status,
				error: error ?? null,
			},
		});
	}
}
