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
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createLabelSyncRule,
	deleteLabelSyncRule,
	fetchLabelSyncRules,
	runLabelSyncRule,
	updateLabelSyncRule,
} from "../../lib/api-client/label-sync";
import { labelSyncKeys } from "../../lib/query-keys";
import { POLLING_ACTIVE } from "../../lib/polling-intervals";

export const useLabelSyncRules = () => {
	return useQuery<LabelSyncRule[]>({
		queryKey: labelSyncKeys.rules,
		queryFn: fetchLabelSyncRules,
		staleTime: POLLING_ACTIVE,
		refetchInterval: POLLING_ACTIVE,
		retry: false,
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

const labelSyncRunKey = [...labelSyncKeys.all, "run"] as const;

export const useRunLabelSyncRule = (onRunError: (error: Error) => Promise<void>) => {
	const queryClient = useQueryClient();
	const isRunPending = useIsMutating({ mutationKey: labelSyncRunKey, exact: true }) > 0;
	const mutation = useMutation({
		mutationKey: labelSyncRunKey,
		mutationFn: (id: string) => runLabelSyncRule(id),
		onError: onRunError,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.rules });
		},
	});
	return { ...mutation, isRunPending };
};
