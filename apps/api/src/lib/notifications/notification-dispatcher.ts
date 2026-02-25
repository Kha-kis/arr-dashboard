import type { NotificationChannelType } from "@arr/shared";
import { discordSender } from "./channels/discord-sender.js";
import { emailSender } from "./channels/email-sender.js";
import { gotifySender } from "./channels/gotify-sender.js";
import { pushbulletSender } from "./channels/pushbullet-sender.js";
import { pushoverSender } from "./channels/pushover-sender.js";
import { telegramSender } from "./channels/telegram-sender.js";
import type { ChannelSender, NotificationPayload } from "./types.js";

/**
 * Maps channel types to their sender implementations.
 * Browser Push is handled separately since it requires VAPID key initialization.
 */
export class NotificationDispatcher {
	private senders: Map<NotificationChannelType, ChannelSender>;

	constructor() {
		this.senders = new Map<NotificationChannelType, ChannelSender>([
			["DISCORD", discordSender],
			["TELEGRAM", telegramSender],
			["EMAIL", emailSender],
			["PUSHBULLET", pushbulletSender],
			["PUSHOVER", pushoverSender],
			["GOTIFY", gotifySender],
		]);
	}

	/**
	 * Register a sender for a channel type.
	 * Used to lazily register the Browser Push sender after VAPID keys are resolved.
	 */
	registerSender(type: NotificationChannelType, sender: ChannelSender): void {
		this.senders.set(type, sender);
	}

	/**
	 * Send a notification through a specific channel type.
	 */
	async send(
		type: NotificationChannelType,
		config: Record<string, unknown>,
		payload: NotificationPayload,
	): Promise<void> {
		const sender = this.senders.get(type);
		if (!sender) {
			throw new Error(`No sender registered for channel type: ${type}`);
		}
		await sender.send(config, payload);
	}

	/**
	 * Test a channel's connectivity.
	 */
	async test(type: NotificationChannelType, config: Record<string, unknown>): Promise<void> {
		const sender = this.senders.get(type);
		if (!sender) {
			throw new Error(`No sender registered for channel type: ${type}`);
		}
		await sender.test(config);
	}

	hasSender(type: NotificationChannelType): boolean {
		return this.senders.has(type);
	}
}
