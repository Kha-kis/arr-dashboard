import type { PushbulletConfig } from "@arr/shared";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const PUSHBULLET_API = "https://api.pushbullet.com/v2/pushes";
const PUSHBULLET_TIMEOUT_MS = 10000;

export const pushbulletSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { apiToken } = config as PushbulletConfig;

		let bodyText = payload.body;
		const fields = extractMetadataFields(payload.metadata);
		if (fields.length > 0) {
			bodyText += "\n";
			for (const field of fields) {
				bodyText += `\n${field.label}: ${field.value}`;
			}
		}

		const body: Record<string, string> = {
			type: payload.url ? "link" : "note",
			title: payload.title,
			body: bodyText,
		};
		if (payload.url) {
			body.url = payload.url;
		}

		try {
			const response = await fetch(PUSHBULLET_API, {
				method: "POST",
				headers: {
					"Access-Token": apiToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(PUSHBULLET_TIMEOUT_MS),
			});

			if (response.ok) {
				return { success: true, retryable: false };
			}

			const text = await response.text().catch(() => "");
			const error = `Pushbullet API failed: ${response.status} ${text}`;

			if (response.status === 429) {
				return { success: false, retryable: true, error };
			}
			if (response.status >= 500) {
				return { success: false, retryable: true, error };
			}
			return { success: false, retryable: false, error };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { success: false, retryable: true, error: `Pushbullet network error: ${error}` };
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { apiToken } = config as PushbulletConfig;

		const response = await fetch(PUSHBULLET_API, {
			method: "POST",
			headers: {
				"Access-Token": apiToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: "note",
				title: "Test Notification",
				body: "Arr Dashboard notification channel is working!",
			}),
			signal: AbortSignal.timeout(PUSHBULLET_TIMEOUT_MS),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Pushbullet test failed: ${response.status} ${text}`);
		}
	},
};

export const pushbulletPlugin: ChannelPlugin = {
	type: "PUSHBULLET",
	label: "Pushbullet",
	icon: "Send",
	configSchema: "pushbulletConfigSchema",
	formFields: [{ key: "apiToken", label: "API Token", type: "password", required: true }],
	sender: pushbulletSender,
};
