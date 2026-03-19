import type {
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

// ============================================================================
// Query Keys
// ============================================================================

const KEYS = {
	fieldOptions: ["library-cleanup-field-options"] as const,
	config: ["library-cleanup-config"] as const,
	status: ["library-cleanup-status"] as const,
	statistics: (days: number) => ["library-cleanup-statistics", days] as const,
	approvalQueue: (page: number, status?: string) =>
		["library-cleanup-approvals", page, status] as const,
	logs: (page: number, filters?: Record<string, string>) =>
		["library-cleanup-logs", page, filters] as const,
};

// ============================================================================
// Queries
// ============================================================================

export function useCleanupFieldOptions() {
	return useQuery({
		queryKey: KEYS.fieldOptions,
		queryFn: () => libraryCleanupApi.getFieldOptions(),
		staleTime: 5 * 60 * 1000, // 5 min — field options change infrequently
	});
}

export function useCleanupConfig() {
	return useQuery({
		queryKey: KEYS.config,
		queryFn: () => libraryCleanupApi.getConfig(),
	});
}

export function useCleanupStatus() {
	return useQuery({
		queryKey: KEYS.status,
		queryFn: () => libraryCleanupApi.getStatus(),
		refetchInterval: 60 * 1000, // 1 minute
	});
}

export function useCleanupStatistics(days = 30) {
	return useQuery({
		queryKey: KEYS.statistics(days),
		queryFn: () => libraryCleanupApi.getStatistics(days),
		staleTime: 5 * 60 * 1000, // 5 min — stats don't change rapidly
	});
}

export function useCleanupApprovalQueue(page = 1, pageSize = 20, statusFilter = "pending") {
	return useQuery({
		queryKey: KEYS.approvalQueue(page, statusFilter),
		queryFn: () => libraryCleanupApi.getApprovalQueue(page, pageSize, statusFilter),
	});
}

export function useCleanupLogs(
	page = 1,
	pageSize = 20,
	filters?: { status?: string; since?: string; until?: string },
) {
	return useQuery({
		queryKey: KEYS.logs(page, filters as Record<string, string> | undefined),
		queryFn: () => libraryCleanupApi.getLogs(page, pageSize, filters),
	});
}

export function useCleanupExplain() {
	return useMutation({
		mutationFn: ({
			instanceId,
			arrItemId,
		}: {
			instanceId: string;
			arrItemId: number;
		}): Promise<CleanupExplainResponse> => libraryCleanupApi.explain(instanceId, arrItemId),
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
			queryClient.invalidateQueries({ queryKey: KEYS.config });
			queryClient.invalidateQueries({ queryKey: KEYS.status });
		},
	});
}

export function useCreateCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateCleanupRule) => libraryCleanupApi.createRule(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.config });
		},
	});
}

export function useUpdateCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateCleanupRule }) =>
			libraryCleanupApi.updateRule(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.config });
		},
	});
}

export function useDeleteCleanupRule() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => libraryCleanupApi.deleteRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.config });
		},
	});
}

export function useReorderCleanupRules() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ruleIds: string[]) => libraryCleanupApi.reorderRules(ruleIds),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: KEYS.config });
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
			queryClient.invalidateQueries({ queryKey: KEYS.config });
			queryClient.invalidateQueries({ queryKey: KEYS.status });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-logs"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-approvals"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-statistics"] });
		},
	});
}

export function useApproveCleanupItem() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string): Promise<ApprovalExecuteResult> => libraryCleanupApi.approveItem(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-approvals"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-logs"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-statistics"] });
		},
	});
}

export function useRejectCleanupItem() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => libraryCleanupApi.rejectItem(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-approvals"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-logs"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-statistics"] });
		},
	});
}

export function useBulkCleanupAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ ids, action }: { ids: string[]; action: "approved" | "rejected" }) =>
			libraryCleanupApi.bulkAction(ids, action),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-approvals"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-logs"] });
			queryClient.invalidateQueries({ queryKey: ["library-cleanup-statistics"] });
		},
	});
}
