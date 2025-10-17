/**
 * TRaSH Guides API Client
 * Client functions for browsing and importing custom formats from TRaSH Guides
 */

import { apiRequest } from "./base";

// Types
export interface TrashCustomFormat {
	trash_id: string;
	trash_scores?: Record<string, number>;
	trash_description?: string;
	name: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: Array<{
		implementation: string;
		name: string;
		negate: boolean;
		required: boolean;
		fields: Record<string, any>;
	}>;
}

export interface GetTrashFormatsResponse {
	customFormats: TrashCustomFormat[];
	version: string;
	lastUpdated: string;
}

export interface ImportTrashFormatRequest {
	instanceId: string;
	trashId: string;
	service: "SONARR" | "RADARR";
	ref?: string;
}

export interface ImportTrashFormatResponse {
	message: string;
	customFormat: any;
	action: "created" | "updated";
}

export interface TrashTrackedFormat {
	customFormatId: number;
	customFormatName: string;
	trashId: string;
	service: "SONARR" | "RADARR";
	syncExcluded: boolean;
	lastSyncedAt: string;
	gitRef: string;
	importSource: "INDIVIDUAL" | "CF_GROUP" | "QUALITY_PROFILE";
	sourceReference?: string; // Group filename or profile filename
}

export interface GetTrashTrackedResponse {
	tracked: Record<string, TrashTrackedFormat[]>;
}

export interface SyncTrashFormatsRequest {
	instanceId: string;
	ref?: string;
}

export interface SyncTrashFormatsResponse {
	message: string;
	synced: number;
	failed: number;
	results: Array<{
		customFormatId: number;
		name: string;
		status: "synced" | "failed" | "not_found" | "error" | "skipped";
	}>;
}

/**
 * Get available TRaSH custom formats for a service
 */
export async function getTrashFormats(
	service: "SONARR" | "RADARR",
	ref = "master"
): Promise<GetTrashFormatsResponse> {
	return apiRequest<GetTrashFormatsResponse>(
		`/api/trash-guides/formats?service=${service}&ref=${ref}`,
		{
			method: "GET",
		}
	);
}

/**
 * Import a TRaSH custom format to an instance
 */
export async function importTrashFormat(
	request: ImportTrashFormatRequest
): Promise<ImportTrashFormatResponse> {
	return apiRequest<ImportTrashFormatResponse>("/api/trash-guides/import", {
		method: "POST",
		json: {
			...request,
			ref: request.ref || "master",
		},
	});
}

/**
 * Get TRaSH-tracked custom formats
 */
export async function getTrashTracked(): Promise<GetTrashTrackedResponse> {
	return apiRequest<GetTrashTrackedResponse>("/api/trash-guides/tracked", {
		method: "GET",
	});
}

/**
 * Sync all TRaSH-managed custom formats for an instance
 */
export async function syncTrashFormats(
	request: SyncTrashFormatsRequest
): Promise<SyncTrashFormatsResponse> {
	return apiRequest<SyncTrashFormatsResponse>("/api/trash-guides/sync", {
		method: "POST",
		json: {
			...request,
			ref: request.ref || "master",
		},
	});
}

// ============================================================================
// TRaSH Sync Automation (Per-Instance)
// ============================================================================

export interface TrashInstanceSyncSettings {
	id?: string;
	serviceInstanceId: string;
	enabled: boolean;
	intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY";
	intervalValue: number;

	// What to sync
	syncFormats: boolean;
	syncCFGroups: boolean;
	syncQualityProfiles: boolean;

	// Last run info
	lastRunAt: string | null;
	lastRunStatus: "SUCCESS" | "FAILED" | "PARTIAL" | null;
	lastErrorMessage: string | null;

	// Last run statistics
	formatsSynced: number;
	formatsFailed: number;
	cfGroupsSynced: number;
	qualityProfilesSynced: number;

