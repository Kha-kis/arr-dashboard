import type { NotificationChannelType } from "@arr/shared";
import { discordPlugin } from "./channels/discord-sender.js";
import { emailPlugin } from "./channels/email-sender.js";
import { gotifyPlugin } from "./channels/gotify-sender.js";
import { ntfyPlugin } from "./channels/ntfy-sender.js";
import { pushbulletPlugin } from "./channels/pushbullet-sender.js";
import { pushoverPlugin } from "./channels/pushover-sender.js";
import { slackPlugin } from "./channels/slack-sender.js";
import { telegramPlugin } from "./channels/telegram-sender.js";
import { webhookPlugin } from "./channels/webhook-sender.js";
import type {
	ChannelFormField,
	ChannelPlugin,
	ChannelSender,
	NotificationPayload,
	SendResult,
} from "./types.js";

/** All registered channel plugins (except BROWSER_PUSH which is lazy-loaded) */
const ALL_PLUGINS: ChannelPlugin[] = [
	discordPlugin,
	telegramPlugin,
	emailPlugin,
	pushbulletPlugin,
	pushoverPlugin,
	gotifyPlugin,
	webhookPlugin,
	slackPlugin,
	ntfyPlugin,
];

/**
 * Maps channel types to their sender implementations.
 * Browser Push is handled separately since it requires VAPID key initialization.
 */
export class NotificationDispatcher {
	private senders: Map<NotificationChannelType, ChannelSender>;

	constructor() {
		this.senders = new Map<NotificationChannelType, ChannelSender>();
		for (const plugin of ALL_PLUGINS) {
			this.senders.set(plugin.type as NotificationChannelType, plugin.sender);
		}
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
	): Promise<SendResult> {
		const sender = this.senders.get(type);
		if (!sender) {
			return {
				success: false,
				retryable: false,
				error: `No sender registered for channel type: ${type}`,
			};
		}
		return sender.send(config, payload);
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

	/**
	 * Return plugin metadata for all registered channel types.
	 * Used by the API route to tell the frontend what channel types are available.
	 */
	getPluginManifests(): Array<{
		type: string;
		label: string;
		icon: string;
		formFields: ChannelFormField[];
	}> {
		const manifests: Array<{
			type: string;
			label: string;
			icon: string;
			formFields: ChannelFormField[];
		}> = [];
		for (const plugin of ALL_PLUGINS) {
			manifests.push({
				type: plugin.type,
				label: plugin.label,
				icon: plugin.icon,
				formFields: plugin.formFields,
			});
		}
		// Add any dynamically registered senders (like BROWSER_PUSH)
		for (const [type] of this.senders) {
			if (!manifests.some((m) => m.type === type)) {
				manifests.push({
					type,
					label: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
					icon: "Bell",
					formFields: [],
				});
			}
		}
		return manifests;
	}
}
