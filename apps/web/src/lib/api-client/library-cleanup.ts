import type {
	CleanupApprovalResponse,
	CleanupConfigResponse,
	CleanupFieldOptionsResponse,
	CleanupLogResponse,
	CleanupPreviewResponse,
	CleanupRuleResponse,
	CreateCleanupRule,
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

export interface ExecuteResult {
	isDryRun: boolean;
	status: string;
	itemsEvaluated: number;
	itemsFlagged: number;
	itemsRemoved: number;
	itemsSkipped: number;
	durationMs: number;
}

export interface ApprovalExecuteResult {
	removed: number;
	failed: number;
	errors: string[];
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
	async getLogs(page = 1, pageSize = 20): Promise<PaginatedLogs> {
		return apiRequest<PaginatedLogs>(`/api/library-cleanup/logs?page=${page}&pageSize=${pageSize}`);
	},
};
