/**
 * Webhook channel sender.
 *
 * Sends standardized JSON payloads to user-configured URLs.
 * Supports HMAC-SHA256 signing when a secret is configured.
 */

import { createHmac } from "node:crypto";
import type { WebhookConfig } from "@arr/shared";
import {
	httpFailureCategory,
	networkFailureCategory,
	notificationFailure,
	NotificationFailureError,
} from "../failure-diagnostics.js";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";

const WEBHOOK_TIMEOUT_MS = 10000;

function buildWebhookPayload(payload: NotificationPayload): Record<string, unknown> {
	return {
		version: "1",
		timestamp: new Date().toISOString(),
		event: payload.eventType,
		title: payload.title,
		body: payload.body,
		url: payload.url ?? null,
		metadata: payload.metadata ?? {},
		source: "arr-dashboard",
	};
}

function signPayload(body: string, secret: string): { signature: string; timestamp: string } {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const data = `${timestamp}.${body}`;
	const signature = createHmac("sha256", secret).update(data).digest("hex");
	return { signature: `sha256=${signature}`, timestamp };
}

export const webhookSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { url, method = "POST", headers = {}, secret } = config as WebhookConfig;

		const jsonBody = JSON.stringify(buildWebhookPayload(payload));

		const requestHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": "arr-dashboard/webhook",
			...headers,
		};

		if (secret) {
			const { signature, timestamp } = signPayload(jsonBody, secret);
			requestHeaders["X-Webhook-Signature"] = signature;
			requestHeaders["X-Webhook-Timestamp"] = timestamp;
		}

		try {
			const response = await fetch(url, {
				method,
				headers: requestHeaders,
				body: jsonBody,
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			});

			if (response.ok) {
				return { success: true, retryable: false };
			}
			await response.body?.cancel().catch(() => {});

			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
				return notificationFailure(
					"rate-limited",
					true,
					retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : undefined,
				);
			}
			return notificationFailure(httpFailureCategory(response.status), response.status >= 500);
		} catch (err) {
			return notificationFailure(networkFailureCategory(err), true);
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const result = await webhookSender.send(config, {
			eventType: "SYSTEM_STARTUP",
			title: "Test Notification",
			body: "This is a test notification from Arr Dashboard.",
		});
		if (!result.success) {
			throw new NotificationFailureError(result.failureCategory ?? "unknown");
		}
	},
};

export const webhookPlugin: ChannelPlugin = {
	type: "WEBHOOK",
	label: "Webhook",
	icon: "Globe",
	configSchema: "webhookConfigSchema",
	formFields: [
		{ key: "url", label: "Webhook URL", type: "url", required: true },
		{ key: "method", label: "HTTP Method", type: "text", placeholder: "POST" },
		{ key: "secret", label: "Signing Secret", type: "password" },
		{ key: "headers", label: "Custom Headers", type: "headers" },
	],
	sender: webhookSender,
};
