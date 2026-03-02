import type { DiscordConfig } from "@arr/shared";
import type { ChannelSender, NotificationPayload } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const DISCORD_TIMEOUT_MS = 10000;
/** Discord embed limits */
const DISCORD_MAX_FIELDS = 25;
const DISCORD_MAX_FIELD_VALUE = 1024;
const DISCORD_MAX_EMBED_TOTAL = 5500; // Leave buffer under 6000

export const discordSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
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
