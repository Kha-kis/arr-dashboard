/**
 * Label Sync API Client
 *
 * Wrappers for /api/label-sync/rules CRUD + run endpoints introduced
 * in the generalized Label Sync arc (issue #384).
 */

import type {
	CreateLabelSyncRuleRequest,
	LabelSyncRule,
	LabelSyncRuleResponse,
	LabelSyncRulesResponse,
	UpdateLabelSyncRuleRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

export async function fetchLabelSyncRules(): Promise<LabelSyncRule[]> {
	const data = await apiRequest<LabelSyncRulesResponse>("/api/label-sync/rules");
	return data.rules;
}

export async function createLabelSyncRule(
	payload: CreateLabelSyncRuleRequest,
): Promise<LabelSyncRule> {
	const data = await apiRequest<LabelSyncRuleResponse>("/api/label-sync/rules", {
		method: "POST",
		json: payload,
	});
	return data.rule;
}

export async function updateLabelSyncRule(
	id: string,
	payload: UpdateLabelSyncRuleRequest,
): Promise<LabelSyncRule> {
	const data = await apiRequest<LabelSyncRuleResponse>(`/api/label-sync/rules/${id}`, {
		method: "PATCH",
		json: payload,
	});
	return data.rule;
}

export async function deleteLabelSyncRule(id: string): Promise<void> {
	await apiRequest<void>(`/api/label-sync/rules/${id}`, { method: "DELETE" });
}

export async function runLabelSyncRule(id: string): Promise<LabelSyncRule> {
	const data = await apiRequest<LabelSyncRuleResponse>(`/api/label-sync/rules/${id}/run`, {
		method: "POST",
	});
	return data.rule;
}
