/**
 * Label Sync React Query Hooks
 *
 * CRUD wrappers for the generalized any-to-any label-sync rules (issue #384).
 */

import type {
	CreateLabelSyncRuleRequest,
	LabelSyncRule,
	UpdateLabelSyncRuleRequest,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createLabelSyncRule,
	deleteLabelSyncRule,
	fetchLabelSyncRules,
	runLabelSyncRule,
	updateLabelSyncRule,
} from "../../lib/api-client/label-sync";
import { labelSyncKeys } from "../../lib/query-keys";

export const useLabelSyncRules = () => {
	return useQuery<LabelSyncRule[]>({
		queryKey: labelSyncKeys.rules,
		queryFn: fetchLabelSyncRules,
		staleTime: 30_000,
	});
};

export const useCreateLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: CreateLabelSyncRuleRequest) => createLabelSyncRule(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.rules });
		},
	});
};

export const useUpdateLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, payload }: { id: string; payload: UpdateLabelSyncRuleRequest }) =>
			updateLabelSyncRule(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.rules });
		},
	});
};

export const useDeleteLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deleteLabelSyncRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.rules });
		},
	});
};

export const useRunLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => runLabelSyncRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.rules });
		},
	});
};
