import { createHash } from "node:crypto";
import type { EmailConfig } from "@arr/shared";
import nodemailer, { type Transporter } from "nodemailer";
import { notificationFailure, NotificationFailureError } from "../failure-diagnostics.js";
import type {
	ChannelPlugin,
	ChannelSender,
	NotificationFailureCategory,
	NotificationPayload,
	SendResult,
} from "../types.js";
import { extractMetadataFields } from "./format-metadata.js";

/** Connection errors that are worth retrying */
const RETRYABLE_CODES = new Set([
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ESOCKET",
	"ECONNRESET",
]);

function smtpErrorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	return typeof err.code === "string" ? err.code : undefined;
}

function smtpFailureCategory(err: unknown): NotificationFailureCategory {
	const code = smtpErrorCode(err);
	if (code === "EAUTH") return "authentication";
	if (code === "ETIMEDOUT") return "timeout";
	if (code === "ETLS") return "transport";
	if (
		(code === "EENVELOPE" || code === "EMESSAGE") &&
		typeof err === "object" &&
		err !== null &&
		"responseCode" in err
	) {
		const responseCode = err.responseCode;
		if (
			typeof responseCode === "number" &&
			Number.isInteger(responseCode) &&
			responseCode >= 400 &&
			responseCode <= 599
		) {
			return "rejected";
		}
	}
	return code && RETRYABLE_CODES.has(code) ? "transport" : "unknown";
}

type TransportEntry = {
	transporter: Transporter;
	fingerprint: string;
	active: number;
	retired: boolean;
	closed: boolean;
};

/** Current connection per endpoint; replaced entries drain accepted work before closing. */
const transportPool = new Map<string, TransportEntry>();
const allTransports = new Set<TransportEntry>();

function closeTransport(entry: TransportEntry): void {
	if (entry.closed) return;
	entry.closed = true;
	allTransports.delete(entry);
	entry.transporter.close();
}

function acquireTransport(config: EmailConfig): TransportEntry {
	const key = JSON.stringify([config.host, config.port, config.user]);
	// Do not retain plaintext credentials in an extra cache key or diagnostic.
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([config.host, config.port, config.user, config.password, config.secure]))
		.digest("hex");
	let entry = transportPool.get(key);
	if (!entry || entry.fingerprint !== fingerprint) {
		// Construct before retiring the previous entry: a failed replacement leaves it usable.
		const transporter = nodemailer.createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			disableFileAccess: true,
			disableUrlAccess: true,
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
		const previous = entry;
		entry = { transporter, fingerprint, active: 0, retired: false, closed: false };
		transportPool.set(key, entry);
		allTransports.add(entry);
		if (previous) {
			previous.retired = true;
			if (previous.active === 0) closeTransport(previous);
		}
	}
	entry.active += 1;
	return entry;
}

function releaseTransport(entry: TransportEntry): void {
	entry.active -= 1;
	if (entry.retired && entry.active === 0) closeTransport(entry);
}

/** Close all pooled transports (for graceful shutdown). */
export function closeAllTransports(): void {
	for (const entry of allTransports) {
		closeTransport(entry);
	}
	transportPool.clear();
}

export const emailSender: ChannelSender = {
	async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
		const emailConfig = config as EmailConfig;
		let entry: TransportEntry | undefined;

		try {
			entry = acquireTransport(emailConfig);

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

			await entry.transporter.sendMail({
				from: emailConfig.from,
				to: emailConfig.to,
				subject: payload.title,
				html,
				text,
			});

			return { success: true, retryable: false };
		} catch (err) {
			const code = smtpErrorCode(err);
			const retryable = code ? RETRYABLE_CODES.has(code) : false;
			return notificationFailure(smtpFailureCategory(err), retryable);
		} finally {
			if (entry) releaseTransport(entry);
		}
	},

	async test(config: Record<string, unknown>): Promise<void> {
		const emailConfig = config as EmailConfig;
		let entry: TransportEntry | undefined;
		try {
			entry = acquireTransport(emailConfig);

			await entry.transporter.sendMail({
				from: emailConfig.from,
				to: emailConfig.to,
				subject: "Arr Dashboard - Test Notification",
				html: "<h2>Test Notification</h2><p>Arr Dashboard email notification channel is working!</p>",
				text: "Test Notification\n\nArr Dashboard email notification channel is working!",
			});
		} catch (err) {
			throw new NotificationFailureError(smtpFailureCategory(err));
		} finally {
			if (entry) releaseTransport(entry);
		}
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
