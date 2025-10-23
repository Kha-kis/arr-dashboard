/**
 * Profiles System - Domain Types
 *
 * Unified types for template-based Custom Format and Quality Profile management
 */

import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

export const TemplateTypeSchema = z.enum([
	"CUSTOM_FORMAT",
	"CF_GROUP",
	"QUALITY_PROFILE",
]);

export const TemplateSourceSchema = z.enum(["TRASH", "RECYCLARR", "CUSTOM"]);

export const OverrideScopeTypeSchema = z.enum([
	"GLOBAL",
	"INSTANCE",
	"LIBRARY",
	"TAG",
]);

export const BindingStatusSchema = z.enum(["PENDING", "APPLIED", "ERROR"]);

export type TemplateType = z.infer<typeof TemplateTypeSchema>;
export type TemplateSource = z.infer<typeof TemplateSourceSchema>;
export type OverrideScopeType = z.infer<typeof OverrideScopeTypeSchema>;
export type BindingStatus = z.infer<typeof BindingStatusSchema>;

// ============================================================================
// Domain Models
// ============================================================================

/**
 * ProfileTemplate - Base specification from TRaSH, Recyclarr, or custom
 */
export const ProfileTemplateSchema = z.object({
	id: z.string(),
	type: TemplateTypeSchema,
	source: TemplateSourceSchema,
	sourceRef: z.string(),
	name: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	bodyJson: z.string(), // Stringified JSON
	version: z.string().optional(),
	gitRef: z.string().default("master"),
	createdAt: z.date(),
	updatedAt: z.date(),
	lastSyncedAt: z.date().optional(),
});

export type ProfileTemplate = z.infer<typeof ProfileTemplateSchema>;

/**
 * ProfileOverride - Scoped patch layered on templates
 */
