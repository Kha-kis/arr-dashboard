import type { AutomationRulesResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { fetchAutomationRules } from "../../lib/api-client/automation";
import { automationKeys } from "../../lib/query-keys";

/**
 * Every domain's automation rules, normalized to v1 (charter §5.1).
 * Powers the Operator Console Automation tab's read-only viewer.
 */
export const useAutomationRules = () =>
	useQuery<AutomationRulesResponse>({
		queryKey: automationKeys.rules(),
		queryFn: fetchAutomationRules,
	});
