/**
 * Custom Formats API Client
 * Functions for browsing and deploying individual TRaSH Guides custom formats
 */

import { apiRequest } from "./base";

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
 * Deploy a single custom format to an instance
 */
export async function deployCustomFormat(
	request: DeployCustomFormatRequest
): Promise<DeployCustomFormatResponse> {
	return await apiRequest<DeployCustomFormatResponse>("/api/trash-guides/custom-formats/deploy", {
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
		json: request,
	});
}
