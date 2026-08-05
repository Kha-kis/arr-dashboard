import type {
	CleanupApprovalResponse,
	CleanupAuditEventResponse,
	CleanupConfigResponse,
	CleanupExplainResponse,
	CleanupFieldOptionsResponse,
	CleanupLogResponse,
	CleanupPreviewResponse,
	CleanupRuleResponse,
	CleanupStatisticsResponse,
	CleanupStatusResponse,
	CreateCleanupRule,
	PaginatedCleanupAuditTimelines,
	UpdateCleanupConfig,
	UpdateCleanupRule,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Types
// ============================================================================

export interface PaginatedApprovals {
	items: CleanupApprovalResponse[];
	total: number;
	page: number;
	pageSize: number;
}

export interface PaginatedLogs {
	items: CleanupLogResponse[];
	total: number;
	page: number;
	pageSize: number;
}

export interface CleanupAuditEventPage {
	items: CleanupAuditEventResponse[];
	olderEventsCursor: string | null;
}

export interface ExecuteResult {
	isDryRun: boolean;
	status: string;
	itemsEvaluated: number;
	itemsFlagged: number;
	itemsRemoved: number;
	itemsUnmonitored: number;
	itemsFilesDeleted: number;
	itemsSkipped: number;
	durationMs: number;
}

export interface ApprovalExecuteResult {
	removed: number;
	reconciled?: number;
	failed: number;
	errors: string[];
	warnings?: string[];
}

// ============================================================================
// API Client
// ============================================================================

export const libraryCleanupApi = {
	// Field options (distinct values from library cache)
	async getFieldOptions(): Promise<CleanupFieldOptionsResponse> {
		return apiRequest<CleanupFieldOptionsResponse>("/api/library-cleanup/field-options");
	},

	// Config
	async getConfig(): Promise<CleanupConfigResponse> {
		return apiRequest<CleanupConfigResponse>("/api/library-cleanup/config");
	},

	async updateConfig(data: UpdateCleanupConfig): Promise<CleanupConfigResponse> {
		return apiRequest<CleanupConfigResponse>("/api/library-cleanup/config", {
			method: "PUT",
			json: data,
		});
	},

	// Rules
	async createRule(data: CreateCleanupRule): Promise<CleanupRuleResponse> {
		return apiRequest<CleanupRuleResponse>("/api/library-cleanup/rules", {
			method: "POST",
			json: data,
		});
	},

	async updateRule(id: string, data: UpdateCleanupRule): Promise<CleanupRuleResponse> {
		return apiRequest<CleanupRuleResponse>(`/api/library-cleanup/rules/${id}`, {
			method: "PUT",
			json: data,
		});
	},

	async deleteRule(id: string): Promise<void> {
		await apiRequest(`/api/library-cleanup/rules/${id}`, { method: "DELETE" });
	},

	async reorderRules(ruleIds: string[]): Promise<CleanupConfigResponse> {
		return apiRequest<CleanupConfigResponse>("/api/library-cleanup/rules/reorder", {
			method: "PUT",
			json: { ruleIds },
		});
	},

	// Preview & Execute
	async preview(): Promise<CleanupPreviewResponse> {
		return apiRequest<CleanupPreviewResponse>("/api/library-cleanup/preview", {
			method: "POST",
		});
	},

	async execute(): Promise<ExecuteResult> {
		return apiRequest<ExecuteResult>("/api/library-cleanup/execute", {
			method: "POST",
		});
	},

	// Approval Queue
	async getApprovalQueue(page = 1, pageSize = 20, status = "pending"): Promise<PaginatedApprovals> {
		return apiRequest<PaginatedApprovals>(
			`/api/library-cleanup/approval-queue?page=${page}&pageSize=${pageSize}&status=${status}`,
		);
	},

	async approveItem(id: string): Promise<ApprovalExecuteResult> {
		return apiRequest<ApprovalExecuteResult>(`/api/library-cleanup/approval-queue/${id}/approve`, {
			method: "POST",
		});
	},

	async retryItem(id: string): Promise<ApprovalExecuteResult> {
		return apiRequest<ApprovalExecuteResult>(`/api/library-cleanup/approval-queue/${id}/retry`, {
			method: "POST",
		});
	},

	async rejectItem(id: string): Promise<void> {
		await apiRequest(`/api/library-cleanup/approval-queue/${id}/reject`, {
			method: "POST",
		});
	},

	async bulkAction(
		ids: string[],
		action: "approved" | "rejected",
	): Promise<ApprovalExecuteResult | { updated: number }> {
		return apiRequest(`/api/library-cleanup/approval-queue/bulk`, {
			method: "POST",
			json: { ids, action },
		});
	},

	// Logs
	async getActivity(page = 1, pageSize = 20): Promise<PaginatedCleanupAuditTimelines> {
		return apiRequest<PaginatedCleanupAuditTimelines>(
			`/api/library-cleanup/activity?page=${page}&pageSize=${pageSize}`,
		);
	},

	async getActivityEvents(
		actionId: string,
		cursor: string,
		pageSize = 200,
	): Promise<CleanupAuditEventPage> {
		const params = new URLSearchParams({ cursor, pageSize: String(pageSize) });
		return apiRequest<CleanupAuditEventPage>(
			`/api/library-cleanup/activity/${encodeURIComponent(actionId)}/events?${params.toString()}`,
		);
	},

	async getLogs(
		page = 1,
		pageSize = 20,
		filters?: { status?: string; since?: string; until?: string },
	): Promise<PaginatedLogs> {
		const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
		if (filters?.status) params.set("status", filters.status);
		if (filters?.since) params.set("since", filters.since);
		if (filters?.until) params.set("until", filters.until);
		return apiRequest<PaginatedLogs>(`/api/library-cleanup/logs?${params.toString()}`);
	},

	// Health Status
	async getStatus(): Promise<CleanupStatusResponse> {
		return apiRequest<CleanupStatusResponse>("/api/library-cleanup/status");
	},

	// Explain
	async explain(
		instanceId: string,
		arrItemId: number,
		arrEpisodeId?: number,
	): Promise<CleanupExplainResponse> {
		return apiRequest<CleanupExplainResponse>("/api/library-cleanup/explain", {
			method: "POST",
			json: { instanceId, arrItemId, arrEpisodeId },
		});
	},

	// Statistics
	async getStatistics(days = 30): Promise<CleanupStatisticsResponse> {
		return apiRequest<CleanupStatisticsResponse>(`/api/library-cleanup/statistics?days=${days}`);
	},
};
