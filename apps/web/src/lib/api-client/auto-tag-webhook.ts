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

// ─── Programmatic install (issue #422) ──────────────────────────────────

export interface WebhookInstallStatusEntry {
	instanceId: string;
	label: string;
	service: "SONARR" | "RADARR";
	installed: boolean;
	notificationId: number | null;
	error: string | null;
}

export interface WebhookInstallStatusResponse {
	instances: WebhookInstallStatusEntry[];
}

export async function fetchWebhookInstallStatus(): Promise<WebhookInstallStatusResponse> {
	return apiRequest<WebhookInstallStatusResponse>("/api/auto-tag/webhook/install/status");
}

export interface WebhookInstallEvents {
	onDownload?: boolean;
	onUpgrade?: boolean;
	onGrab?: boolean;
}

export interface WebhookInstallRequest {
	secret: string;
	instanceIds: string[];
	events?: WebhookInstallEvents;
}

export interface WebhookInstallResultEntry {
	instanceId: string;
	label: string;
	service: "SONARR" | "RADARR";
	status: "installed" | "updated" | "skipped" | "failed";
	notificationId: number | null;
	error: string | null;
}

export interface WebhookInstallResponse {
	results: WebhookInstallResultEntry[];
	summary: { total: number; installed: number; failed: number };
}

export async function installWebhookOnInstances(
	body: WebhookInstallRequest,
): Promise<WebhookInstallResponse> {
	return apiRequest<WebhookInstallResponse>("/api/auto-tag/webhook/install", {
		method: "POST",
		json: body,
	});
}
