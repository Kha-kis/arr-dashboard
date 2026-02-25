import type { DiscordConfig } from "@arr/shared";
import type { ChannelSender, NotificationPayload } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const DISCORD_TIMEOUT_MS = 10000;

export const discordSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
		const { webhookUrl } = config as DiscordConfig;

		const fields = extractMetadataFields(payload.metadata).map((f) => ({
			name: f.label,
			value: f.value,
			inline: f.value.length < 30,
		}));

		const embed: Record<string, unknown> = {
			title: payload.title,
			description: payload.body,
			color: getEventColor(payload.eventType),
			timestamp: new Date().toISOString(),
			...(payload.url ? { url: payload.url } : {}),
			footer: { text: `Arr Dashboard • ${payload.eventType}` },
			...(fields.length > 0 ? { fields } : {}),
		};

		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ embeds: [embed] }),
			signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${text}`);
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

function getEventColor(eventType: string): number {
	if (eventType.includes("ERROR") || eventType.includes("FAILED")) return 0xef4444;
	if (eventType.includes("FOUND") || eventType.includes("COMPLETED")) return 0x22c55e;
	if (eventType.includes("REMOVED") || eventType.includes("CLEANUP")) return 0xf59e0b;
	return 0x3b82f6;
}
