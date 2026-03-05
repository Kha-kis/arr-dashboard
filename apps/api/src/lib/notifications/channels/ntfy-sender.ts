/**
 * ntfy.sh channel sender.
 *
 * Sends notifications via ntfy.sh HTTP API using headers for metadata.
 */

import type { NtfyConfig } from "@arr/shared";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";

const NTFY_TIMEOUT_MS = 10000;

/** Map event types to ntfy priority levels (1-5) */
function getNtfyPriority(eventType: string): string {
	if (eventType.includes("FAILED") || eventType.includes("ERROR") || eventType.includes("LOCKED")) return "4"; // high
	if (eventType.includes("COMPLETED") || eventType.includes("STARTUP")) return "3"; // default
	if (eventType.includes("REMOVED") || eventType.includes("FLAGGED")) return "3";
	return "3"; // default
}

/** Map event types to ntfy tags (emoji shortcodes) */
function getNtfyTags(eventType: string): string {
	if (eventType.includes("FAILED") || eventType.includes("ERROR")) return "warning";
	if (eventType.includes("COMPLETED") || eventType.includes("FOUND")) return "white_check_mark";
	if (eventType.includes("LOCKED") || eventType.includes("LOGIN")) return "lock";
	if (eventType.includes("BACKUP")) return "floppy_disk";
	if (eventType.includes("HUNT")) return "mag";
	return "bell";
}

export const ntfySender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { serverUrl, topic, token } = config as NtfyConfig;

		const url = `${serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;

		const headers: Record<string, string> = {
			"X-Title": payload.title.slice(0, 250),
			"X-Priority": getNtfyPriority(payload.eventType),
			"X-Tags": getNtfyTags(payload.eventType),
		};

		if (payload.url) {
			headers["X-Click"] = payload.url;
		}

		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: payload.body.slice(0, 4096),
				signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
			});

			if (response.ok) {
				return { success: true, retryable: false };
			}

			if (response.status === 429) {
				return { success: false, retryable: true, error: "Rate limited (429)" };
			}

			if (response.status >= 500) {
				return { success: false, retryable: true, error: `Server error (${response.status})` };
			}

			return { success: false, retryable: false, error: `HTTP ${response.status}: ${response.statusText}` };
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") {
				return { success: false, retryable: true, error: "Request timed out" };
			}
			return { success: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const result = await ntfySender.send(config, {
			eventType: "SYSTEM_STARTUP" as any,
			title: "Test Notification",
			body: "This is a test notification from Arr Dashboard.",
		});
		if (!result.success) {
			throw new Error(result.error ?? "ntfy test failed");
		}
	},
};

export const ntfyPlugin: ChannelPlugin = {
	type: "NTFY",
	label: "ntfy.sh",
	icon: "Bell",
	configSchema: "ntfyConfigSchema",
	formFields: [
		{ key: "serverUrl", label: "Server URL", type: "url", required: true, placeholder: "https://ntfy.sh" },
		{ key: "topic", label: "Topic", type: "text", required: true },
		{ key: "token", label: "Access Token", type: "password" },
	],
	sender: ntfySender,
};