export const ProfileOverrideSchema = z.object({
	id: z.string(),
	scopeType: OverrideScopeTypeSchema,
	scopeRef: z.string().optional(),
	templateId: z.string().optional(),
	cfIdentifier: z.string(),
	priority: z.number().default(100),
	patchJson: z.string(), // Stringified JSON patch
	enabled: z.boolean().default(true),
	notes: z.string().optional(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type ProfileOverride = z.infer<typeof ProfileOverrideSchema>;

/**
 * Profile - Effective composition cache (Template ⊕ Overrides)
 */
export const ProfileSchema = z.object({
	id: z.string(),
	name: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	templateId: z.string(),
	overrideIds: z.string(), // JSON array of override IDs
	effectiveJson: z.string(), // Stringified composed spec
	effectiveHash: z.string(), // SHA-256
	computedAt: z.date(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * ProfileBinding - Instance application tracking
 */
export const ProfileBindingSchema = z.object({
	id: z.string(),
	profileId: z.string(),
	serviceInstanceId: z.string(),
	status: BindingStatusSchema,
	lastAppliedAt: z.date().optional(),
	lastAppliedHash: z.string().optional(),
	errorMessage: z.string().optional(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type ProfileBinding = z.infer<typeof ProfileBindingSchema>;

// ============================================================================
// API DTOs
// ============================================================================

/**
 * Import Template Request
 */
export const ImportTemplateRequestSchema = z.object({
	source: z.enum(["TRASH", "RECYCLARR"]),
	sourceRef: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	gitRef: z.string().default("master"),
});

export type ImportTemplateRequest = z.infer<typeof ImportTemplateRequestSchema>;

/**
 * Create Override Request
 */
export const CreateOverrideRequestSchema = z.object({
	scopeType: OverrideScopeTypeSchema,
	scopeRef: z.string().optional(),
	templateId: z.string().optional(),
	cfIdentifier: z.string(),
	priority: z.number().default(100),
	patch: z.record(z.any()), // Will be stringified to patchJson
	notes: z.string().optional(),
});

export type CreateOverrideRequest = z.infer<typeof CreateOverrideRequestSchema>;

/**
 * Create Profile Request
 */
export const CreateProfileRequestSchema = z.object({
	name: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	templateId: z.string(),
	overrideIds: z.array(z.string()).default([]),
});

export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

/**
 * Preview Profile Request
 */
export const PreviewProfileRequestSchema = z.object({
	profileId: z.string(),
	instanceIds: z.array(z.string()),
});

export type PreviewProfileRequest = z.infer<typeof PreviewProfileRequestSchema>;

/**
 * Preview Profile Response
 */
export const PreviewProfileResponseSchema = z.object({
	previews: z.array(
		z.object({
			instanceId: z.string(),
			instanceLabel: z.string(),
			diff: z.object({
				added: z.array(z.any()),
				modified: z.array(z.any()),
				removed: z.array(z.any()),
				unchanged: z.array(z.any()),
			}),
			warnings: z.array(z.string()),
		}),
	),
});

export type PreviewProfileResponse = z.infer<typeof PreviewProfileResponseSchema>;

/**
 * Apply Profile Request
 */
export const ApplyProfileRequestSchema = z.object({
	profileId: z.string(),
	instanceIds: z.array(z.string()),
});

export type ApplyProfileRequest = z.infer<typeof ApplyProfileRequestSchema>;

/**
 * Apply Profile Response
 */
export const ApplyProfileResponseSchema = z.object({
	results: z.array(
		z.object({
			instanceId: z.string(),
			success: z.boolean(),
			message: z.string(),
			applied: z.number(),
			failed: z.number(),
		}),
	),
});

export type ApplyProfileResponse = z.infer<typeof ApplyProfileResponseSchema>;

// ============================================================================
// New Unified Profiles API Types (Phase 2)
// ============================================================================

/**
 * Custom Format (ARR API format)
 */
export const CustomFormatSchema = z.object({
	id: z.number().optional(),
	name: z.string(),
	includeCustomFormatWhenRenaming: z.boolean().optional(),
	specifications: z.array(z.any()).optional(),
	trash_id: z.string().optional(),
	trash_scores: z.record(z.number()).optional(),
	trash_description: z.string().optional(),
});

export type CustomFormat = z.infer<typeof CustomFormatSchema>;

/**
 * Template (Profile with source=TRASH)
 */
export const TemplateMetadataSchema = z.object({
	id: z.string(),
	name: z.string(),
	type: z.enum(["CUSTOM_FORMAT_GROUP", "QUALITY_PROFILE"]),
	service: z.enum(["RADARR", "SONARR"]).optional(),
	source: z.literal("TRASH"),
	description: z.string().optional(),
	version: z.string().optional(),
	cfCount: z.number().optional(),
});

export type TemplateMetadata = z.infer<typeof TemplateMetadataSchema>;

export const GetTemplatesResponseSchema = z.object({
	templates: z.array(TemplateMetadataSchema),
});

export type GetTemplatesResponse = z.infer<typeof GetTemplatesResponseSchema>;

export const GetTemplateDetailResponseSchema = z.object({
	template: TemplateMetadataSchema,
	customFormats: z.array(CustomFormatSchema).optional(),
});

export type GetTemplateDetailResponse = z.infer<
	typeof GetTemplateDetailResponseSchema
>;

/**
 * Overlay Configuration
 */
export const CfOverrideSchemaV2 = z.object({
	name: z.string().optional(),
	score: z.number().int().optional(),
	tags: z.array(z.string()).optional(),
});

export type CfOverrideV2 = z.infer<typeof CfOverrideSchemaV2>;

export const OverlayConfigSchema = z.object({
	includes: z.array(z.string()).default([]),
	excludes: z.array(z.string()).default([]),
	overrides: z.record(CfOverrideSchemaV2).default({}),
});

export type OverlayConfig = z.infer<typeof OverlayConfigSchema>;

export const GetOverlayResponseSchema = OverlayConfigSchema;

export type GetOverlayResponse = z.infer<typeof GetOverlayResponseSchema>;

export const UpdateOverlayResponseSchema = z.object({
	message: z.string(),
	includes: z.array(z.string()),
	excludes: z.array(z.string()),
	overrides: z.record(CfOverrideSchemaV2),
});

export type UpdateOverlayResponse = z.infer<typeof UpdateOverlayResponseSchema>;

/**
 * Preview
 */
export const PreviewRequestSchemaV2 = z.object({
	includes: z.array(z.string()).optional(),
	excludes: z.array(z.string()).optional(),
	overrides: z.record(CfOverrideSchemaV2).optional(),
});

export type PreviewRequestV2 = z.infer<typeof PreviewRequestSchemaV2>;

export const DiffChangeSchema = z.object({
	id: z.string(),
	changeType: z.string(),
	description: z.string().optional(),
});

export type DiffChange = z.infer<typeof DiffChangeSchema>;

export const PreviewDiffSchema = z.object({
	added: z.array(z.string()),
	removed: z.array(z.string()),
	changed: z.array(DiffChangeSchema),
});

export type PreviewDiff = z.infer<typeof PreviewDiffSchema>;

export const PreviewResponseSchemaV2 = z.object({
	hash: z.string(),
	diff: PreviewDiffSchema,
	effective: z.array(CustomFormatSchema),
	warnings: z.array(z.string()),
	instanceId: z.string(),
	instanceLabel: z.string(),
});

export type PreviewResponseV2 = z.infer<typeof PreviewResponseSchemaV2>;

/**
 * Apply
 */
export const ApplyRequestSchemaV2 = z.object({
	hash: z.string(),
	dryRun: z.boolean().optional(),
});

export type ApplyRequestV2 = z.infer<typeof ApplyRequestSchemaV2>;

export const ApplyResponseSchemaV2 = z.object({
	success: z.boolean(),
	instanceId: z.string(),
	instanceLabel: z.string(),
	applied: z.object({
		created: z.number(),
		updated: z.number(),
	}),
	errors: z.array(z.string()),
	message: z.string(),
});

export type ApplyResponseV2 = z.infer<typeof ApplyResponseSchemaV2>;

/**
 * Effective Profile
 */
export const EffectiveProfileResponseSchema = z.object({
	profileId: z.string(),
	hash: z.string(),
	effective: z.array(CustomFormatSchema),
	includes: z.array(z.string()),
	excludes: z.array(z.string()),
	overrides: z.record(CfOverrideSchemaV2),
	lastAppliedAt: z.string().nullable(),
});

export type EffectiveProfileResponse = z.infer<
	typeof EffectiveProfileResponseSchema
>;

// ============================================================================
// Quality Profiles V2 (Unified Interface)
// ============================================================================

/**
 * Quality Profile from ARR instance
 */
export const QualityProfileSchema = z.object({
	id: z.number(),
	name: z.string(),
	upgradeAllowed: z.boolean(),
	cutoff: z.number(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	formatItems: z
		.array(
			z.object({
				format: z.number(),
				name: z.string().optional(),
				score: z.number(),
			}),
		)
		.optional(),
});

export type QualityProfile = z.infer<typeof QualityProfileSchema>;

/**
 * Enriched Custom Format with score
 */
export const EnrichedCustomFormatSchema = z.object({
	id: z.number(),
	name: z.string(),
	score: z.number(),
	specifications: z.array(z.any()).optional(),
	trash_id: z.string().optional(),
});

export type EnrichedCustomFormat = z.infer<typeof EnrichedCustomFormatSchema>;

/**
 * Quality Profile Detail Response
 */
export const QualityProfileDetailSchema = z.object({
	id: z.number(),
	name: z.string(),
	upgradeAllowed: z.boolean(),
	cutoff: z.number(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	formatItems: z.array(EnrichedCustomFormatSchema),
});

export type QualityProfileDetail = z.infer<typeof QualityProfileDetailSchema>;

/**
 * Overlay Configuration Status
 */
export const OverlayConfigStatusSchema = z.object({
	includes: z.array(z.string()),
	excludes: z.array(z.string()),
	overrides: z.record(CfOverrideSchemaV2),
	state: z.enum(["PREVIEW", "APPLIED"]),
	lastAppliedAt: z.string().nullable(),
	lastPreviewHash: z.string().nullable(),
});

export type OverlayConfigStatus = z.infer<typeof OverlayConfigStatusSchema>;

/**
 * Quality Profiles List Response (for an instance)
 */
export const QualityProfilesListResponseSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	service: z.enum(["RADARR", "SONARR"]),
	qualityProfiles: z.array(QualityProfileSchema),
	customFormats: z.array(CustomFormatSchema),
	overlayConfig: OverlayConfigStatusSchema.nullable(),
});

export type QualityProfilesListResponse = z.infer<
	typeof QualityProfilesListResponseSchema
>;

/**
 * Quality Profile Detail Response (specific profile)
 */
export const QualityProfileDetailResponseSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	profile: QualityProfileDetailSchema,
});

export type QualityProfileDetailResponse = z.infer<
	typeof QualityProfileDetailResponseSchema
>;
