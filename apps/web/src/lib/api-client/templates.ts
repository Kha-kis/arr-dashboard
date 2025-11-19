import type {
	TrashTemplate,
	CreateTemplateRequest,
	UpdateTemplateRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

// ============================================================================
// Response Types
// ============================================================================

export interface TemplateListResponse {
	templates: TrashTemplate[];
	count: number;
}

export interface TemplateResponse {
	template: TrashTemplate;
	message?: string;
}

export interface TemplateInstanceInfo {
	instanceId: string;
	instanceName: string;
	instanceType: "RADARR" | "SONARR";
	lastAppliedAt?: string;
	hasActiveSchedule: boolean;
}

export interface TemplateStatsResponse {
	stats: {
		templateId: string;
		usageCount: number;
		lastUsedAt?: string;
		instances: TemplateInstanceInfo[];
		formatCount: number;
		groupCount: number;
		isActive: boolean;
		activeInstanceCount: number;
	};
}

export interface DeleteTemplateResponse {
	message: string;
	templateId: string;
}

// ============================================================================
// API Client Functions
// ============================================================================

/**
 * List all templates with optional filtering, searching, and sorting
 */
export async function fetchTemplates(params?: {
	serviceType?: "RADARR" | "SONARR";
	includeDeleted?: boolean;
	active?: boolean;
	search?: string;
	sortBy?: "name" | "createdAt" | "updatedAt" | "usageCount";
	sortOrder?: "asc" | "desc";
	limit?: number;
	offset?: number;
}): Promise<TemplateListResponse> {
	const queryParams = new URLSearchParams();

	if (params?.serviceType) {
		queryParams.append("serviceType", params.serviceType);
	}
	if (params?.includeDeleted) {
		queryParams.append("includeDeleted", "true");
	}
	if (params?.active !== undefined) {
		queryParams.append("active", params.active.toString());
	}
	if (params?.search) {
		queryParams.append("search", params.search);
	}
	if (params?.sortBy) {
		queryParams.append("sortBy", params.sortBy);
	}
	if (params?.sortOrder) {
		queryParams.append("sortOrder", params.sortOrder);
	}
	if (params?.limit) {
		queryParams.append("limit", params.limit.toString());
	}
	if (params?.offset) {
		queryParams.append("offset", params.offset.toString());
	}

	const url = `/api/trash-guides/templates${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;
	return await apiRequest<TemplateListResponse>(url);
}

/**
 * Get template by ID
 */
export async function fetchTemplate(templateId: string): Promise<TemplateResponse> {
	return await apiRequest<TemplateResponse>(`/api/trash-guides/templates/${templateId}`);
}

/**
 * Create a new template
 */
export async function createTemplate(
	payload: CreateTemplateRequest,
): Promise<TemplateResponse> {
	return await apiRequest<TemplateResponse>("/api/trash-guides/templates", {
		method: "POST",
		json: payload,
	});
}

/**
 * Update existing template
 */
export async function updateTemplate(
	templateId: string,
	payload: UpdateTemplateRequest,
): Promise<TemplateResponse> {
	return await apiRequest<TemplateResponse>(`/api/trash-guides/templates/${templateId}`, {
		method: "PUT",
		json: payload,
	});
}

/**
 * Delete template
 */
export async function deleteTemplate(templateId: string): Promise<DeleteTemplateResponse> {
	return await apiRequest<DeleteTemplateResponse>(`/api/trash-guides/templates/${templateId}`, {
		method: "DELETE",
	});
}

/**
 * Duplicate template
 */
export async function duplicateTemplate(
	templateId: string,
	newName: string,
): Promise<TemplateResponse> {
	return await apiRequest<TemplateResponse>(`/api/trash-guides/templates/${templateId}/duplicate`, {
		method: "POST",
		json: { newName },
	});
}

/**
 * Export template as JSON
 */
export async function exportTemplate(templateId: string): Promise<string> {
	const response = await fetch(`/api/trash-guides/templates/${templateId}/export`, {
		method: "GET",
		credentials: "include",
	});

	if (!response.ok) {
		throw new Error(`Export failed: ${response.statusText}`);
	}

	return await response.text();
}

/**
 * Import template from JSON
 */
export async function importTemplate(jsonData: string): Promise<TemplateResponse> {
	return await apiRequest<TemplateResponse>("/api/trash-guides/templates/import", {
		method: "POST",
		json: { jsonData },
	});
}

/**
 * Get template usage statistics
 */
export async function fetchTemplateStats(templateId: string): Promise<TemplateStatsResponse> {
	return await apiRequest<TemplateStatsResponse>(`/api/trash-guides/templates/${templateId}/stats`);
}
