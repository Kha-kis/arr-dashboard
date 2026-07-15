import type { AutomationRulesResponse, CrossDomainRuleDraft } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createCrossDomainRule,
	deactivateCrossDomainRule,
	deleteCrossDomainRule,
	deployCrossDomainRule,
	dryRunCrossDomainRule,
	fetchAutomationRules,
	fetchCrossDomainRules,
	updateCrossDomainRule,
} from "../../lib/api-client/automation";
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

export const useCrossDomainRules = () =>
	useQuery({
		queryKey: automationKeys.crossDomainRules(),
		queryFn: fetchCrossDomainRules,
	});

const useInvalidateAutomation = () => {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: automationKeys.all });
};

export const useCreateCrossDomainRule = () => {
	const invalidate = useInvalidateAutomation();
	return useMutation({ mutationFn: createCrossDomainRule, onSuccess: invalidate });
};

export const useUpdateCrossDomainRule = () => {
	const invalidate = useInvalidateAutomation();
	return useMutation({
		mutationFn: ({ id, draft }: { id: string; draft: CrossDomainRuleDraft }) =>
			updateCrossDomainRule(id, draft),
		onSuccess: invalidate,
	});
};

export const useDryRunCrossDomainRule = () => useMutation({ mutationFn: dryRunCrossDomainRule });

export const useDeployCrossDomainRule = () => {
	const invalidate = useInvalidateAutomation();
	return useMutation({ mutationFn: deployCrossDomainRule, onSuccess: invalidate });
};

export const useDeactivateCrossDomainRule = () => {
	const invalidate = useInvalidateAutomation();
	return useMutation({ mutationFn: deactivateCrossDomainRule, onSuccess: invalidate });
};

export const useDeleteCrossDomainRule = () => {
	const invalidate = useInvalidateAutomation();
	return useMutation({ mutationFn: deleteCrossDomainRule, onSuccess: invalidate });
};
