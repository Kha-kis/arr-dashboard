import type { EmailConfig } from "@arr/shared";
import nodemailer from "nodemailer";
import type { ChannelPlugin, ChannelSender, NotificationPayload, SendResult } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

/** Connection errors that are worth retrying */
const RETRYABLE_CODES = new Set([
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ESOCKET",
	"ECONNRESET",
]);

/** Pooled transporter cache keyed by host:port:user */
const transportPool = new Map<string, nodemailer.Transporter>();

function getOrCreateTransporter(config: EmailConfig): nodemailer.Transporter {
	const key = `${config.host}:${config.port}:${config.user}`;
	let transporter = transportPool.get(key);
	if (!transporter) {
		transporter = nodemailer.createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			auth: {
				user: config.user,
				pass: config.password,
			},
			pool: true,
			maxConnections: 3,
			connectionTimeout: 10000,
			greetingTimeout: 10000,
			socketTimeout: 10000,
		});
		transportPool.set(key, transporter);
	}
	return transporter;
}

/** Close all pooled transports (for graceful shutdown). */
export function closeAllTransports(): void {
	for (const [, transport] of transportPool) {
		transport.close();
	}
	transportPool.clear();
}

export const emailSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const emailConfig = config as EmailConfig;

		try {
			const transporter = getOrCreateTransporter(emailConfig);

			let html = `<h2>${escapeHtml(payload.title)}</h2><p>${escapeHtml(payload.body)}</p>`;

			const fields = extractMetadataFields(payload.metadata);
			if (fields.length > 0) {
				html += '<table style="border-collapse:collapse;margin:12px 0">';
				for (const field of fields) {
					html += `<tr><td style="padding:3px 12px 3px 0;font-weight:bold;color:#888">${escapeHtml(field.label)}</td><td style="padding:3px 0">${escapeHtml(field.value)}</td></tr>`;
				}
				html += "</table>";
			}

			if (payload.url) {
				html += `<p><a href="${escapeHtml(payload.url)}">View Details</a></p>`;
			}
			html += `<hr><p style="color:#888;font-size:12px">Arr Dashboard &bull; ${payload.eventType}</p>`;

			let text = `${payload.title}\n\n${payload.body}`;
			if (fields.length > 0) {
				text += "\n";
				for (const field of fields) {
					text += `\n${field.label}: ${field.value}`;
				}
			}
			if (payload.url) {
				text += `\n\n${payload.url}`;
			}

			await transporter.sendMail({
				from: emailConfig.from,
				to: emailConfig.to,
				subject: payload.title,
				html,
				text,
			});

			return { success: true, retryable: false };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const code = (err as { code?: string }).code;
			const retryable = code ? RETRYABLE_CODES.has(code) : false;
			return { success: false, retryable, error: `Email send failed: ${error}` };
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const emailConfig = config as EmailConfig;
		const transporter = getOrCreateTransporter(emailConfig);

		await transporter.sendMail({
			from: emailConfig.from,
			to: emailConfig.to,
			subject: "Arr Dashboard - Test Notification",
			html: "<h2>Test Notification</h2><p>Arr Dashboard email notification channel is working!</p>",
			text: "Test Notification\n\nArr Dashboard email notification channel is working!",
		});
	},
};

export const emailPlugin: ChannelPlugin = {
	type: "EMAIL",
	label: "Email (SMTP)",
	icon: "Mail",
	configSchema: "emailConfigSchema",
	formFields: [
		{ key: "host", label: "SMTP Host", type: "text", required: true },
		{ key: "port", label: "SMTP Port", type: "number", required: true },
		{ key: "secure", label: "Use TLS", type: "boolean" },
		{ key: "user", label: "Username", type: "text", required: true },
		{ key: "password", label: "Password", type: "password", required: true },
		{ key: "from", label: "From Address", type: "email", required: true },
		{ key: "to", label: "To Address", type: "email", required: true },
	],
	sender: emailSender,
};

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
