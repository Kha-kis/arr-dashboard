/**
 * Internal types for ARR Sync module
 * Maps between TRaSH guides, Sonarr/Radarr APIs, and our database
 */

import type { ServiceType } from "@prisma/client";
import type {
	CustomFormat,
	QualityProfile,
	CustomFormatSpecification,
} from "@arr/shared";

// ============================================================================
// Instance Context
// ============================================================================

export interface SyncContext {
	instanceId: string;
	instanceLabel: string;
	service: ServiceType;
	baseUrl: string;
	apiKey: string;
}

// ============================================================================
// TRaSH Guide Data Structures
// ============================================================================

export interface TrashCustomFormat {
	trash_id: string;
	trash_scores?: Record<string, number>;
	trash_description?: string;
	name: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: CustomFormatSpecification[];
}

export interface TrashQualityProfile {
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	items: any[];
	min_format_score?: number;
	cutoff_format_score?: number;
	custom_formats?: Array<{
		name: string;
		score: number;
	}>;
}

export interface TrashGuideData {
	customFormats: TrashCustomFormat[];
	qualityProfiles?: TrashQualityProfile[];
	version: string;
	lastUpdated: string;
}

// ============================================================================
// Remote State (from Sonarr/Radarr)
// ============================================================================

export interface RemoteState {
	customFormats: CustomFormat[];
	qualityProfiles: QualityProfile[];
	systemStatus?: {
		version: string;
		isDocker: boolean;
	};
}

// ============================================================================
// Diff & Plan
// ============================================================================

export interface DiffItem<T> {
	name: string;
	existingId?: number;
	action: "create" | "update" | "delete" | "skip";
	changes: string[];
	current?: T;
	desired?: T;
	reason?: string;
}

export interface SyncPlan {
	instanceId: string;
	instanceLabel: string;
	customFormats: {
		creates: DiffItem<CustomFormat>[];
		updates: DiffItem<CustomFormat>[];
		deletes: DiffItem<CustomFormat>[];
	};
	qualityProfiles: {
		creates: DiffItem<QualityProfile>[];
		updates: DiffItem<QualityProfile>[];
	};
	warnings: string[];
	errors: string[];
}

// ============================================================================
// Apply Result
// ============================================================================

export interface ApplyResult {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	backupPath?: string;
	applied: {
		customFormatsCreated: number;
		customFormatsUpdated: number;
		customFormatsDeleted: number;
		qualityProfilesCreated: number;
		qualityProfilesUpdated: number;
	};
	errors: string[];
	warnings: string[];
	duration?: number;
}

// ============================================================================
// Backup Data
// ============================================================================

export interface BackupData {
	instanceId: string;
	instanceLabel: string;
	service: ServiceType;
	timestamp: string;
	version: string;
	customFormats: CustomFormat[];
	qualityProfiles: QualityProfile[];
}
