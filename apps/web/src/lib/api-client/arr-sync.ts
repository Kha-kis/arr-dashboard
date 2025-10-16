/**
 * ARR Sync API Client
 * Typed client for Custom Formats & TRaSH sync endpoints
 */

import type {
	GetSettingsResponse,
	ArrSyncSettings,
	PreviewRequest,
	PreviewResponse,
	ApplyRequest,
	ApplyResponse,
	TestConnectionResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Get sync settings for all instances
 */
export async function getArrSyncSettings(): Promise<GetSettingsResponse> {
	return apiRequest<GetSettingsResponse>("/api/arr-sync/settings", {
		method: "GET",
	});
}

/**
 * Update sync settings for a specific instance
 */
export async function updateArrSyncSettings(
	instanceId: string,
	settings: ArrSyncSettings,
): Promise<{ success: boolean }> {
	return apiRequest<{ success: boolean }>(
		`/api/arr-sync/settings/${instanceId}`,
		{
			method: "PUT",
			json: settings,
		},
	);
}

/**
 * Preview sync changes (dry run)
 */
export async function previewArrSync(
	request: PreviewRequest,
): Promise<PreviewResponse> {
	return apiRequest<PreviewResponse>("/api/arr-sync/preview", {
		method: "POST",
		json: request,
	});
}

/**
 * Apply sync changes
 */
export async function applyArrSync(
	request: ApplyRequest,
): Promise<ApplyResponse> {
	return apiRequest<ApplyResponse>("/api/arr-sync/apply", {
		method: "POST",
		json: request,
	});
}

/**
 * Test connection to an instance
 */
export async function testArrSyncConnection(
	instanceId: string,
): Promise<TestConnectionResponse> {
	return apiRequest<TestConnectionResponse>(
		`/api/arr-sync/test/${instanceId}`,
		{
			method: "POST",
		},
	);
}
