import type { TelegramConfig } from "@arr/shared";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;
/** Telegram sendMessage limit is 4096 chars */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000; // Buffer for HTML entity expansion

export const telegramSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const { botToken, chatId } = config as TelegramConfig;

		let text = `<b>${escapeHtml(payload.title)}</b>\n\n${escapeHtml(payload.body)}`;

		const fields = extractMetadataFields(payload.metadata);
		if (fields.length > 0) {
			text += "\n";
			for (const field of fields) {
				text += `\n<b>${escapeHtml(field.label)}:</b> ${escapeHtml(field.value)}`;
			}
		}

		if (payload.url) {
			text += `\n\n<a href="${escapeHtml(payload.url)}">View Details</a>`;
		}

		// Truncate if exceeds Telegram's message limit
		if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
			text = `${text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 20)}\n\n<i>(truncated)</i>`;
		}

		return sendMessage(botToken, chatId, text);
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { botToken, chatId } = config as TelegramConfig;
		const result = await sendMessage(
			botToken,
			chatId,
			"<b>Test Notification</b>\n\nArr Dashboard notification channel is working!",
		);
		if (!result.success) {
			throw new Error(result.error ?? "Telegram test failed");
		}
	},
};

export const telegramPlugin: ChannelPlugin = {
	type: "TELEGRAM",
	label: "Telegram",
	icon: "Send",
	configSchema: "telegramConfigSchema",
	formFields: [
		{ key: "botToken", label: "Bot Token", type: "password", required: true },
		{ key: "chatId", label: "Chat ID", type: "text", required: true },
	],
	sender: telegramSender,
};

async function sendMessage(botToken: string, chatId: string, text: string): Promise<SendResult> {
	try {
		const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
			}),
			signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
		});

		if (response.ok) {
			return { success: true, retryable: false };
		}

		const body = (await response.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
		const desc = body.description ?? response.statusText;
		const error = `Telegram API failed: ${response.status} ${desc}`;

		if (response.status === 429) {
			const retryAfterMs = body.parameters?.retry_after ? body.parameters.retry_after * 1000 : undefined;
			return { success: false, retryable: true, retryAfterMs, error };
		}
		if (response.status >= 500) {
			return { success: false, retryable: true, error };
		}
		return { success: false, retryable: false, error };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { success: false, retryable: true, error: `Telegram network error: ${error}` };
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
