/**
 * Auto-Tagger React Query Hooks
 */

import type { AutoTagRule, CreateAutoTagRuleRequest, UpdateAutoTagRuleRequest } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createAutoTagRule,
	deleteAutoTagRule,
	fetchAutoTagRules,
	runAutoTagRule,
	updateAutoTagRule,
} from "../../lib/api-client/auto-tag";
import { autoTagKeys } from "../../lib/query-keys";

export const useAutoTagRules = () => {
	return useQuery<AutoTagRule[]>({
		queryKey: autoTagKeys.rules,
		queryFn: fetchAutoTagRules,
		staleTime: 30_000,
	});
};

export const useCreateAutoTagRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: CreateAutoTagRuleRequest) => createAutoTagRule(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: autoTagKeys.rules });
		},
	});
};

export const useUpdateAutoTagRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, payload }: { id: string; payload: UpdateAutoTagRuleRequest }) =>
			updateAutoTagRule(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: autoTagKeys.rules });
		},
	});
};

export const useDeleteAutoTagRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deleteAutoTagRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: autoTagKeys.rules });
		},
	});
};

export const useRunAutoTagRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => runAutoTagRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: autoTagKeys.rules });
		},
	});
};