	nextRunAt: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export interface GetAllTrashSyncSettingsResponse {
	settings: TrashInstanceSyncSettings[];
}

export interface UpdateTrashInstanceSyncSettingsRequest {
	enabled: boolean;
	intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY";
	intervalValue: number;
	syncFormats: boolean;
	syncCFGroups: boolean;
	syncQualityProfiles: boolean;
}

/**
 * Get all TRaSH sync automation settings (all instances)
 */
export async function getAllTrashSyncSettings(): Promise<GetAllTrashSyncSettingsResponse> {
	return apiRequest<GetAllTrashSyncSettingsResponse>("/api/trash-guides/sync-settings", {
		method: "GET",
	});
}

/**
 * Get TRaSH sync automation settings for a specific instance
 */
export async function getTrashSyncSettings(instanceId: string): Promise<TrashInstanceSyncSettings> {
	return apiRequest<TrashInstanceSyncSettings>(`/api/trash-guides/sync-settings/${instanceId}`, {
		method: "GET",
	});
}

/**
 * Update TRaSH sync automation settings for a specific instance
 */
export async function updateTrashSyncSettings(
	instanceId: string,
	settings: UpdateTrashInstanceSyncSettingsRequest
): Promise<TrashInstanceSyncSettings> {
	return apiRequest<TrashInstanceSyncSettings>(`/api/trash-guides/sync-settings/${instanceId}`, {
		method: "PUT",
		json: settings,
	});
}

// ============================================================================
// TRaSH Sync Exclusion
// ============================================================================

export interface ToggleSyncExclusionRequest {
	syncExcluded: boolean;
}

export interface ToggleSyncExclusionResponse {
	message: string;
	customFormatId: number;
	customFormatName: string;
	syncExcluded: boolean;
}

/**
 * Toggle sync exclusion for a TRaSH-managed custom format
 */
export async function toggleSyncExclusion(
	instanceId: string,
	customFormatId: number,
	syncExcluded: boolean
): Promise<ToggleSyncExclusionResponse> {
	return apiRequest<ToggleSyncExclusionResponse>(
		`/api/trash-guides/tracked/${instanceId}/${customFormatId}/exclusion`,
		{
			method: "PUT",
			json: { syncExcluded },
		}
	);
}

// ============================================================================
// CF Groups
// ============================================================================

export interface TrashCFGroupFormatRef {
	trash_id: string;
	required?: boolean;
}

export interface TrashCFGroup {
	name: string;
	fileName: string;
	trash_id?: string;
	trash_description?: string;
	default?: boolean;
	custom_formats: TrashCFGroupFormatRef[];
	quality_profiles?: Record<string, any>;
}

export interface GetTrashCFGroupsResponse {
	cfGroups: TrashCFGroup[];
	version: string;
	lastUpdated: string;
}

export interface ImportCFGroupRequest {
	instanceId: string;
	groupFileName: string;
	service: "SONARR" | "RADARR";
	ref?: string;
}

export interface ImportCFGroupResponse {
	message: string;
	imported: number;
	failed: number;
	results: Array<{
		trashId: string;
		name: string;
		status: "imported" | "not_found" | "failed";
	}>;
	groupName: string;
}

/**
 * Get available TRaSH CF groups for a service
 */
export async function getTrashCFGroups(
	service: "SONARR" | "RADARR",
	ref = "master"
): Promise<GetTrashCFGroupsResponse> {
	return apiRequest<GetTrashCFGroupsResponse>(
		`/api/trash-guides/cf-groups?service=${service}&ref=${ref}`,
		{
			method: "GET",
		}
	);
}

/**
 * Import a TRaSH CF group to an instance
 */
export async function importCFGroup(
	request: ImportCFGroupRequest
): Promise<ImportCFGroupResponse> {
	return apiRequest<ImportCFGroupResponse>("/api/trash-guides/import-cf-group", {
		method: "POST",
		json: {
			...request,
			ref: request.ref || "master",
		},
	});
}

// ============================================================================
// Tracked CF Groups
// ============================================================================

export interface TrackedCFGroupWithInstance {
	id: string;
	serviceInstanceId: string;
	groupFileName: string;
	groupName: string;
	service: "SONARR" | "RADARR" | "PROWLARR";
	importedCount: number;
	lastSyncedAt: string;
	gitRef: string;
	createdAt: string;
	updatedAt: string;
	instanceLabel: string;
}

export interface GetTrackedCFGroupsResponse {
	groups: TrackedCFGroupWithInstance[];
}

export interface ResyncCFGroupRequest {
	instanceId: string;
	groupFileName: string;
	ref?: string;
}

export interface ResyncCFGroupResponse {
	message: string;
	imported: number;
	failed: number;
	results: Array<{
		trashId: string;
		name: string;
		status: "imported" | "not_found" | "failed";
	}>;
	groupName: string;
}

/**
 * Get all tracked CF groups (all instances)
 */
export async function getTrackedCFGroups(): Promise<GetTrackedCFGroupsResponse> {
	return apiRequest<GetTrackedCFGroupsResponse>("/api/trash-guides/tracked-cf-groups", {
		method: "GET",
	});
}

/**
 * Re-sync a tracked CF group
 */
export async function resyncCFGroup(
	request: ResyncCFGroupRequest
): Promise<ResyncCFGroupResponse> {
	// Strip .json extension from groupFileName to avoid confusion with static files
	// Backend will normalize it back to include .json for database lookup
	const cleanGroupFileName = request.groupFileName.endsWith('.json')
		? request.groupFileName.slice(0, -5)
		: request.groupFileName;

	return apiRequest<ResyncCFGroupResponse>("/api/trash-guides/resync-cf-group", {
		method: "POST",
		json: {
			...request,
			groupFileName: cleanGroupFileName,
			ref: request.ref || "master",
		},
	});
}

/**
 * Untrack a CF group (removes tracking and optionally deletes formats from instance)
 */
export async function untrackCFGroup(
	instanceId: string,
	groupFileName: string,
	deleteFormats = true
): Promise<{
	message: string;
	untracked: number;
	failed: number;
	results: Array<{
		customFormatId: number;
		name: string;
		status: "untracked_and_deleted" | "tracking_only_removed" | "delete_failed" | "error" | "converted_to_individual";
	}>;
	groupName: string;
	action: "deleted" | "converted";
}> {
	// Strip .json extension from groupFileName to avoid confusion with static files
	// Backend will normalize it back to include .json for database lookup
	const cleanGroupFileName = groupFileName.endsWith('.json')
		? groupFileName.slice(0, -5)
		: groupFileName;

	const queryParams = new URLSearchParams({
		deleteFormats: deleteFormats.toString(),
	});

	return apiRequest<{
		message: string;
		untracked: number;
		failed: number;
		results: Array<{
			customFormatId: number;
			name: string;
			status: "untracked_and_deleted" | "tracking_only_removed" | "delete_failed" | "error" | "converted_to_individual";
		}>;
		groupName: string;
		action: "deleted" | "converted";
	}>(`/api/trash-guides/tracked-cf-groups/${encodeURIComponent(instanceId)}/${encodeURIComponent(cleanGroupFileName)}?${queryParams}`, {
		method: "DELETE",
	});
}

// ============================================================================
// Quality Profiles
// ============================================================================

export interface TrashQualityProfile {
	name: string;
	fileName: string;
	trash_id?: string;
	trash_description?: string;
	upgradeAllowed?: boolean;
	cutoff?: any;
	items?: any[];
	minFormatScore?: number;
	cutoffFormatScore?: number;
	formatItems?: any[];
	language?: any;
}

export interface GetTrashQualityProfilesResponse {
	qualityProfiles: TrashQualityProfile[];
	version: string;
	lastUpdated: string;
}

export interface ApplyQualityProfileRequest {
	instanceId: string;
	profileFileName: string;
	service: "SONARR" | "RADARR";
	ref?: string;
}

export interface ApplyQualityProfileResponse {
	message: string;
	qualityProfile: any;
	action: "created" | "updated";
	importedCFs?: {
		created: number;
		updated: number;
		skipped: number;
		failed: number;
	};
}

/**
 * Get available TRaSH quality profiles for a service
 */
export async function getTrashQualityProfiles(
	service: "SONARR" | "RADARR",
	ref = "master"
): Promise<GetTrashQualityProfilesResponse> {
	return apiRequest<GetTrashQualityProfilesResponse>(
		`/api/trash-guides/quality-profiles?service=${service}&ref=${ref}`,
		{
			method: "GET",
		}
	);
}

/**
 * Apply a TRaSH quality profile to an instance
 */
export async function applyQualityProfile(
	request: ApplyQualityProfileRequest
): Promise<ApplyQualityProfileResponse> {
	return apiRequest<ApplyQualityProfileResponse>("/api/trash-guides/apply-quality-profile", {
		method: "POST",
		json: {
			...request,
			ref: request.ref || "master",
		},
	});
}

// ============================================================================
// Tracked Quality Profiles
// ============================================================================

export interface TrackedQualityProfileWithInstance {
	id: string;
	serviceInstanceId: string;
	profileFileName: string;
	profileName: string;
	qualityProfileId: number | null;
	service: "SONARR" | "RADARR" | "PROWLARR";
	lastAppliedAt: string;
	gitRef: string;
	createdAt: string;
	updatedAt: string;
	instanceLabel: string;
}

export interface GetTrackedQualityProfilesResponse {
	profiles: TrackedQualityProfileWithInstance[];
}

export interface ReapplyQualityProfileRequest {
	instanceId: string;
	profileFileName: string;
	ref?: string;
}

export interface ReapplyQualityProfileResponse {
	message: string;
	qualityProfile: any;
	action: "created" | "updated";
	importedCFs?: {
		created: number;
		updated: number;
		skipped: number;
		failed: number;
	};
}

/**
 * Get all tracked quality profiles (all instances)
 */
export async function getTrackedQualityProfiles(): Promise<GetTrackedQualityProfilesResponse> {
	return apiRequest<GetTrackedQualityProfilesResponse>("/api/trash-guides/tracked-quality-profiles", {
		method: "GET",
	});
}

/**
 * Re-apply a tracked quality profile
 */
export async function reapplyQualityProfile(
	request: ReapplyQualityProfileRequest
): Promise<ReapplyQualityProfileResponse> {
	return apiRequest<ReapplyQualityProfileResponse>("/api/trash-guides/reapply-quality-profile", {
		method: "POST",
		json: {
			...request,
			ref: request.ref || "master",
		},
	});
}
