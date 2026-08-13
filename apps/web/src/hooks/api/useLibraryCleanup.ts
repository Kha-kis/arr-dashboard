import type {
	CleanupExplainRequest,
	CleanupExplainResponse,
	CreateCleanupRule,
	UpdateCleanupConfig,
	UpdateCleanupRule,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ApprovalExecuteResult,
	type ExecuteResult,
	libraryCleanupApi,
} from "../../lib/api-client/library-cleanup";
import { POLLING_STANDARD } from "../../lib/polling-intervals";
import { libraryCleanupKeys } from "../../lib/query-keys";

// ============================================================================
// Queries
// ============================================================================

export function useCleanupFieldOptions() {
	return useQuery({
		queryKey: libraryCleanupKeys.fieldOptions,
		queryFn: () => libraryCleanupApi.getFieldOptions(),
		staleTime: 5 * 60 * 1000, // 5 min — field options change infrequently
	});
}

export function useCleanupConfig() {
	return useQuery({
		queryKey: libraryCleanupKeys.config,
		queryFn: () => libraryCleanupApi.getConfig(),
	});
}

export function useCleanupStatus() {
	return useQuery({
		queryKey: libraryCleanupKeys.status,
		queryFn: () => libraryCleanupApi.getStatus(),
		refetchInterval: POLLING_STANDARD,
	});
}

export function useCleanupStatistics(days = 30) {
	return useQuery({
		queryKey: libraryCleanupKeys.statistics(days),
		queryFn: () => libraryCleanupApi.getStatistics(days),
		staleTime: 5 * 60 * 1000, // 5 min — stats don't change rapidly
	});
}

export function useCleanupApprovalQueue(page = 1, pageSize = 20, statusFilter = "pending") {
	return useQuery({
		queryKey: libraryCleanupKeys.approvalQueue(page, statusFilter),
		queryFn: () => libraryCleanupApi.getApprovalQueue(page, pageSize, statusFilter),
	});
}

export function useCleanupLogs(
	page = 1,
	pageSize = 20,
	filters?: { status?: string; since?: string; until?: string },
) {
	return useQuery({
		queryKey: libraryCleanupKeys.logs(page, filters as Record<string, string> | undefined),
		queryFn: () => libraryCleanupApi.getLogs(page, pageSize, filters),
	});
}

export function useCleanupExplain() {
	return useMutation({
		mutationFn: (request: CleanupExplainRequest): Promise<CleanupExplainResponse> =>
			libraryCleanupApi.explain(request),
	});
}

// ============================================================================
// Mutations
// ============================================================================

export function useUpdateCleanupConfig() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: UpdateCleanupConfig) => libraryCleanupApi.updateConfig(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.status });
		},
	});
}

export function useCreateCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateCleanupRule) => libraryCleanupApi.createRule(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
		},
	});
}

export function useUpdateCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateCleanupRule }) =>
			libraryCleanupApi.updateRule(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
		},
	});
}

export function useDeleteCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => libraryCleanupApi.deleteRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
		},
	});
}

export function useReorderCleanupRules() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ruleIds: string[]) => libraryCleanupApi.reorderRules(ruleIds),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
		},
	});
}

export function useCleanupPreview() {
	return useMutation({
		mutationFn: () => libraryCleanupApi.preview(),
	});
}

export function useCleanupExecute() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (): Promise<ExecuteResult> => libraryCleanupApi.execute(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.config });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.status });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.logsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.statisticsAll });
		},
	});
}

export function useApproveCleanupItem() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (id: string): Promise<ApprovalExecuteResult> => {
			const result = await libraryCleanupApi.approveItem(id);
			if (result.failed > 0) {
				throw new Error(result.errors.join("\n") || "The cleanup item could not be executed");
			}
			return result;
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.logsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.statisticsAll });
		},
	});
}

export function useRetryCleanupItem() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (id: string): Promise<ApprovalExecuteResult> => {
			const result = await libraryCleanupApi.retryItem(id);
			if (result.failed > 0) {
				throw new Error(result.errors.join("\n") || "The cleanup retry could not be completed");
			}
			return result;
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.logsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.statisticsAll });
		},
	});
}

export function useRejectCleanupItem() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => libraryCleanupApi.rejectItem(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.logsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.statisticsAll });
		},
	});
}

export function useBulkCleanupAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ ids, action }: { ids: string[]; action: "approved" | "rejected" }) => {
			const result = await libraryCleanupApi.bulkAction(ids, action);
			if ("failed" in result && result.failed > 0) {
				throw new Error(result.errors.join("\n") || "Some cleanup items could not be executed");
			}
			return result;
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.logsAll });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.statisticsAll });
		},
	});
}
