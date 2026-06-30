import type { AutomationRulesResponse } from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Fetch every domain's automation rules, normalized to the v1 grammar
 * (charter §5.1). Read surface for the Operator Console composer.
 */
export async function fetchAutomationRules(): Promise<AutomationRulesResponse> {
	return apiRequest<AutomationRulesResponse>("/api/automation/rules");
}
