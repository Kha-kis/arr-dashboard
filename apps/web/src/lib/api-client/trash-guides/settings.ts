/**
 * Settings API Operations
 *
 * API functions for TRaSH Guides settings including
 * custom repository configuration and general preferences.
 */

import { apiRequest } from "../base";

// ============================================================================
// Types
// ============================================================================

export type TrashSettingsResponse = {
	settings: {
		id: string;
		userId: string;
		checkFrequency: number;
		autoRefreshCache: boolean;
		notifyOnUpdates: boolean;
		notifyOnSyncFail: boolean;
		backupRetention: number;
		backupRetentionDays: number;
		customRepoOwner: string | null;
		customRepoName: string | null;
		customRepoBranch: string | null;
	};
	defaultRepo: {
		owner: string;
		name: string;
		branch: string;
	};
};

export type UpdateTrashSettingsPayload = {
	checkFrequency?: number;
	autoRefreshCache?: boolean;
	notifyOnUpdates?: boolean;
	notifyOnSyncFail?: boolean;
	backupRetention?: number;
	backupRetentionDays?: number;
	customRepoOwner?: string | null;
	customRepoName?: string | null;
	customRepoBranch?: string | null;
};

export type UpdateTrashSettingsResponse = {
	settings: TrashSettingsResponse["settings"];
	message: string;
	cacheCleared: boolean;
};

export type TestRepoPayload = {
	owner: string;
	name: string;
	branch: string;
};

export type TestRepoResponse = {
	valid: boolean;
	repo?: string;
	branch?: string;
	structure?: {
		hasRadarr: boolean;
		hasSonarr: boolean;
		directoriesFound: string[];
	};
	error?: string;
};

export type ResetRepoResponse = {
	settings: TrashSettingsResponse["settings"];
	message: string;
	cacheEntriesCleared: number;
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get current user's TRaSH Guides settings
 */
export async function fetchTrashSettings(): Promise<TrashSettingsResponse> {
	return await apiRequest<TrashSettingsResponse>("/api/trash-guides/settings");
}

/**
 * Update TRaSH Guides settings
 */
export async function updateTrashSettings(
	payload: UpdateTrashSettingsPayload,
): Promise<UpdateTrashSettingsResponse> {
	return await apiRequest<UpdateTrashSettingsResponse>("/api/trash-guides/settings", {
		method: "PATCH",
		json: payload,
	});
}

/**
 * Test if a custom repository is valid and has the expected structure
 */
export async function testCustomRepo(
	payload: TestRepoPayload,
): Promise<TestRepoResponse> {
	return await apiRequest<TestRepoResponse>("/api/trash-guides/settings/test-repo", {
		method: "POST",
		json: payload,
	});
}

/**
 * Reset to official TRaSH-Guides/Guides repository
 */
export async function resetToOfficialRepo(): Promise<ResetRepoResponse> {
	return await apiRequest<ResetRepoResponse>("/api/trash-guides/settings/reset-repo", {
		method: "POST",
	});
}
