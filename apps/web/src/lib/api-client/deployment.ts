import { apiRequest } from "./base";

// ============================================================================
// Response Types
// ============================================================================

export interface CustomFormatChange {
	trash_id: string;
	name: string;
	action: "ADD" | "UPDATE" | "NO_CHANGE";
	currentScore?: number;
	newScore: number;
	hasConflict: boolean;
	conflictReason?: string;
}

export interface DeploymentPreviewResponse {
	preview: {
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
		qualityProfileId: number;
		qualityProfileName: string;
		changes: CustomFormatChange[];
		summary: {
			totalCFs: number;
			newCFs: number;
			updatedCFs: number;
			unchangedCFs: number;
			conflicts: number;
		};
		estimatedImpact: string;
	};
}

export interface DeploymentExecuteResponse {
	deployment: {
		success: boolean;
		templateId: string;
		instanceId: string;
		appliedCFs: number;
		errors?: string[];
		warnings?: string[];
		deploymentHistoryId?: string;
	};
}

export interface BulkDeploymentResponse {
	deployments: {
		instanceId: string;
		instanceName: string;
		success: boolean;
		appliedCFs?: number;
		errors?: string[];
		warnings?: string[];
		deploymentHistoryId?: string;
	}[];
	summary: {
		total: number;
		successful: number;
		failed: number;
	};
}

// ============================================================================
// API Client Functions
// ============================================================================

/**
 * Generate deployment preview showing what will change
 */
export async function generateDeploymentPreview(
	templateId: string,
	instanceId: string,
): Promise<DeploymentPreviewResponse> {
	return await apiRequest<DeploymentPreviewResponse>("/api/trash-guides/deployment/preview", {
		method: "POST",
		json: { templateId, instanceId },
	});
}

/**
 * Execute deployment to single instance
 */
export async function executeDeployment(
	templateId: string,
	instanceId: string,
	conflictResolution?: Record<string, "keep_existing" | "use_template">,
): Promise<DeploymentExecuteResponse> {
	return await apiRequest<DeploymentExecuteResponse>("/api/trash-guides/deployment/execute", {
		method: "POST",
		json: { templateId, instanceId, conflictResolution },
	});
}

/**
 * Execute bulk deployment to multiple instances
 */
export async function executeBulkDeployment(
	templateId: string,
	instanceIds: string[],
	conflictResolution?: Record<string, "keep_existing" | "use_template">,
): Promise<BulkDeploymentResponse> {
	return await apiRequest<BulkDeploymentResponse>("/api/trash-guides/deployment/execute-bulk", {
		method: "POST",
		json: { templateId, instanceIds, conflictResolution },
	});
}
