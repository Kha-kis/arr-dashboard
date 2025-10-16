/**
 * Custom Formats API Client
 * Client functions for custom format CRUD operations
 */

import type { CustomFormat } from "@arr/shared";
import { apiRequest } from "./base";

// Response types
export interface CustomFormatsInstance {
	instanceId: string;
	instanceLabel: string;
	instanceService: string;
	customFormats: CustomFormat[];
	error: string | null;
}

export interface GetCustomFormatsResponse {
	instances: CustomFormatsInstance[];
}

export interface CopyCustomFormatRequest {
	sourceInstanceId: string;
	targetInstanceId: string;
	customFormatId: number;
}

export interface CopyCustomFormatResponse {
	message: string;
	sourceId: number;
	targetId: number;
	customFormat: CustomFormat;
}

/**
 * Get all custom formats (optionally filtered by instance)
 */
export async function getCustomFormats(
	instanceId?: string,
): Promise<GetCustomFormatsResponse> {
	const queryParams = instanceId ? `?instanceId=${instanceId}` : "";
	return apiRequest<GetCustomFormatsResponse>(
		`/api/custom-formats${queryParams}`,
		{
			method: "GET",
		},
	);
}

/**
 * Get a single custom format
 */
export async function getCustomFormat(
	instanceId: string,
	customFormatId: number,
): Promise<CustomFormat> {
	return apiRequest<CustomFormat>(
		`/api/custom-formats/${instanceId}/${customFormatId}`,
		{
			method: "GET",
		},
	);
}

/**
 * Create a new custom format
 */
export async function createCustomFormat(
	instanceId: string,
	customFormat: Omit<CustomFormat, "id">,
): Promise<CustomFormat> {
	return apiRequest<CustomFormat>("/api/custom-formats", {
		method: "POST",
		json: {
			instanceId,
			customFormat,
		},
	});
}

/**
 * Update an existing custom format
 */
export async function updateCustomFormat(
	instanceId: string,
	customFormatId: number,
	customFormat: Partial<Omit<CustomFormat, "id">>,
): Promise<CustomFormat> {
	return apiRequest<CustomFormat>(
		`/api/custom-formats/${instanceId}/${customFormatId}`,
		{
			method: "PUT",
			json: customFormat,
		},
	);
}

/**
 * Delete a custom format
 */
export async function deleteCustomFormat(
	instanceId: string,
	customFormatId: number,
): Promise<void> {
	return apiRequest<void>(
		`/api/custom-formats/${instanceId}/${customFormatId}`,
		{
			method: "DELETE",
		},
	);
}

/**
 * Copy a custom format from one instance to another
 */
export async function copyCustomFormat(
	request: CopyCustomFormatRequest,
): Promise<CopyCustomFormatResponse> {
	return apiRequest<CopyCustomFormatResponse>("/api/custom-formats/copy", {
		method: "POST",
		json: request,
	});
}

export interface ImportCustomFormatRequest {
	instanceId: string;
	customFormat: Omit<CustomFormat, "id">;
}

export interface ImportCustomFormatResponse {
	message: string;
	customFormat: CustomFormat;
}

/**
 * Export a custom format as JSON
 * Returns the custom format data ready for download
 */
export async function exportCustomFormat(
	instanceId: string,
	customFormatId: number,
): Promise<Omit<CustomFormat, "id">> {
	return apiRequest<Omit<CustomFormat, "id">>(
		`/api/custom-formats/${instanceId}/${customFormatId}/export`,
		{
			method: "GET",
		},
	);
}

/**
 * Import a custom format from JSON
 */
export async function importCustomFormat(
	request: ImportCustomFormatRequest,
): Promise<ImportCustomFormatResponse> {
	return apiRequest<ImportCustomFormatResponse>("/api/custom-formats/import", {
		method: "POST",
		json: request,
	});
}

/**
 * Get custom format schema (field definitions for specifications)
 */
export async function getCustomFormatSchema(instanceId: string): Promise<any> {
	return apiRequest<any>(`/api/custom-formats/schema/${instanceId}`, {
		method: "GET",
	});
}
