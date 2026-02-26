/**
 * Naming API Operations
 *
 * API functions for TRaSH Guides naming scheme preset management,
 * including preset fetching, preview, deployment, and config CRUD.
 */

import type {
	NamingConfigRecord,
	NamingPreviewResult,
	NamingPresetsResponse,
	NamingSelectedPresets,
} from "@arr/shared";
import { buildQueryUrl } from "../../build-query-url";
import { apiRequest } from "../base";

// Re-export shared types for convenience
export type { NamingPresetsResponse, NamingPreviewResult, NamingConfigRecord, NamingSelectedPresets };

// ============================================================================
// Response Types
// ============================================================================

export type NamingPresetsApiResponse = {
	success: boolean;
	presets: NamingPresetsResponse | null;
};

export type NamingPreviewApiResponse = {
	success: boolean;
	preview: NamingPreviewResult;
};

export type NamingApplyApiResponse = {
	success: boolean;
	fieldCount: number;
	message: string;
	warning?: string;
};

export type NamingConfigApiResponse = {
	success: boolean;
	config: NamingConfigRecord | null;
};

export type NamingConfigSaveResponse = {
	success: boolean;
	config: NamingConfigRecord;
};

export type NamingConfigDeleteResponse = {
	success: boolean;
	message: string;
};

// ============================================================================
// Request Types
// ============================================================================

export type NamingPreviewPayload = {
	instanceId: string;
	selectedPresets: NamingSelectedPresets;
};

export type NamingApplyPayload = {
	instanceId: string;
	selectedPresets: NamingSelectedPresets;
};

export type NamingConfigCreatePayload = {
	instanceId: string;
	selectedPresets: NamingSelectedPresets;
	syncStrategy?: "auto" | "manual" | "notify";
};

export type NamingConfigPatchPayload = {
	selectedPresets?: NamingSelectedPresets;
};

// ============================================================================
// API Functions - Presets
// ============================================================================

/**
 * Fetch available naming presets from TRaSH cache for a service type
 */
export async function fetchNamingPresets(
	serviceType: "RADARR" | "SONARR",
): Promise<NamingPresetsApiResponse> {
	const url = buildQueryUrl("/api/trash-guides/naming/presets", { serviceType });
	return await apiRequest<NamingPresetsApiResponse>(url);
}

// ============================================================================
// API Functions - Preview & Apply
// ============================================================================

/**
 * Preview naming config changes against an instance's current naming settings
 */
export async function getNamingPreview(
	payload: NamingPreviewPayload,
): Promise<NamingPreviewApiResponse> {
	return await apiRequest<NamingPreviewApiResponse>("/api/trash-guides/naming/preview", {
		method: "POST",
		json: payload,
	});
}

/**
 * Apply selected naming presets to an instance
 */
export async function applyNaming(payload: NamingApplyPayload): Promise<NamingApplyApiResponse> {
	return await apiRequest<NamingApplyApiResponse>("/api/trash-guides/naming/apply", {
		method: "POST",
		json: payload,
	});
}

// ============================================================================
// API Functions - Config CRUD
// ============================================================================

/**
 * Get saved naming config for an instance
 */
export async function fetchNamingConfig(instanceId: string): Promise<NamingConfigApiResponse> {
	const url = buildQueryUrl("/api/trash-guides/naming/configs", { instanceId });
	return await apiRequest<NamingConfigApiResponse>(url);
}

/**
 * Create or upsert naming config for an instance
 */
export async function saveNamingConfig(
	payload: NamingConfigCreatePayload,
): Promise<NamingConfigSaveResponse> {
	return await apiRequest<NamingConfigSaveResponse>("/api/trash-guides/naming/configs", {
		method: "POST",
		json: payload,
	});
}

/**
 * Partial update of naming config for an instance
 */
export async function patchNamingConfig(
	instanceId: string,
	payload: NamingConfigPatchPayload,
): Promise<NamingConfigSaveResponse> {
	return await apiRequest<NamingConfigSaveResponse>(
		`/api/trash-guides/naming/configs/${instanceId}`,
		{
			method: "PATCH",
			json: payload,
		},
	);
}

/**
 * Delete naming config for an instance
 */
export async function deleteNamingConfig(
	instanceId: string,
): Promise<NamingConfigDeleteResponse> {
	return await apiRequest<NamingConfigDeleteResponse>(
		`/api/trash-guides/naming/configs/${instanceId}`,
		{
			method: "DELETE",
		},
	);
}
