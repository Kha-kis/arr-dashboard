/**
 * Quality Size API Operations
 *
 * Client functions for managing TRaSH quality size presets
 * (file size limits applied to Sonarr/Radarr instances).
 */

import type { TrashQualitySize } from "@arr/shared";
import { apiRequest } from "../base";

// ============================================================================
// Types
// ============================================================================

export type QualitySizePresetsResponse = {
	success: boolean;
	presets: TrashQualitySize[];
};

export type QualitySizeComparison = {
	qualityName: string;
	instanceDefinitionId: number | null;
	instanceTitle: string | null;
	current: { min: number; preferred: number; max: number } | null;
	trash: { min: number; preferred: number; max: number };
	matched: boolean;
	changed: boolean;
};

export type QualitySizePreviewResponse = {
	success: boolean;
	preset: { trashId: string; type: string };
	comparisons: QualitySizeComparison[];
	summary: {
		matched: number;
		changed: number;
		unmatched: number;
		total: number;
	};
	existingMapping: {
		presetTrashId: string;
		presetType: string;
		syncStrategy: "auto" | "manual" | "notify";
		lastAppliedAt: string;
	} | null;
};

export type ApplyQualitySizePayload = {
	instanceId: string;
	presetTrashId: string;
	syncStrategy?: "auto" | "manual" | "notify";
};

export type ApplyQualitySizeResponse = {
	success: boolean;
	appliedCount: number;
	totalQualities: number;
	message: string;
	warning?: string;
};

export type UpdateSyncStrategyPayload = {
	instanceId: string;
	syncStrategy: "auto" | "manual" | "notify";
};

export type UpdateSyncStrategyResponse = {
	success: boolean;
	syncStrategy: "auto" | "manual" | "notify";
};

export type QualitySizeMappingResponse = {
	success: boolean;
	mapping: {
		presetTrashId: string;
		presetType: string;
		syncStrategy: "auto" | "manual" | "notify";
		lastAppliedAt: string;
	} | null;
};

// ============================================================================
// API Functions
// ============================================================================

export async function fetchQualitySizePresets(
	serviceType: "RADARR" | "SONARR",
): Promise<QualitySizePresetsResponse> {
	return apiRequest<QualitySizePresetsResponse>(
		`/api/trash-guides/quality-size/presets?serviceType=${serviceType}`,
	);
}

export async function getQualitySizePreview(
	instanceId: string,
	presetTrashId: string,
): Promise<QualitySizePreviewResponse> {
	return apiRequest<QualitySizePreviewResponse>(
		"/api/trash-guides/quality-size/preview",
		{
			method: "POST",
			json: { instanceId, presetTrashId },
		},
	);
}

export async function applyQualitySize(
	payload: ApplyQualitySizePayload,
): Promise<ApplyQualitySizeResponse> {
	return apiRequest<ApplyQualitySizeResponse>(
		"/api/trash-guides/quality-size/apply",
		{
			method: "POST",
			json: payload,
		},
	);
}

export async function fetchQualitySizeMapping(
	instanceId: string,
): Promise<QualitySizeMappingResponse> {
	return apiRequest<QualitySizeMappingResponse>(
		`/api/trash-guides/quality-size/mapping?instanceId=${encodeURIComponent(instanceId)}`,
	);
}

export async function updateQualitySizeSyncStrategy(
	payload: UpdateSyncStrategyPayload,
): Promise<UpdateSyncStrategyResponse> {
	return apiRequest<UpdateSyncStrategyResponse>(
		"/api/trash-guides/quality-size/sync-strategy",
		{
			method: "PATCH",
			json: payload,
		},
	);
}
