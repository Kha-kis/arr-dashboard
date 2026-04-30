/**
 * Auto-Tagger Webhook Config API Client
 *
 * Reads + rotates the per-user webhook secret used by Sonarr/Radarr
 * Connect to authenticate inbound webhooks.
 */

import { apiRequest } from "./base";

export interface WebhookConfig {
	secret: string;
}

export async function fetchWebhookConfig(): Promise<WebhookConfig> {
	return apiRequest<WebhookConfig>("/api/auto-tag/webhook-config");
}

export async function regenerateWebhookSecret(): Promise<WebhookConfig> {
	return apiRequest<WebhookConfig>("/api/auto-tag/webhook-config/regenerate", {
		method: "POST",
	});
}
