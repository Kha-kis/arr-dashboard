/**
 * Plex Label Sync API Client
 *
 * Frontend wrappers for the /api/plex/label-sync/rules CRUD endpoints
 * introduced in PR #386 (Plex Labels arc phase A).
 */

import type {
	CreatePlexLabelSyncRuleRequest,
	PlexLabelSyncRule,
	PlexLabelSyncRuleResponse,
	PlexLabelSyncRulesResponse,
	UpdatePlexLabelSyncRuleRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

export async function fetchPlexLabelSyncRules(): Promise<PlexLabelSyncRule[]> {
	const data = await apiRequest<PlexLabelSyncRulesResponse>("/api/plex/label-sync/rules");
	return data.rules;
}

export async function createPlexLabelSyncRule(
	payload: CreatePlexLabelSyncRuleRequest,
): Promise<PlexLabelSyncRule> {
	const data = await apiRequest<PlexLabelSyncRuleResponse>("/api/plex/label-sync/rules", {
		method: "POST",
		json: payload,
	});
	return data.rule;
}

export async function updatePlexLabelSyncRule(
	id: string,
	payload: UpdatePlexLabelSyncRuleRequest,
): Promise<PlexLabelSyncRule> {
	const data = await apiRequest<PlexLabelSyncRuleResponse>(`/api/plex/label-sync/rules/${id}`, {
		method: "PATCH",
		json: payload,
	});
	return data.rule;
}

export async function deletePlexLabelSyncRule(id: string): Promise<void> {
	await apiRequest<void>(`/api/plex/label-sync/rules/${id}`, { method: "DELETE" });
}
