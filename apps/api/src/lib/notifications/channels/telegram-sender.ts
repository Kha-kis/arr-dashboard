import type { TelegramConfig } from "@arr/shared";
import type { ChannelSender, NotificationPayload } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

export const telegramSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
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

		await sendMessage(botToken, chatId, text);
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const { botToken, chatId } = config as TelegramConfig;
		await sendMessage(
			botToken,
			chatId,
			"<b>Test Notification</b>\n\nArr Dashboard notification channel is working!",
		);
	},
};

async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
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

	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		const desc = (body as { description?: string }).description ?? response.statusText;
		throw new Error(`Telegram API failed: ${response.status} ${desc}`);
	}
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
