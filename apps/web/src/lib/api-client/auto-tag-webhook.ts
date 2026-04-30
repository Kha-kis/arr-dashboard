/**
 * Auto-Tagger Webhook Config API Client
 *
 * Reads + rotates the per-user webhook secret used by Sonarr/Radarr
 * Connect to authenticate inbound webhooks.
 */

import { apiRequest } from "./base";

export interface WebhookConfig {
	/**
	 * Plaintext secret. Returned ONLY when freshlyGenerated=true (first read
	 * after generation/rotation). Null otherwise — the API never persists the
	 * plaintext, only its SHA-256 hash, so we can't show it again later.
	 */
	secret: string | null;
	configured: boolean;
	freshlyGenerated: boolean;
}

export async function fetchWebhookConfig(): Promise<WebhookConfig> {
	return apiRequest<WebhookConfig>("/api/auto-tag/webhook-config");
}

export async function regenerateWebhookSecret(): Promise<WebhookConfig> {
	return apiRequest<WebhookConfig>("/api/auto-tag/webhook-config/regenerate", {
		method: "POST",
	});
}
