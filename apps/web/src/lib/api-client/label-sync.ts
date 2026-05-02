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

export interface RunLabelSyncForItemRequest {
	instanceId: string;
	arrItemId: number;
	itemType: "movie" | "series" | "artist" | "author";
}

export interface RunLabelSyncForItemResponse {
	rulesFired: number;
	labelsApplied: number;
	failures: number;
	outcomes: Array<{
		ruleId: string;
		ruleName: string;
		status: "success" | "partial" | "failed";
		message: string;
		labelsApplied: number;
	}>;
}

export async function runLabelSyncForItem(
	payload: RunLabelSyncForItemRequest,
): Promise<RunLabelSyncForItemResponse> {
	return apiRequest<RunLabelSyncForItemResponse>("/api/label-sync/run-for-item", {
		method: "POST",
		json: payload,
	});
}
