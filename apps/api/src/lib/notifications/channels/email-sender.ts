import type { EmailConfig } from "@arr/shared";
import nodemailer from "nodemailer";
import type { ChannelSender, NotificationPayload } from "../types.js";

export const emailSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
		const emailConfig = config as EmailConfig;
		const transporter = createTransporter(emailConfig);

		let html = `<h2>${escapeHtml(payload.title)}</h2><p>${escapeHtml(payload.body)}</p>`;
		if (payload.url) {
			html += `<p><a href="${escapeHtml(payload.url)}">View Details</a></p>`;
		}
		html += `<hr><p style="color:#888;font-size:12px">Arr Dashboard &bull; ${payload.eventType}</p>`;

		await transporter.sendMail({
			from: emailConfig.from,
			to: emailConfig.to,
			subject: payload.title,
			html,
			text: `${payload.title}\n\n${payload.body}${payload.url ? `\n\n${payload.url}` : ""}`,
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
