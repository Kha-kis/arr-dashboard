import type { EmailConfig } from "@arr/shared";
import nodemailer from "nodemailer";
import type { ChannelSender, NotificationPayload } from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

export const emailSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
		const emailConfig = config as EmailConfig;
		const transporter = createTransporter(emailConfig);

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
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const emailConfig = config as EmailConfig;
		const transporter = createTransporter(emailConfig);

		await transporter.sendMail({
			from: emailConfig.from,
			to: emailConfig.to,
			subject: "Arr Dashboard - Test Notification",
			html: "<h2>Test Notification</h2><p>Arr Dashboard email notification channel is working!</p>",
			text: "Test Notification\n\nArr Dashboard email notification channel is working!",
		});
	},
};

function createTransporter(config: EmailConfig) {
	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: {
			user: config.user,
			pass: config.password,
		},
		connectionTimeout: 10000,
		greetingTimeout: 10000,
		socketTimeout: 10000,
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
