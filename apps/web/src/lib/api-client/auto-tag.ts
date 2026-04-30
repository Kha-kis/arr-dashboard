/**
 * Auto-Tagger API Client
 *
 * Wrappers for /api/auto-tag/rules CRUD + run endpoints.
 */

import type {
	AutoTagRule,
	AutoTagRuleResponse,
	AutoTagRulesResponse,
	CreateAutoTagRuleRequest,
	UpdateAutoTagRuleRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

export async function fetchAutoTagRules(): Promise<AutoTagRule[]> {
	const data = await apiRequest<AutoTagRulesResponse>("/api/auto-tag/rules");
	return data.rules;
}

export async function createAutoTagRule(payload: CreateAutoTagRuleRequest): Promise<AutoTagRule> {
	const data = await apiRequest<AutoTagRuleResponse>("/api/auto-tag/rules", {
		method: "POST",
		json: payload,
	});
	return data.rule;
}

export async function updateAutoTagRule(
	id: string,
	payload: UpdateAutoTagRuleRequest,
): Promise<AutoTagRule> {
	const data = await apiRequest<AutoTagRuleResponse>(`/api/auto-tag/rules/${id}`, {
		method: "PATCH",
		json: payload,
	});
	return data.rule;
}

export async function deleteAutoTagRule(id: string): Promise<void> {
	await apiRequest<void>(`/api/auto-tag/rules/${id}`, { method: "DELETE" });
}

export async function runAutoTagRule(id: string): Promise<AutoTagRule> {
	const data = await apiRequest<AutoTagRuleResponse>(`/api/auto-tag/rules/${id}/run`, {
		method: "POST",
	});
	return data.rule;
}
