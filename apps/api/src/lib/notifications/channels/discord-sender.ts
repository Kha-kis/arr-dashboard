import type { DiscordConfig } from "@arr/shared";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const DISCORD_TIMEOUT_MS = 10000;
/** Discord embed limits */
const DISCORD_MAX_FIELDS = 25;
const DISCORD_MAX_FIELD_VALUE = 1024;
const DISCORD_MAX_EMBED_TOTAL = 5500; // Leave buffer under 6000

export const discordSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { webhookUrl } = config as DiscordConfig;

		const allFields = extractMetadataFields(payload.metadata).map((f) => ({
			name: f.label,
			value: f.value.length > DISCORD_MAX_FIELD_VALUE ? `${f.value.slice(0, DISCORD_MAX_FIELD_VALUE - 3)}...` : f.value,
			inline: f.value.length < 30,
		}));
		// Discord allows max 25 fields per embed
		const fields = allFields.slice(0, DISCORD_MAX_FIELDS);

		const title = payload.title.slice(0, 256);
		const description = payload.body.slice(0, 4096);

		const embed: Record<string, unknown> = {
			title,
			description,
			color: getEventColor(payload.eventType),
			timestamp: new Date().toISOString(),
			...(payload.url ? { url: payload.url } : {}),
			footer: { text: `Arr Dashboard • ${payload.eventType}` },
			...(fields.length > 0 ? { fields } : {}),
		};

		// Guard: if total embed JSON exceeds Discord limit, drop fields
		const embedJson = JSON.stringify(embed);
		if (embedJson.length > DISCORD_MAX_EMBED_TOTAL && fields.length > 0) {
			delete embed.fields;
		}

		try {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeds: [embed] }),
				signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
			});

			if (response.ok) {
				return { success: true, retryable: false };
			}

			const text = await response.text().catch(() => "");
			const error = `Discord webhook failed: ${response.status} ${response.statusText} ${text}`;

			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const retryAfterMs = retryAfter ? Number.parseFloat(retryAfter) * 1000 : undefined;
				return { success: false, retryable: true, retryAfterMs, error };
			}
			if (response.status >= 500) {
				return { success: false, retryable: true, error };
			}
			return { success: false, retryable: false, error };
		} catch (err) {
			// Timeout or network error
			const error = err instanceof Error ? err.message : String(err);
			return { success: false, retryable: true, error: `Discord network error: ${error}` };
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { webhookUrl } = config as DiscordConfig;

		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				embeds: [
					{
						title: "Test Notification",
						description: "Arr Dashboard notification channel is working!",
						color: 0x2563eb,
						timestamp: new Date().toISOString(),
					},
				],
			}),
			signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Discord webhook test failed: ${response.status} ${text}`);
		}
	},
};

export const discordPlugin: ChannelPlugin = {
	type: "DISCORD",
	label: "Discord",
	icon: "Send",
	configSchema: "discordConfigSchema",
	formFields: [
		{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true },
	],
	sender: discordSender,
};

function getEventColor(eventType: string): number {
	if (eventType.includes("ERROR") || eventType.includes("FAILED")) return 0xef4444;
	if (eventType.includes("FOUND") || eventType.includes("COMPLETED")) return 0x22c55e;
	if (eventType.includes("REMOVED") || eventType.includes("CLEANUP")) return 0xf59e0b;
	return 0x3b82f6;
}
