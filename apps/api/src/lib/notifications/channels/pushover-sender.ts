import type { PushoverConfig } from "@arr/shared";
import {
	httpFailureCategory,
	networkFailureCategory,
	notificationFailure,
	NotificationFailureError,
} from "../failure-diagnostics.js";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const PUSHOVER_API = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 10000;

export const pushoverSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { userKey, apiToken } = config as PushoverConfig;

		let message = payload.body;
		const fields = extractMetadataFields(payload.metadata);
		if (fields.length > 0) {
			message += "\n";
			for (const field of fields) {
				message += `\n<b>${field.label}:</b> ${field.value}`;
			}
		}

		const body: Record<string, string | number> = {
			token: apiToken,
			user: userKey,
			title: payload.title,
			message,
			priority: getPriority(payload.eventType),
			html: 1,
		};
		if (payload.url) {
			body.url = payload.url;
			body.url_title = "View Details";
		}

		try {
			const response = await fetch(PUSHOVER_API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
			});

			if (response.ok) {
				return { success: true, retryable: false };
			}
			await response.body?.cancel().catch(() => {});

			return notificationFailure(
				httpFailureCategory(response.status),
				response.status === 429 || response.status >= 500,
			);
		} catch (err) {
			return notificationFailure(networkFailureCategory(err), true);
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { userKey, apiToken } = config as PushoverConfig;

		try {
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
				await response.body?.cancel().catch(() => {});
				throw new NotificationFailureError(httpFailureCategory(response.status));
			}
		} catch (err) {
			if (err instanceof NotificationFailureError) throw err;
			throw new NotificationFailureError(networkFailureCategory(err));
		}
	},
};

export const pushoverPlugin: ChannelPlugin = {
	type: "PUSHOVER",
	label: "Pushover",
	icon: "Send",
	configSchema: "pushoverConfigSchema",
	formFields: [
		{ key: "userKey", label: "User Key", type: "password", required: true },
		{ key: "apiToken", label: "API Token", type: "password", required: true },
	],
	sender: pushoverSender,
};

/** Map event types to Pushover priorities (-2 to 2) */
function getPriority(eventType: string): number {
	if (eventType.includes("ERROR") || eventType.includes("FAILED")) return 1; // High
	if (eventType.includes("STARTUP")) return -1; // Low
	return 0; // Normal
}
