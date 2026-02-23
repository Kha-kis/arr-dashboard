import type { PushoverConfig } from "@arr/shared";
import type { ChannelSender, NotificationPayload } from "../types.js";

const PUSHOVER_API = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 10000;

export const pushoverSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
		const { userKey, apiToken } = config as PushoverConfig;

		const body: Record<string, string | number> = {
			token: apiToken,
			user: userKey,
			title: payload.title,
			message: payload.body,
			priority: getPriority(payload.eventType),
			html: 1,
		};
		if (payload.url) {
			body.url = payload.url;
			body.url_title = "View Details";
		}

		const response = await fetch(PUSHOVER_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Pushover API failed: ${response.status} ${text}`);
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { userKey, apiToken } = config as PushoverConfig;

		const response = await fetch(PUSHOVER_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: apiToken,
				user: userKey,
				title: "Test Notification",
				message: "Arr Dashboard notification channel is working!",
				priority: -1,
			}),
			signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Pushover test failed: ${response.status} ${text}`);
		}
	},
};

/** Map event types to Pushover priorities (-2 to 2) */
function getPriority(eventType: string): number {
	if (eventType.includes("ERROR") || eventType.includes("FAILED")) return 1; // High
	if (eventType.includes("STARTUP")) return -1; // Low
	return 0; // Normal
}
