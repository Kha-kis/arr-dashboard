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

export const QualityProfileItemSchema = z.object({
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
	name: z.string(),
	format: z.number().optional(),
	score: z.number(),
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
