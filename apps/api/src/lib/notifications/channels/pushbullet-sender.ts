import type { PushbulletConfig } from "@arr/shared";
import {
	httpFailureCategory,
	networkFailureCategory,
	notificationFailure,
	NotificationFailureError,
} from "../failure-diagnostics.js";
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
		const { apiToken } = config as PushbulletConfig;

		try {
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
				await response.body?.cancel().catch(() => {});
				throw new NotificationFailureError(httpFailureCategory(response.status));
			}
		} catch (err) {
			if (err instanceof NotificationFailureError) throw err;
			throw new NotificationFailureError(networkFailureCategory(err));
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
