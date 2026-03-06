/**
 * Webhook channel sender.
 *
 * Sends standardized JSON payloads to user-configured URLs.
 * Supports HMAC-SHA256 signing when a secret is configured.
 */

import { createHmac } from "node:crypto";
import type { WebhookConfig } from "@arr/shared";
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

			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
				return {
					success: false,
					retryable: true,
					retryAfterMs: retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : undefined,
					error: "Rate limited (429)",
				};
			}

			if (response.status >= 500) {
				return { success: false, retryable: true, error: `Server error (${response.status})` };
			}

			return { success: false, retryable: false, error: `HTTP ${response.status}: ${response.statusText}` };
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") {
				return { success: false, retryable: true, error: "Request timed out" };
			}
			return {
				success: false,
				retryable: true,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const result = await webhookSender.send(config, {
			eventType: "SYSTEM_STARTUP" as any,
			title: "Test Notification",
			body: "This is a test notification from Arr Dashboard.",
		});
		if (!result.success) {
			throw new Error(result.error ?? "Webhook test failed");
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
	],
	sender: webhookSender,
};
