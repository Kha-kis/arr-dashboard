import type {
	AutomationRulesResponse,
	CrossDomainDryRunResponse,
	CrossDomainRuleDraft,
	CrossDomainRuleResponse,
	CrossDomainRulesResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Fetch every domain's automation rules, normalized to the v1 grammar
 * (charter §5.1). Read surface for the Operator Console composer.
 */
export async function fetchAutomationRules(): Promise<AutomationRulesResponse> {
	return apiRequest<AutomationRulesResponse>("/api/automation/rules");
}

export const fetchCrossDomainRules = () =>
	apiRequest<CrossDomainRulesResponse>("/api/automation/cross-domain-rules");

export const createCrossDomainRule = (draft: CrossDomainRuleDraft) =>
	apiRequest<CrossDomainRuleResponse>("/api/automation/cross-domain-rules", { json: draft });

export const updateCrossDomainRule = (id: string, draft: CrossDomainRuleDraft) =>
	apiRequest<CrossDomainRuleResponse>(`/api/automation/cross-domain-rules/${id}`, {
		method: "PATCH",
		json: draft,
	});

export const dryRunCrossDomainRule = (id: string) =>
	apiRequest<CrossDomainDryRunResponse>(`/api/automation/cross-domain-rules/${id}/dry-run`, {
		method: "POST",
	});

export const deployCrossDomainRule = (id: string) =>
	apiRequest<CrossDomainRuleResponse>(`/api/automation/cross-domain-rules/${id}/deploy`, {
		method: "POST",
	});

export const deactivateCrossDomainRule = (id: string) =>
	apiRequest<CrossDomainRuleResponse>(`/api/automation/cross-domain-rules/${id}/deactivate`, {
		method: "POST",
	});

export const deleteCrossDomainRule = (id: string) =>
	apiRequest<void>(`/api/automation/cross-domain-rules/${id}`, { method: "DELETE" });
