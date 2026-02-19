/**
 * Static registry mapping notification agent IDs to their configurable fields.
 *
 * Keys must match the agent IDs returned by the Seerr API (see KNOWN_NOTIFICATION_AGENTS
 * in apps/api/src/lib/seerr/seerr-client.ts). Agents absent from this map (e.g. webpush)
 * have no user-configurable options.
 */

export type AgentFieldType = "text" | "password" | "number" | "boolean" | "url";

export interface AgentField {
	key: string;
	label: string;
	type: AgentFieldType;
	placeholder?: string;
}

export const AGENT_FIELDS: Record<string, AgentField[]> = {
	discord: [
		{ key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://discord.com/api/webhooks/..." },
		{ key: "botUsername", label: "Bot Username", type: "text", placeholder: "Seerr" },
		{ key: "botAvatarUrl", label: "Bot Avatar URL", type: "url", placeholder: "https://..." },
		{ key: "enableMentions", label: "Enable Mentions", type: "boolean" },
	],
	email: [
		{ key: "emailFrom", label: "Sender Address", type: "text", placeholder: "no-reply@example.com" },
		{ key: "senderName", label: "Sender Name", type: "text", placeholder: "Seerr" },
		{ key: "smtpHost", label: "SMTP Host", type: "text", placeholder: "smtp.example.com" },
		{ key: "smtpPort", label: "SMTP Port", type: "number", placeholder: "587" },
		{ key: "authUser", label: "SMTP Username", type: "text" },
		{ key: "authPass", label: "SMTP Password", type: "password" },
		{ key: "secure", label: "Use SSL/TLS", type: "boolean" },
		{ key: "ignoreTls", label: "Ignore TLS Errors", type: "boolean" },
		{ key: "allowSelfSigned", label: "Allow Self-Signed Certs", type: "boolean" },
	],
	gotify: [
		{ key: "url", label: "Server URL", type: "url", placeholder: "https://gotify.example.com" },
		{ key: "token", label: "App Token", type: "password" },
	],
	lunasea: [
		{ key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://notify.lunasea.app/v1/custom/..." },
	],
	ntfy: [
		{ key: "url", label: "Server URL", type: "url", placeholder: "https://ntfy.sh" },
		{ key: "topic", label: "Topic", type: "text" },
		{ key: "authUser", label: "Username", type: "text" },
		{ key: "authPass", label: "Password", type: "password" },
	],
	pushbullet: [
		{ key: "accessToken", label: "Access Token", type: "password" },
		{ key: "channelTag", label: "Channel Tag", type: "text" },
	],
	pushover: [
		{ key: "accessToken", label: "API Token", type: "password" },
		{ key: "userToken", label: "User Key", type: "password" },
		{ key: "sound", label: "Sound", type: "text", placeholder: "pushover" },
	],
	slack: [
		{ key: "webhookUrl", label: "Webhook URL", type: "url", placeholder: "https://hooks.slack.com/services/..." },
	],
	telegram: [
		{ key: "botAPI", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF..." },
		{ key: "chatId", label: "Chat ID", type: "text", placeholder: "-1001234567890" },
		{ key: "sendSilently", label: "Send Silently", type: "boolean" },
	],
	webhook: [
		{ key: "webhookUrl", label: "Webhook URL", type: "url" },
		{ key: "authHeader", label: "Authorization Header", type: "password" },
		{ key: "jsonPayload", label: "JSON Payload Template", type: "text" },
	],
};
