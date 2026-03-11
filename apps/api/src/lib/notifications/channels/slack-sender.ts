/**
 * Slack channel sender.
 *
 * Sends notifications via Slack incoming webhooks using Block Kit format.
 */

import type { SlackConfig } from "@arr/shared";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";

const SLACK_TIMEOUT_MS = 10000;
const SLACK_MAX_TEXT = 3000;

/** Map event type prefixes to Slack attachment colors */
function getSlackColor(eventType: string): string {
	if (eventType.includes("FAILED") || eventType.includes("ERROR") || eventType.includes("LOCKED"))
		return "#e74c3c";
	if (
		eventType.includes("COMPLETED") ||
		eventType.includes("FOUND") ||
		eventType.includes("STARTUP")
	)
		return "#2ecc71";
	if (
		eventType.includes("REMOVED") ||
		eventType.includes("FLAGGED") ||
		eventType.includes("STRIKES")
	)
		return "#f39c12";
	return "#3498db";
}

function buildSlackPayload(payload: NotificationPayload): Record<string, unknown> {
	const blocks: Record<string, unknown>[] = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: payload.title.slice(0, 150),
				emoji: true,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: payload.body.slice(0, SLACK_MAX_TEXT),
			},
		},
	];

	// Add metadata fields
	if (payload.metadata && Object.keys(payload.metadata).length > 0) {
		const fields: Record<string, unknown>[] = [];
		for (const [key, value] of Object.entries(payload.metadata)) {
			if (fields.length >= 10) break;
			fields.push({
				type: "mrkdwn",
				text: `*${key}:* ${String(value).slice(0, 100)}`,
			});
		}
		if (fields.length > 0) {
			blocks.push({ type: "section", fields });
		}
	}

	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `${payload.eventType} \u00b7 ${new Date().toISOString()}`,
			},
		],
	});

	return {
		blocks,
		attachments: [
			{
				color: getSlackColor(payload.eventType),
				blocks: [],
			},
		],
	};
}

export const slackSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { webhookUrl } = config as SlackConfig;

		try {
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildSlackPayload(payload)),
				signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
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

			const errorText = await response.text().catch(() => response.statusText);
			return { success: false, retryable: false, error: `HTTP ${response.status}: ${errorText}` };
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
		const result = await slackSender.send(config, {
			eventType: "SYSTEM_STARTUP" as any,
			title: "Test Notification",
			body: "This is a test notification from Arr Dashboard.",
		});
		if (!result.success) {
			throw new Error(result.error ?? "Slack test failed");
		}
	},
};

export const slackPlugin: ChannelPlugin = {
	type: "SLACK",
	label: "Slack",
	icon: "Hash",
	configSchema: "slackConfigSchema",
	formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	sender: slackSender,
};
