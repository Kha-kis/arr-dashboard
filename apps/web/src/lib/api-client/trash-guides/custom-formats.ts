/**
 * Custom Formats API Client
 * Functions for browsing and deploying individual TRaSH Guides custom formats
 */

import { apiRequest } from "../base";

// ============================================================================
// Types
// ============================================================================

export interface CustomFormat {
	trash_id: string;
	name: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate: boolean;
		required: boolean;
		fields: Record<string, any>;
	}>;
}

export interface CFDescription {
	cfName: string;
	displayName: string;
	description: string;
	rawMarkdown: string;
	fetchedAt: string;
}

export interface CustomFormatsListResponse {
	radarr?: CustomFormat[];
	sonarr?: CustomFormat[];
}

export interface CFDescriptionsListResponse {
	radarr?: CFDescription[];
	sonarr?: CFDescription[];
}

export interface CFInclude {
	path: string;
	content: string;
	fetchedAt: string;
}

export interface CFIncludesListResponse {
	data: CFInclude[];
}

export interface DeployCustomFormatRequest {
	trashId: string;
	instanceId: string;
	serviceType: "RADARR" | "SONARR";
}

export interface DeployMultipleCustomFormatsRequest {
	trashIds: string[];
	instanceId: string;
	serviceType: "RADARR" | "SONARR";
}

export interface DeployCustomFormatResponse {
	success: boolean;
	action: "created" | "updated";
	customFormat: any;
}

export interface DeployMultipleCustomFormatsResponse {
	success: boolean;
	created: string[];
	updated: string[];
	failed: Array<{ name: string; error: string }>;
}

// ============================================================================
// User Custom Formats
// ============================================================================

export interface UserCustomFormat {
	id: string;
	name: string;
	serviceType: "RADARR" | "SONARR";
	description: string | null;
	includeCustomFormatWhenRenaming: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate: boolean;
		required: boolean;
		fields: Record<string, any>;
	}>;
	defaultScore: number;
	sourceInstanceId: string | null;
	sourceCFId: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface UserCustomFormatsResponse {
	success: boolean;
	customFormats: UserCustomFormat[];
	count: number;
}

export interface UserCFImportResponse {
	success: boolean;
	created: string[];
	skipped: string[];
	failed: Array<{ name: string; error: string }>;
}

export interface CreateUserCFRequest {
	name: string;
	serviceType: "RADARR" | "SONARR";
	description?: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate?: boolean;
		required?: boolean;
		fields?: Record<string, any>;
	}>;
	defaultScore?: number;
}

export interface ImportUserCFFromJsonRequest {
	serviceType: "RADARR" | "SONARR";
	customFormats: Array<{
		name: string;
		includeCustomFormatWhenRenaming?: boolean;
		specifications?: Array<{
			name: string;
			implementation: string;
			negate?: boolean;
			required?: boolean;
			fields?: Record<string, any> | Array<{ name: string; value: any }>;
		}>;
	}>;
	defaultScore?: number;
}

export interface ImportUserCFFromInstanceRequest {
	instanceId: string;
	cfIds: number[];
	defaultScore?: number;
}

export interface DeployUserCFsRequest {
	userCFIds: string[];
	instanceId: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch all available custom formats from TRaSH Guides cache
 */
export async function fetchCustomFormatsList(
	serviceType?: "RADARR" | "SONARR"
): Promise<CustomFormatsListResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<CustomFormatsListResponse>(`/api/trash-guides/cache/custom-formats/list${params}`);
}

/**
 * Fetch all CF descriptions from TRaSH Guides cache
 */
export async function fetchCFDescriptionsList(
	serviceType?: "RADARR" | "SONARR"
): Promise<CFDescriptionsListResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<CFDescriptionsListResponse>(`/api/trash-guides/cache/cf-descriptions/list${params}`);
}

/**
 * Fetch all CF include files from TRaSH Guides cache.
 * These are MkDocs snippets referenced by CF descriptions using --8<-- syntax.
 */
export async function fetchCFIncludesList(): Promise<CFInclude[]> {
	const response = await apiRequest<CFIncludesListResponse>(`/api/trash-guides/cache/cf-includes/list`);
	return response.data || [];
}

/**
 * Deploy a single custom format to an instance
 */
export async function deployCustomFormat(
	request: DeployCustomFormatRequest
): Promise<DeployCustomFormatResponse> {
	return await apiRequest<DeployCustomFormatResponse>("/api/trash-guides/custom-formats/deploy", {
		method: "POST",
		json: request,
	});
}

/**
 * Deploy multiple custom formats to an instance
 */
export async function deployMultipleCustomFormats(
	request: DeployMultipleCustomFormatsRequest
): Promise<DeployMultipleCustomFormatsResponse> {
	return await apiRequest<DeployMultipleCustomFormatsResponse>("/api/trash-guides/custom-formats/deploy-multiple", {
		method: "POST",
		json: request,
	});
}

/**
 * Fetch user custom formats
 */
export async function fetchUserCustomFormats(
	serviceType?: "RADARR" | "SONARR"
): Promise<UserCustomFormatsResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<UserCustomFormatsResponse>(`/api/trash-guides/user-custom-formats${params}`);
}

/**
 * Create a user custom format
 */
export async function createUserCustomFormat(
	request: CreateUserCFRequest
): Promise<{ success: boolean; customFormat: UserCustomFormat }> {
	return await apiRequest("/api/trash-guides/user-custom-formats", {
		method: "POST",
		json: request,
	});
}

/**
 * Update a user custom format
 */
export async function updateUserCustomFormat(
	id: string,
	request: Partial<CreateUserCFRequest>
): Promise<{ success: boolean; customFormat: UserCustomFormat }> {
	return await apiRequest(`/api/trash-guides/user-custom-formats/${id}`, {
		method: "PUT",
		json: request,
	});
}

/**
 * Delete a user custom format
 */
export async function deleteUserCustomFormat(
	id: string
): Promise<{ success: boolean; message: string }> {
	return await apiRequest(`/api/trash-guides/user-custom-formats/${id}`, {
		method: "DELETE",
	});
}

/**
 * Import user custom formats from JSON
 */
export async function importUserCFsFromJson(
	request: ImportUserCFFromJsonRequest
): Promise<UserCFImportResponse> {
	return await apiRequest("/api/trash-guides/user-custom-formats/import-json", {
		method: "POST",
		json: request,
	});
}

/**
 * Import user custom formats from a connected instance
 */
export async function importUserCFsFromInstance(
	request: ImportUserCFFromInstanceRequest
): Promise<UserCFImportResponse> {
	return await apiRequest("/api/trash-guides/user-custom-formats/import-from-instance", {
		method: "POST",
		json: request,
	});
}

/**
 * Deploy user custom formats to an instance
 */
export async function deployUserCustomFormats(
	request: DeployUserCFsRequest
): Promise<DeployMultipleCustomFormatsResponse> {
	return await apiRequest("/api/trash-guides/user-custom-formats/deploy", {
		method: "POST",
		json: request,
	});
}
