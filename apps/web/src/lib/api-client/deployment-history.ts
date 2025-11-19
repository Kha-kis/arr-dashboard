import { apiRequest } from "./base";

// ============================================================================
// Response Types
// ============================================================================

export interface DeploymentHistoryEntry {
	id: string;
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceName: string;
	deployedAt: string;
	deployedBy: string;
	status: "success" | "partial" | "failed";
	appliedCFs: number;
	conflicts?: number;
	errors?: string[];
	warnings?: string[];
	canRollback: boolean;
}

export interface DeploymentHistoryListResponse {
	history: DeploymentHistoryEntry[];
	count: number;
}

export interface ConflictResolution {
	cfTrashId: string;
	cfName: string;
	resolution: "keep_existing" | "use_template";
	existingScore: number;
	templateScore: number;
}

export interface DeploymentDetailsResponse {
	deployment: {
		id: string;
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
		qualityProfileId: number;
		qualityProfileName: string;
		deployedAt: string;
		deployedBy: string;
		status: "success" | "partial" | "failed";
		customFormatsApplied: {
			trash_id: string;
			name: string;
			score: number;
			action: "added" | "updated" | "skipped";
		}[];
		conflictResolutions?: ConflictResolution[];
		preDeploymentState?: any;
		errors?: string[];
		warnings?: string[];
		canRollback: boolean;
		summary: {
			totalCFs: number;
			added: number;
			updated: number;
			skipped: number;
			conflicts: number;
		};
	};
}

export interface RollbackResponse {
	success: boolean;
	rollback: {
		deploymentId: string;
		instanceId: string;
		restoredCFs: number;
		errors?: string[];
		warnings?: string[];
	};
	message: string;
}

// ============================================================================
// API Client Functions
// ============================================================================

/**
 * Get deployment history for a specific template
 */
export async function getDeploymentHistoryByTemplate(
	templateId: string,
	params?: {
		limit?: number;
		offset?: number;
	},
): Promise<DeploymentHistoryListResponse> {
	const queryParams = new URLSearchParams();
	if (params?.limit) {
		queryParams.append("limit", params.limit.toString());
	}
	if (params?.offset) {
		queryParams.append("offset", params.offset.toString());
	}

	const url = `/api/trash-guides/deployment/history/template/${templateId}${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;
	return await apiRequest<DeploymentHistoryListResponse>(url);
}

/**
 * Get deployment history for a specific instance
 */
export async function getDeploymentHistoryByInstance(
	instanceId: string,
	params?: {
		limit?: number;
		offset?: number;
	},
): Promise<DeploymentHistoryListResponse> {
	const queryParams = new URLSearchParams();
	if (params?.limit) {
		queryParams.append("limit", params.limit.toString());
	}
	if (params?.offset) {
		queryParams.append("offset", params.offset.toString());
	}

	const url = `/api/trash-guides/deployment/history/instance/${instanceId}${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;
	return await apiRequest<DeploymentHistoryListResponse>(url);
}

/**
 * Get detailed information about a specific deployment
 */
export async function getDeploymentDetails(historyId: string): Promise<DeploymentDetailsResponse> {
	return await apiRequest<DeploymentDetailsResponse>(
		`/api/trash-guides/deployment/history/${historyId}`,
	);
}

/**
 * Rollback a deployment to its pre-deployment state
 */
export async function rollbackDeployment(historyId: string): Promise<RollbackResponse> {
	return await apiRequest<RollbackResponse>(
		`/api/trash-guides/deployment/history/${historyId}/rollback`,
		{
			method: "POST",
		},
	);
}
