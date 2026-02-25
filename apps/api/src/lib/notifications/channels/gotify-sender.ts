import type { GotifyConfig } from "@arr/shared";
import type { ChannelSender, NotificationPayload } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const GOTIFY_TIMEOUT_MS = 10000;

export const gotifySender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
		const { serverUrl, appToken } = config as GotifyConfig;

		let message = payload.body;

		const fields = extractMetadataFields(payload.metadata);
		if (fields.length > 0) {
			message += "\n";
			for (const field of fields) {
				message += `\n**${field.label}:** ${field.value}`;
			}
		}

		if (payload.url) {
			message += `\n\n[View Details](${payload.url})`;
		}

		const extras: Record<string, unknown> = {
			"client::display": { contentType: "text/markdown" },
		};
		if (payload.url) {
			extras["client::notification"] = { click: { url: payload.url } };
		}

		const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/message`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Gotify-Key": appToken,
			},
			body: JSON.stringify({
				title: payload.title,
				message,
				priority: getPriority(payload.eventType),
				extras,
			}),
			signal: AbortSignal.timeout(GOTIFY_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Gotify API failed: ${response.status} ${text}`);
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { serverUrl, appToken } = config as GotifyConfig;

		const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/message`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Gotify-Key": appToken,
			},
			body: JSON.stringify({
				title: "Test Notification",
				message: "Arr Dashboard notification channel is working!",
				priority: 4,
			}),
			signal: AbortSignal.timeout(GOTIFY_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Gotify test failed: ${response.status} ${text}`);
		}
	},
};

/** Map event types to Gotify priorities (0-10) */
function getPriority(eventType: string): number {
	if (eventType.includes("ERROR") || eventType.includes("FAILED")) return 8; // High
	if (eventType.includes("FOUND") || eventType.includes("REMOVED")) return 5; // Normal
	if (eventType.includes("STARTUP")) return 2; // Low
	return 4; // Default
}
