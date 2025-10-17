import { z } from "zod";

/**
 * ARR Sync - Custom Formats & TRaSH Guides Integration
 * Types and schemas for syncing custom formats and quality profiles
 */

// ============================================================================
// Custom Format Types
// ============================================================================

export const CustomFormatTermSchema = z.object({
	implementation: z.string(),
	name: z.string(),
	negate: z.boolean().default(false),
	required: z.boolean().default(false),
	fields: z.record(z.any()).default({}),
});

export const CustomFormatSpecificationSchema = z.object({
	name: z.string(),
	implementation: z.string(),
	negate: z.boolean().default(false),
	required: z.boolean().default(false),
	fields: z.record(z.any()).default({}),
});

export const CustomFormatSchema = z.object({
	id: z.number().optional(),
	name: z.string(),
	includeCustomFormatWhenRenaming: z.boolean().default(false),
	specifications: z.array(CustomFormatSpecificationSchema).default([]),
});

export type CustomFormat = z.infer<typeof CustomFormatSchema>;
export type CustomFormatSpecification = z.infer<
	typeof CustomFormatSpecificationSchema
>;

// ============================================================================
// Quality Profile Types
// ============================================================================

// Recursive schema for quality profile items
export const QualityProfileItemSchema: z.ZodSchema = z.object({
	id: z.number().optional(),
	name: z.string().optional(),
	quality: z
		.object({
			id: z.number(),
			name: z.string(),
			source: z.string().optional(),
			resolution: z.number().optional(),
		})
		.optional(),
	items: z.array(z.lazy(() => QualityProfileItemSchema)).default([]),
	allowed: z.boolean().default(true),
});

export const CustomFormatScoreSchema = z.object({
	id: z.number().optional(),
	name: z.string().optional(),
	format: z.number().optional(),
	score: z.number(),
	// Support both formats for compatibility
	Format: z.number().optional(),
	Name: z.string().optional(),
	Score: z.number().optional(),
});

export const QualityProfileSchema = z.object({
	id: z.number().optional(),
	name: z.string(),
	upgradeAllowed: z.boolean().default(true),
	cutoff: z.number(),
	items: z.array(QualityProfileItemSchema).default([]),
	minFormatScore: z.number().default(0),
	cutoffFormatScore: z.number().default(0),
	formatItems: z.array(CustomFormatScoreSchema).default([]),
	language: z
		.object({
			id: z.number(),
			name: z.string(),
		})
		.optional(),
});

export type QualityProfile = z.infer<typeof QualityProfileSchema>;
export type QualityProfileItem = z.infer<typeof QualityProfileItemSchema>;
export type CustomFormatScore = z.infer<typeof CustomFormatScoreSchema>;

// ============================================================================
// TRaSH Guide Types
// ============================================================================

export const TrashGuidePresetSchema = z.object({
	name: z.string(),
	displayName: z.string().optional(),
	description: z.string().optional(),
	customFormats: z.array(z.string()).default([]),
	scores: z.record(z.string(), z.number()).default({}),
});

export type TrashGuidePreset = z.infer<typeof TrashGuidePresetSchema>;

// CF Group Types
export const TrashCFGroupFormatRefSchema = z.object({
	trash_id: z.string(),
	required: z.boolean().optional(),
});

export const TrashCFGroupSchema = z.object({
	name: z.string(),
	fileName: z.string(),
	trash_id: z.string().optional(),
	trash_description: z.string().optional(),
	default: z.boolean().optional(),
	custom_formats: z.array(TrashCFGroupFormatRefSchema).default([]),
	quality_profiles: z.record(z.any()).optional(),
});

export const GetTrashCFGroupsResponseSchema = z.object({
	cfGroups: z.array(TrashCFGroupSchema),
	version: z.string(),
	lastUpdated: z.string(),
});

