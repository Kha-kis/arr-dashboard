import { z } from "zod";

/**
 * Custom Formats - Template Overlay System
 * Zod schemas for template-based CF management
 */

// ============================================================================
// Custom Format Override Types
// ============================================================================

/**
 * Quality Profile Link Override
 * Allows overriding CF score in specific quality profiles
 */
export const QualityProfileLinkOverrideSchema = z.object({
	profileId: z.string(),
	score: z.number().int().optional(),
});

export type QualityProfileLinkOverride = z.infer<
	typeof QualityProfileLinkOverrideSchema
>;

/**
 * Per-CF Override
 * Allows patching individual custom format properties
 */
export const CfOverrideSchema = z.object({
	name: z.string().optional(),
	score: z.number().int().optional(),
	tags: z.array(z.string()).optional(),
	spec: z.record(z.any()).optional(), // Specification overrides (deep patch)
	qualityProfileLinks: z
		.array(QualityProfileLinkOverrideSchema)
		.optional(),
});

export type CfOverride = z.infer<typeof CfOverrideSchema>;

// ============================================================================
// Template Overlay DTO
// ============================================================================

/**
 * Template Overlay DTO
 * Defines which templates to include, what to exclude, and per-CF overrides
 */
export const TemplateOverlayDtoSchema = z.object({
	includes: z.array(z.string()).default([]), // Template IDs (e.g. ["trash-anime", "trash-x265"])
	excludes: z.array(z.string()).default([]), // CF trash_id or local ID to skip
	overrides: z.record(CfOverrideSchema).default({}), // Keyed by CF trash_id or local ID
});

export type TemplateOverlayDto = z.infer<typeof TemplateOverlayDtoSchema>;

// ============================================================================
// Template Preview & Apply
// ============================================================================

/**
 * Change Type for Template Diff
 */
export const TemplateChangeTypeSchema = z.enum([
	"added",
	"removed",
	"modified",
	"unchanged",
]);

export type TemplateChangeType = z.infer<typeof TemplateChangeTypeSchema>;

/**
 * Custom Format Change Detail
 */
export const CfChangeSchema = z.object({
	cfId: z.string(), // trash_id or local ID
	name: z.string(),
	changeType: TemplateChangeTypeSchema,
	changes: z.array(z.string()).default([]), // Human-readable change descriptions
	before: z.any().optional(), // Previous CF state (if modified/removed)
	after: z.any().optional(), // New CF state (if added/modified)
});

export type CfChange = z.infer<typeof CfChangeSchema>;

/**
 * Template Preview Request
 */
export const TemplatePreviewRequestSchema = z.object({
	includes: z.array(z.string()).default([]),
	excludes: z.array(z.string()).default([]),
	overrides: z.record(CfOverrideSchema).default({}),
});

export type TemplatePreviewRequest = z.infer<
	typeof TemplatePreviewRequestSchema
>;

/**
 * Template Preview Response
 */
export const TemplatePreviewResponseSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	changes: z.array(CfChangeSchema),
	resolvedCfs: z.array(z.any()), // Final merged CF set
	warnings: z.array(z.string()).default([]),
	errors: z.array(z.string()).default([]),
});

export type TemplatePreviewResponse = z.infer<
	typeof TemplatePreviewResponseSchema
>;

/**
 * Template Apply Request
 */
export const TemplateApplyRequestSchema = z.object({
	includes: z.array(z.string()).default([]),
	excludes: z.array(z.string()).default([]),
	overrides: z.record(CfOverrideSchema).default({}),
	dryRun: z.boolean().default(false),
});

export type TemplateApplyRequest = z.infer<typeof TemplateApplyRequestSchema>;

/**
 * Template Apply Response
 */
export const TemplateApplyResponseSchema = z.object({
	instanceId: z.string(),
	instanceLabel: z.string(),
	success: z.boolean(),
	applied: z.object({
		created: z.number().default(0),
		updated: z.number().default(0),
		deleted: z.number().default(0),
	}),
	backupPath: z.string().optional(),
	errors: z.array(z.string()).default([]),
	warnings: z.array(z.string()).default([]),
	duration: z.number().optional(),
});

export type TemplateApplyResponse = z.infer<typeof TemplateApplyResponseSchema>;

// ============================================================================
// Template Overlay Get/Update
// ============================================================================

/**
 * Get Template Overlay Response
 */
export const GetTemplateOverlayResponseSchema = z.object({
	overlay: TemplateOverlayDtoSchema.nullable(),
	lastAppliedAt: z.string().nullable(),
});

export type GetTemplateOverlayResponse = z.infer<
	typeof GetTemplateOverlayResponseSchema
>;

/**
 * Update Template Overlay Request
 */
export const UpdateTemplateOverlayRequestSchema = TemplateOverlayDtoSchema;

export type UpdateTemplateOverlayRequest = z.infer<
	typeof UpdateTemplateOverlayRequestSchema
>;

/**
 * Update Template Overlay Response
 */
export const UpdateTemplateOverlayResponseSchema = z.object({
	message: z.string(),
	overlay: TemplateOverlayDtoSchema,
});

export type UpdateTemplateOverlayResponse = z.infer<
	typeof UpdateTemplateOverlayResponseSchema
>;
