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
		fields: Record<string, unknown>;
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
	unavailableServices?: ("RADARR" | "SONARR")[];
}

export interface CFDescriptionsListResponse {
	radarr?: CFDescription[];
	sonarr?: CFDescription[];
	unavailableServices?: ("RADARR" | "SONARR")[];
}

export interface DeployMultipleCustomFormatsRequest {
	trashIds: string[];
	instanceId: string;
	serviceType: "RADARR" | "SONARR";
}

export interface DeployMultipleCustomFormatsResponse {
	success: boolean;
	created: string[];
	updated: string[];
	failed: Array<{ name: string; error: string }>;
}

export interface StandaloneCustomFormatDeploymentResponse
	extends DeployMultipleCustomFormatsResponse {
	outcome: "complete" | "uncertain" | "partial" | "rejected";
	historyId: string;
	message: string;
	unchanged: string[];
	targets: Array<{
		trashId: string;
		name: string;
		status: "created" | "updated" | "unchanged" | "uncertain" | "skipped";
		tracked: boolean;
	}>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStandaloneResponse(value: unknown): value is StandaloneCustomFormatDeploymentResponse {
	if (
		!isRecord(value) ||
		typeof value.success !== "boolean" ||
		typeof value.historyId !== "string" ||
		!value.historyId ||
		typeof value.message !== "string" ||
		!["complete", "uncertain", "partial", "rejected"].includes(String(value.outcome))
	)
		return false;
	if (
		![value.created, value.updated, value.unchanged].every(
			(names) => Array.isArray(names) && names.every((name) => typeof name === "string"),
		)
	)
		return false;
	if (
		!Array.isArray(value.failed) ||
		!value.failed.every(
			(target) =>
				isRecord(target) && typeof target.name === "string" && typeof target.error === "string",
		)
	)
		return false;
	return (
		Array.isArray(value.targets) &&
		value.targets.every(
			(target) =>
				isRecord(target) &&
				typeof target.trashId === "string" &&
				typeof target.name === "string" &&
				typeof target.tracked === "boolean" &&
				["created", "updated", "unchanged", "uncertain", "skipped"].includes(String(target.status)),
		)
	);
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
		fields: Record<string, unknown>;
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
		fields?: Record<string, unknown>;
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
			fields?: Record<string, unknown> | Array<{ name: string; value: unknown }>;
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
	serviceType?: "RADARR" | "SONARR",
): Promise<CustomFormatsListResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<CustomFormatsListResponse>(
		`/api/trash-guides/cache/custom-formats/list${params}`,
	);
}

/**
 * Fetch all CF descriptions from TRaSH Guides cache
 */
export async function fetchCFDescriptionsList(
	serviceType?: "RADARR" | "SONARR",
): Promise<CFDescriptionsListResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<CFDescriptionsListResponse>(
		`/api/trash-guides/cache/cf-descriptions/list${params}`,
	);
}

/**
 * Deploy multiple custom formats to an instance
 */
export async function deployMultipleCustomFormats(
	request: DeployMultipleCustomFormatsRequest,
): Promise<StandaloneCustomFormatDeploymentResponse> {
	const data = await apiRequest<unknown>("/api/trash-guides/custom-formats/deploy-multiple", {
		method: "POST",
		json: request,
		expectedSuccessStatus: 200,
		requireJsonSuccess: true,
	});
	if (!isStandaloneResponse(data))
		throw new Error(
			"Deployment acknowledgment could not be verified. Inspect the instance and operation history before retrying.",
		);
	const requested = new Set(request.trashIds);
	const unchanged = data.targets
		.filter((target) => target.status === "unchanged")
		.map((target) => target.name);
	const targetIds = new Set(data.targets.map((target) => target.trashId));
	const created = data.targets
		.filter((target) => target.status === "created")
		.map((target) => target.name);
	const updated = data.targets
		.filter((target) => target.status === "updated")
		.map((target) => target.name);
	if (
		requested.size !== request.trashIds.length ||
		targetIds.size !== data.targets.length ||
		targetIds.size !== requested.size ||
		data.targets.some((target) => !requested.has(target.trashId)) ||
		JSON.stringify(created) !== JSON.stringify(data.created) ||
		JSON.stringify(updated) !== JSON.stringify(data.updated) ||
		JSON.stringify(unchanged) !== JSON.stringify(data.unchanged) ||
		(data.success &&
			(data.outcome !== "complete" ||
				data.failed.length > 0 ||
				data.targets.some(
					(target) =>
						!target.tracked ||
						(target.status !== "created" &&
							target.status !== "updated" &&
							target.status !== "unchanged"),
				))) ||
		(!data.success && data.outcome === "complete")
	) {
		throw new Error(
			"Deployment acknowledgment did not match the complete selection. Inspect the instance and operation history before retrying.",
		);
	}
	return data;
}

/**
 * Fetch user custom formats
 */
export async function fetchUserCustomFormats(
	serviceType?: "RADARR" | "SONARR",
): Promise<UserCustomFormatsResponse> {
	const params = serviceType ? `?serviceType=${serviceType}` : "";
	return await apiRequest<UserCustomFormatsResponse>(
		`/api/trash-guides/user-custom-formats${params}`,
	);
}

/**
 * Create a user custom format
 */
export async function createUserCustomFormat(
	request: CreateUserCFRequest,
): Promise<{ success: boolean; customFormat: UserCustomFormat }> {
	return await apiRequest("/api/trash-guides/user-custom-formats", {
		method: "POST",
		json: request,
	});
}

/**
 * Delete a user custom format
 */
export async function deleteUserCustomFormat(
	id: string,
): Promise<{ success: boolean; message: string }> {
	return await apiRequest(`/api/trash-guides/user-custom-formats/${id}`, {
		method: "DELETE",
	});
}

/**
 * Import user custom formats from JSON
 */
export async function importUserCFsFromJson(
	request: ImportUserCFFromJsonRequest,
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
	request: ImportUserCFFromInstanceRequest,
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
	request: DeployUserCFsRequest,
): Promise<DeployMultipleCustomFormatsResponse> {
	return await apiRequest("/api/trash-guides/user-custom-formats/deploy", {
		method: "POST",
		json: request,
	});
}