export const ImportCFGroupRequestSchema = z.object({
	instanceId: z.string(),
	groupFileName: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

export const ImportCFGroupResponseSchema = z.object({
	message: z.string(),
	imported: z.number(),
	failed: z.number(),
	results: z.array(z.object({
		trashId: z.string(),
		name: z.string(),
		status: z.enum(["imported", "not_found", "failed"]),
	})),
	groupName: z.string(),
});

export type TrashCFGroupFormatRef = z.infer<typeof TrashCFGroupFormatRefSchema>;
export type TrashCFGroup = z.infer<typeof TrashCFGroupSchema>;
export type GetTrashCFGroupsResponse = z.infer<typeof GetTrashCFGroupsResponseSchema>;
export type ImportCFGroupRequest = z.infer<typeof ImportCFGroupRequestSchema>;
export type ImportCFGroupResponse = z.infer<typeof ImportCFGroupResponseSchema>;

// Quality Profile Types
export const TrashQualityProfileSchema = z.object({
	name: z.string(),
	fileName: z.string(),
	trash_id: z.string().optional(),
	trash_description: z.string().optional(),
	upgradeAllowed: z.boolean().optional(),
	cutoff: z.any().optional(),
	items: z.array(z.any()).optional(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	formatItems: z.array(z.any()).optional(),
	language: z.any().optional(),
});

export const GetTrashQualityProfilesResponseSchema = z.object({
	qualityProfiles: z.array(TrashQualityProfileSchema),
	version: z.string(),
	lastUpdated: z.string(),
});

export const ApplyQualityProfileRequestSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

export const ApplyQualityProfileResponseSchema = z.object({
	message: z.string(),
	qualityProfile: z.any(),
	action: z.enum(["created", "updated"]),
});

export type TrashQualityProfile = z.infer<typeof TrashQualityProfileSchema>;
export type GetTrashQualityProfilesResponse = z.infer<typeof GetTrashQualityProfilesResponseSchema>;
export type ApplyQualityProfileRequest = z.infer<typeof ApplyQualityProfileRequestSchema>;
export type ApplyQualityProfileResponse = z.infer<typeof ApplyQualityProfileResponseSchema>;

// ============================================================================
// Tracked CF Groups & Quality Profiles
// ============================================================================

// Tracked CF Group (database record)
export const TrackedCFGroupSchema = z.object({
	id: z.string(),
	serviceInstanceId: z.string(),
	groupFileName: z.string(),
	groupName: z.string(),
	qualityProfileName: z.string().nullable().optional(),
	service: z.enum(["SONARR", "RADARR", "PROWLARR"]),
	importedCount: z.number(),
	lastSyncedAt: z.string(),
	gitRef: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const TrackedCFGroupWithInstanceSchema = TrackedCFGroupSchema.extend({
	instanceLabel: z.string(),
	customFormats: z.array(z.object({
		id: z.string(),
		customFormatId: z.number(),
		customFormatName: z.string(),
		trashId: z.string(),
		lastSyncedAt: z.string(),
	})).optional(),
});

export const GetTrackedCFGroupsResponseSchema = z.object({
	groups: z.array(TrackedCFGroupWithInstanceSchema),
});

export const ResyncCFGroupRequestSchema = z.object({
	instanceId: z.string(),
	groupFileName: z.string(),
	ref: z.string().default("master"),
});

export const ResyncCFGroupResponseSchema = z.object({
	message: z.string(),
	imported: z.number(),
	failed: z.number(),
	results: z.array(z.object({
		trashId: z.string(),
		name: z.string(),
		status: z.enum(["imported", "not_found", "failed"]),
	})),
	groupName: z.string(),
});

export type TrackedCFGroup = z.infer<typeof TrackedCFGroupSchema>;
export type TrackedCFGroupWithInstance = z.infer<typeof TrackedCFGroupWithInstanceSchema>;
export type GetTrackedCFGroupsResponse = z.infer<typeof GetTrackedCFGroupsResponseSchema>;
export type ResyncCFGroupRequest = z.infer<typeof ResyncCFGroupRequestSchema>;
export type ResyncCFGroupResponse = z.infer<typeof ResyncCFGroupResponseSchema>;

// Tracked Quality Profile (database record)
export const TrackedQualityProfileSchema = z.object({
	id: z.string(),
	serviceInstanceId: z.string(),
	profileFileName: z.string(),
	profileName: z.string(),
	qualityProfileId: z.number().nullable(),
	service: z.enum(["SONARR", "RADARR", "PROWLARR"]),
	lastAppliedAt: z.string(),
	gitRef: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const TrackedQualityProfileWithInstanceSchema = TrackedQualityProfileSchema.extend({
	instanceLabel: z.string(),
});

export const GetTrackedQualityProfilesResponseSchema = z.object({
	profiles: z.array(TrackedQualityProfileWithInstanceSchema),
});

export const ReapplyQualityProfileRequestSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	ref: z.string().default("master"),
});

export const ReapplyQualityProfileResponseSchema = z.object({
	message: z.string(),
	qualityProfile: z.any(),
	action: z.enum(["created", "updated"]),
});

export type TrackedQualityProfile = z.infer<typeof TrackedQualityProfileSchema>;
export type TrackedQualityProfileWithInstance = z.infer<typeof TrackedQualityProfileWithInstanceSchema>;
export type GetTrackedQualityProfilesResponse = z.infer<typeof GetTrackedQualityProfilesResponseSchema>;
export type ReapplyQualityProfileRequest = z.infer<typeof ReapplyQualityProfileRequestSchema>;
export type ReapplyQualityProfileResponse = z.infer<typeof ReapplyQualityProfileResponseSchema>;

// Quality Profile Customizations
export const QualityProfileCustomFormatCustomizationSchema = z.object({
	excluded: z.boolean().optional(), // If true, exclude this CF from the profile
	scoreOverride: z.number().optional(), // Override the default score for this CF
	notes: z.string().optional(), // Notes about why this customization was made
});

export const QualityProfileCustomizationsSchema = z.record(
	z.string(), // trashId
	QualityProfileCustomFormatCustomizationSchema,
);

export const UpdateQualityProfileCustomizationsRequestSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	customizations: QualityProfileCustomizationsSchema,
});

export const UpdateQualityProfileCustomizationsResponseSchema = z.object({
	message: z.string(),
	customizations: QualityProfileCustomizationsSchema,
});

export const GetQualityProfileCustomizationsResponseSchema = z.object({
	customizations: QualityProfileCustomizationsSchema,
});

export type QualityProfileCustomFormatCustomization = z.infer<typeof QualityProfileCustomFormatCustomizationSchema>;
export type QualityProfileCustomizations = z.infer<typeof QualityProfileCustomizationsSchema>;
export type UpdateQualityProfileCustomizationsRequest = z.infer<typeof UpdateQualityProfileCustomizationsRequestSchema>;
export type UpdateQualityProfileCustomizationsResponse = z.infer<typeof UpdateQualityProfileCustomizationsResponseSchema>;
export type GetQualityProfileCustomizationsResponse = z.infer<typeof GetQualityProfileCustomizationsResponseSchema>;

// ============================================================================
// Sync Settings & Overrides
// ============================================================================

export const CustomFormatOverrideSchema = z.object({
	enabled: z.boolean().optional(),
	scoreOverride: z.number().optional(),
	addTerms: z.array(z.string()).optional(),
	removeTerms: z.array(z.string()).optional(),
});

export const ArrSyncOverridesSchema = z.object({
	customFormats: z
		.record(z.string(), CustomFormatOverrideSchema)
		.default({}),
	scores: z.record(z.string(), z.number()).default({}), // name → score
	profiles: z
		.record(
			z.string(),
			z.object({
				cutoff: z.number().optional(),
				minFormatScore: z.number().optional(),
				cutoffFormatScore: z.number().optional(),
			}),
		)
		.default({}),
});

export const ArrSyncSettingsSchema = z.object({
	enabled: z.boolean().default(true),
	trashRef: z.string().default("stable"),
	presets: z.array(z.string()).default([]),
	overrides: ArrSyncOverridesSchema.default({}),
});

export type ArrSyncSettings = z.infer<typeof ArrSyncSettingsSchema>;
export type ArrSyncOverrides = z.infer<typeof ArrSyncOverridesSchema>;
export type CustomFormatOverride = z.infer<typeof CustomFormatOverrideSchema>;

// ============================================================================
// Diff & Plan Types
// ============================================================================

export const CustomFormatDiffSchema = z.object({
	name: z.string(),
	existingId: z.number().optional(),
	action: z.enum(["create", "update", "delete", "skip"]),
	changes: z.array(z.string()).default([]),
	current: CustomFormatSchema.optional(),
	desired: CustomFormatSchema.optional(),
});

export const QualityProfileDiffSchema = z.object({
	name: z.string(),
	existingId: z.number().optional(),
	action: z.enum(["create", "update", "skip"]),
	changes: z.array(z.string()).default([]),
	current: QualityProfileSchema.optional(),
	desired: QualityProfileSchema.optional(),
});

export const SyncPlanSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	customFormats: z.object({
		creates: z.array(CustomFormatDiffSchema).default([]),
		updates: z.array(CustomFormatDiffSchema).default([]),
		deletes: z.array(CustomFormatDiffSchema).default([]),
	}),
	qualityProfiles: z.object({
		creates: z.array(QualityProfileDiffSchema).default([]),
		updates: z.array(QualityProfileDiffSchema).default([]),
	}),
	warnings: z.array(z.string()).default([]),
	errors: z.array(z.string()).default([]),
});

export type SyncPlan = z.infer<typeof SyncPlanSchema>;
export type CustomFormatDiff = z.infer<typeof CustomFormatDiffSchema>;
export type QualityProfileDiff = z.infer<typeof QualityProfileDiffSchema>;

// ============================================================================
// Apply Result Types
// ============================================================================

export const ApplyResultSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	success: z.boolean(),
	backupPath: z.string().optional(),
	applied: z.object({
		customFormatsCreated: z.number().default(0),
		customFormatsUpdated: z.number().default(0),
		customFormatsDeleted: z.number().default(0),
		qualityProfilesCreated: z.number().default(0),
		qualityProfilesUpdated: z.number().default(0),
	}),
	errors: z.array(z.string()).default([]),
	warnings: z.array(z.string()).default([]),
	duration: z.number().optional(),
});

