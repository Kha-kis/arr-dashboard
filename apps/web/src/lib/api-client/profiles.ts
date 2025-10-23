/**
 * Profiles API Client
 * Client functions for quality profiles and template overlay management
 */

import { apiRequest } from "./base";

export interface QualityProfile {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	minFormatScore?: number;
	cutoffFormatScore?: number;
	formatItems?: Array<{
		format: number;
		name?: string;
		score: number;
	}>;
}

export interface QualityProfilesResponse {
	instanceId: string;
	instanceLabel: string;
	instanceService: string;
	qualityProfiles: QualityProfile[];
}

export interface TemplateOverride {
	trash_id: string;
	score: number;
}

export interface TemplateOverlay {
	includes: string[];
	excludes: string[];
	overrides: TemplateOverride[];
	lastAppliedAt: string | null;
}

export interface OverlayResponse {
	instanceId: string;
	instanceLabel: string;
	overlay: TemplateOverlay;
}

export interface UpdateOverlayRequest {
	includes: string[];
	excludes: string[];
	overrides: TemplateOverride[];
}

export interface PreviewRequest {
	includes: string[];
	excludes: string[];
	overrides: TemplateOverride[];
}

export interface PreviewResponse {
	instanceId: string;
	instanceLabel: string;
	changes: {
		added: any[];
		modified: any[];
		removed: any[];
	};
	warnings: string[];
}

export interface ApplyRequest {
	includes: string[];
	excludes: string[];
	overrides: TemplateOverride[];
	dryRun?: boolean;
}

export interface ApplyResponse {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	applied: {
		created: number;
		updated: number;
		deleted: number;
	};
	warnings: string[];
}

/**
 * Fetch quality profiles from an ARR instance
 */
export async function getQualityProfiles(
	instanceId: string,
): Promise<QualityProfilesResponse> {
	return apiRequest<QualityProfilesResponse>({
		path: `/api/profiles/quality-profiles/${instanceId}`,
		method: "GET",
	});
}

/**
 * Get template overlay configuration for an instance
 */
export async function getOverlay(instanceId: string): Promise<OverlayResponse> {
	return apiRequest<OverlayResponse>({
		path: `/api/profiles/overlays/${instanceId}`,
		method: "GET",
	});
}

/**
 * Update template overlay configuration for an instance
 */
export async function updateOverlay(
	instanceId: string,
	data: UpdateOverlayRequest,
): Promise<{ success: boolean; overlay: TemplateOverlay }> {
	return apiRequest({
		path: `/api/profiles/overlays/${instanceId}`,
		method: "PUT",
		json: data,
	});
}

/**
 * Preview template overlay changes before applying
 */
export async function previewOverlay(
	instanceId: string,
	data: PreviewRequest,
): Promise<PreviewResponse> {
	return apiRequest<PreviewResponse>({
		path: `/api/profiles/preview/${instanceId}`,
		method: "POST",
		json: data,
	});
}

/**
 * Apply template overlay to an instance
 */
export async function applyOverlay(
	instanceId: string,
	data: ApplyRequest,
): Promise<ApplyResponse> {
	return apiRequest<ApplyResponse>({
		path: `/api/profiles/apply/${instanceId}`,
		method: "POST",
		json: data,
	});
}
