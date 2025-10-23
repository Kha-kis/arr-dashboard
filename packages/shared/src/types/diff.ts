import { z } from "zod";

/**
 * Diff Preview System Types
 *
 * These types define the structure for previewing changes before applying
 * quality profiles and custom formats to ARR instances.
 */

// ============================================================================
// Custom Format Diff Types
// ============================================================================

export const CFCreateActionSchema = z.object({
	action: z.literal("create"),
	trashId: z.string(),
	name: z.string(),
	source: z.enum(["trash", "manual"]),
	specifications: z.array(z.any()),
});

export const CFUpdateActionSchema = z.object({
	action: z.literal("update"),
	id: z.number(),
	trashId: z.string().optional(),
	name: z.string(),
	changes: z.array(z.string()), // Human-readable descriptions of changes
	oldValue: z.any().optional(),
	newValue: z.any().optional(),
});

export const CFDeleteActionSchema = z.object({
	action: z.literal("delete"),
	id: z.number(),
	name: z.string(),
	reason: z.string(), // Why it's being deleted (e.g., "Excluded from overlay", "Removed from TRaSH")
	source: z.enum(["trash", "manual"]),
});

export const CFNoChangeActionSchema = z.object({
	action: z.literal("no_change"),
	id: z.number(),
	trashId: z.string().optional(),
	name: z.string(),
});

// ============================================================================
// Quality Profile Diff Types
// ============================================================================

export const ScoreChangeSchema = z.object({
	customFormat: z.string(), // CF name
	customFormatId: z.number().optional(),
	trashId: z.string().optional(),
	oldScore: z.number(),
	newScore: z.number(),
});

export const QualityProfileChangeSchema = z.object({
	cutoff: z.object({
		old: z.string(),
		new: z.string(),
	}).optional(),
	minFormatScore: z.object({
		old: z.number(),
		new: z.number(),
	}).optional(),
	cutoffFormatScore: z.object({
		old: z.number(),
		new: z.number(),
	}).optional(),
	scoreChanges: z.array(ScoreChangeSchema),
	qualityItems: z.object({
		added: z.array(z.string()),
		removed: z.array(z.string()),
		changed: z.array(z.string()),
	}).optional(),
});

export const QualityProfileActionSchema = z.object({
	action: z.enum(["create", "update", "no_change"]),
	id: z.number().optional(), // Only present for update/no_change
	name: z.string(),
	changes: QualityProfileChangeSchema.optional(), // Only present for update
});

// ============================================================================
// Complete Diff Plan
// ============================================================================

export const DiffPlanSchema = z.object({
	// Custom Format changes
	customFormats: z.object({
		create: z.array(CFCreateActionSchema),
		update: z.array(CFUpdateActionSchema),
		delete: z.array(CFDeleteActionSchema),
		noChange: z.array(CFNoChangeActionSchema),
	}),

	// Quality Profile changes
	qualityProfile: QualityProfileActionSchema,

	// Summary statistics
	summary: z.object({
		totalChanges: z.number(),
		customFormatsCreated: z.number(),
		customFormatsUpdated: z.number(),
		customFormatsDeleted: z.number(),
		scoreChanges: z.number(),
		profileChanged: z.boolean(),
	}),

	// Version information
	version: z.object({
		commitSha: z.string(),
		commitMessage: z.string().optional(),
		fetchedAt: z.string(),
	}).optional(),

	// Hash for staleness detection
	hash: z.string(), // SHA-256 of the diff plan
});

// ============================================================================
// Preview Request/Response
// ============================================================================

export const PreviewQualityProfileRequestSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	ref: z.string().default("master"),
	customizations: z.object({
		excludedCFs: z.array(z.string()).optional(), // TRaSH IDs to exclude
		scoreOverrides: z.record(z.string(), z.number()).optional(), // trashId → score
		minFormatScore: z.number().optional(),
		cutoffFormatScore: z.number().optional(),
	}).optional(),
});

export const PreviewQualityProfileResponseSchema = z.object({
	success: z.boolean(),
	diffPlan: DiffPlanSchema.optional(),
	error: z.string().optional(),
	warnings: z.array(z.string()).optional(),
});

// ============================================================================
// Apply with Validation
// ============================================================================

export const ApplyWithValidationRequestSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	ref: z.string().default("master"),
	customizations: z.object({
		excludedCFs: z.array(z.string()).optional(),
		scoreOverrides: z.record(z.string(), z.number()).optional(),
		minFormatScore: z.number().optional(),
		cutoffFormatScore: z.number().optional(),
	}).optional(),
	expectedHash: z.string(), // Must match current diff plan hash
});

export const ApplyWithValidationResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	action: z.enum(["created", "updated"]),
	qualityProfileId: z.number().optional(),
	appliedChanges: z.object({
		customFormatsCreated: z.number(),
		customFormatsUpdated: z.number(),
		customFormatsDeleted: z.number(),
		scoreChanges: z.number(),
	}),
	error: z.string().optional(),
	hashMismatch: z.boolean().optional(), // True if hash validation failed
});

// ============================================================================
// Type Exports
// ============================================================================

export type CFCreateAction = z.infer<typeof CFCreateActionSchema>;
export type CFUpdateAction = z.infer<typeof CFUpdateActionSchema>;
export type CFDeleteAction = z.infer<typeof CFDeleteActionSchema>;
export type CFNoChangeAction = z.infer<typeof CFNoChangeActionSchema>;

export type ScoreChange = z.infer<typeof ScoreChangeSchema>;
export type QualityProfileChange = z.infer<typeof QualityProfileChangeSchema>;
export type QualityProfileAction = z.infer<typeof QualityProfileActionSchema>;

export type DiffPlan = z.infer<typeof DiffPlanSchema>;
export type PreviewQualityProfileRequest = z.infer<typeof PreviewQualityProfileRequestSchema>;
export type PreviewQualityProfileResponse = z.infer<typeof PreviewQualityProfileResponseSchema>;
export type ApplyWithValidationRequest = z.infer<typeof ApplyWithValidationRequestSchema>;
export type ApplyWithValidationResponse = z.infer<typeof ApplyWithValidationResponseSchema>;