export type ApplyResult = z.infer<typeof ApplyResultSchema>;

// ============================================================================
// API Request/Response Types
// ============================================================================

export const PreviewRequestSchema = z.object({
	instanceIds: z.array(z.string()).optional(), // If empty, preview all configured instances
});

export const PreviewResponseSchema = z.object({
	plans: z.array(SyncPlanSchema),
	timestamp: z.string(),
});

export const ApplyRequestSchema = z.object({
	instanceIds: z.array(z.string()).optional(), // If empty, apply to all configured instances
	dryRun: z.boolean().default(false),
});

export const ApplyResponseSchema = z.object({
	results: z.array(ApplyResultSchema),
	timestamp: z.string(),
	totalDuration: z.number().optional(),
});

export const TestConnectionRequestSchema = z.object({
	instanceId: z.string(),
});

export const TestConnectionResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	version: z.string().optional(),
	canManageCustomFormats: z.boolean().default(false),
	canManageQualityProfiles: z.boolean().default(false),
});

export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;
export type ApplyResponse = z.infer<typeof ApplyResponseSchema>;
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>;
export type TestConnectionResponse = z.infer<
	typeof TestConnectionResponseSchema
>;

// ============================================================================
// Settings API Types
// ============================================================================

export const UpsertSettingsRequestSchema = z.object({
	instanceId: z.string(),
	settings: ArrSyncSettingsSchema,
});

export const GetSettingsResponseSchema = z.object({
	settings: z.array(
		z.object({
			instanceId: z.string(),
			instanceLabel: z.string(),
			instanceService: z.enum(["SONARR", "RADARR"]),
			settings: ArrSyncSettingsSchema.nullable(),
		}),
	),
});

export type UpsertSettingsRequest = z.infer<typeof UpsertSettingsRequestSchema>;
export type GetSettingsResponse = z.infer<typeof GetSettingsResponseSchema>;

// ============================================================================
// TRaSH Sync Automation Types (Per-Instance)
// ============================================================================

export const TrashSyncIntervalTypeSchema = z.enum([
	"DISABLED",
	"HOURLY",
	"DAILY",
	"WEEKLY",
]);

export const TrashSyncStatusSchema = z.enum(["SUCCESS", "FAILED", "PARTIAL"]);

export const TrashInstanceSyncSettingsSchema = z.object({
	id: z.string().optional(),
	serviceInstanceId: z.string(),
	enabled: z.boolean(),
	intervalType: TrashSyncIntervalTypeSchema,
	intervalValue: z.number().int().min(1).max(168),

	// What to sync
	syncFormats: z.boolean().default(true),
	syncCFGroups: z.boolean().default(true),
	syncQualityProfiles: z.boolean().default(true),

	// Last run info
	lastRunAt: z.string().nullable(),
	lastRunStatus: TrashSyncStatusSchema.nullable().optional(),
	lastErrorMessage: z.string().nullable().optional(),

	// Last run statistics
	formatsSynced: z.number().default(0),
	formatsFailed: z.number().default(0),
	cfGroupsSynced: z.number().default(0),
	qualityProfilesSynced: z.number().default(0),

	nextRunAt: z.string().nullable(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

export const UpdateTrashInstanceSyncSettingsSchema = z.object({
	enabled: z.boolean(),
	intervalType: TrashSyncIntervalTypeSchema,
	intervalValue: z.number().int().min(1).max(168),
	syncFormats: z.boolean().default(true),
	syncCFGroups: z.boolean().default(true),
	syncQualityProfiles: z.boolean().default(true),
});

export const GetAllTrashSyncSettingsResponseSchema = z.object({
	settings: z.array(TrashInstanceSyncSettingsSchema),
});

export type TrashSyncIntervalType = z.infer<typeof TrashSyncIntervalTypeSchema>;
export type TrashSyncStatus = z.infer<typeof TrashSyncStatusSchema>;
export type TrashInstanceSyncSettings = z.infer<typeof TrashInstanceSyncSettingsSchema>;
export type UpdateTrashInstanceSyncSettings = z.infer<
	typeof UpdateTrashInstanceSyncSettingsSchema
>;
export type GetAllTrashSyncSettingsResponse = z.infer<typeof GetAllTrashSyncSettingsResponseSchema>;
