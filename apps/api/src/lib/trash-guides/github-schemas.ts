/**
 * Zod schemas for validating TRaSH Guides GitHub JSON data.
 *
 * These schemas validate data at the fetch boundary — when raw JSON is
 * retrieved from GitHub. All schemas use z.looseObject() to tolerate
 * new fields TRaSH may add without breaking validation.
 */

import { z } from "zod";

// Re-export for backward compatibility — existing callers import from here
export {
	validateAndCollect,
	type ValidationResult,
	type ValidationStats,
	type ValidationMode,
	type ValidateOptions,
	type Logger,
} from "../validation/validate-batch.js";

// Local import for use in this file
import type { ValidationStats } from "../validation/validate-batch.js";

// ============================================================================
// Shared Primitives
// ============================================================================

/**
 * TRaSH ID: lowercase hex string (32 chars typical).
 * .transform() normalizes to lowercase at ingestion to prevent
 * case-mismatch bugs when joining across CF groups and profiles.
 */
const trashIdSchema = z.string().transform((v) => v.toLowerCase());

// ============================================================================
// Custom Format Schema (cf/*.json)
// ============================================================================

const customFormatSpecificationSchema = z.looseObject({
	name: z.string(),
	implementation: z.string(),
	negate: z.boolean(),
	required: z.boolean(),
	fields: z.record(z.string(), z.unknown()),
});

export const trashCustomFormatSchema = z.looseObject({
	trash_id: trashIdSchema,
	name: z.string(),
	score: z.number().optional(),
	trash_scores: z.record(z.string(), z.number()).optional(),
	trash_description: z.string().optional(),
	trash_url: z.string().optional(),
	includeCustomFormatWhenRenaming: z.boolean().optional(),
	specifications: z.array(customFormatSpecificationSchema),
});

// ============================================================================
// Custom Format Group Schema (cf-groups/*.json)
// ============================================================================

const groupCustomFormatSchema = z.union([
	z.looseObject({
		name: z.string(),
		trash_id: trashIdSchema,
		required: z.boolean(),
		default: z.union([z.string(), z.boolean()]).optional(),
	}),
	z.string(),
]);

export const trashCustomFormatGroupSchema = z.looseObject({
	trash_id: trashIdSchema,
	name: z.string(),
	trash_description: z.string().optional(),
	default: z.union([z.string(), z.boolean()]).optional(),
	required: z.boolean().optional(),
	custom_formats: z.array(groupCustomFormatSchema),
	quality_profiles: z
		.looseObject({
			include: z.record(z.string(), z.string()).optional(),
			exclude: z.record(z.string(), z.string()).optional(),
			score: z.number().optional(),
		})
		.optional(),
});

// ============================================================================
// Quality Size Schema (quality-size/*.json)
// ============================================================================

const qualitySizeQualitySchema = z.looseObject({
	quality: z.string(),
	min: z.number(),
	preferred: z.number(),
	max: z.number(),
});

export const trashQualitySizeSchema = z.looseObject({
	trash_id: trashIdSchema,
	type: z.string(),
	qualities: z.array(qualitySizeQualitySchema),
});

// ============================================================================
// Naming Schema (naming/*.json)
// ============================================================================

/**
 * Validates the core fields of TrashNamingScheme. Uses looseObject to
 * tolerate additional fields TRaSH may add (Feature 2 will extend this).
 */
export const trashNamingSchemeSchema = z.looseObject({
	type: z.enum(["movie", "series"]),
	standard: z.string().optional(),
	folder: z.string().optional(),
	season_folder: z.string().optional(),
});

/**
 * Radarr naming JSON: { folder: Record<presetName, formatString>, file: Record<presetName, formatString> }
 * The .transform() injects the _service discriminant so z.infer matches TrashRadarrNaming.
 */
export const radarrNamingSchema = z
	.looseObject({
		folder: z.record(z.string(), z.string()),
		file: z.record(z.string(), z.string()),
	})
	.transform((data) => ({ ...data, _service: "RADARR" as const }));

/**
 * Sonarr naming JSON: { season, series, episodes: { standard, daily, anime } }
 * The .transform() injects the _service discriminant so z.infer matches TrashSonarrNaming.
 */
export const sonarrNamingSchema = z
	.looseObject({
		season: z.record(z.string(), z.string()),
		series: z.record(z.string(), z.string()),
		episodes: z.looseObject({
			standard: z.record(z.string(), z.string()),
			daily: z.record(z.string(), z.string()),
			anime: z.record(z.string(), z.string()),
		}),
	})
	.transform((data) => ({ ...data, _service: "SONARR" as const }));

// ============================================================================
// ARR Naming Config Response Schema (/api/v3/config/naming)
// ============================================================================

/**
 * Validates the response from Sonarr/Radarr's /api/v3/config/naming endpoint.
 * Uses z.looseObject() to preserve all unknown fields — critical for the
 * merge-and-PUT pattern where we overlay our changes onto the full config.
 *
 * Only validates fields we actively use: `id` (required for PUT) and
 * the optional rename toggles + format strings.
 */
export const arrNamingConfigSchema = z.looseObject({
	id: z.number(),
	// Radarr fields
	renameMovies: z.boolean().optional(),
	standardMovieFormat: z.string().optional(),
	movieFolderFormat: z.string().optional(),
	// Sonarr fields
	renameEpisodes: z.boolean().optional(),
	standardEpisodeFormat: z.string().optional(),
	dailyEpisodeFormat: z.string().optional(),
	animeEpisodeFormat: z.string().optional(),
	seriesFolderFormat: z.string().optional(),
	seasonFolderFormat: z.string().optional(),
});

export type ArrNamingConfig = z.infer<typeof arrNamingConfigSchema>;

// ============================================================================
// Quality Profile Schema (quality-profiles/*.json)
// ============================================================================

export const trashQualityProfileSchema = z.looseObject({
	trash_id: trashIdSchema,
	name: z.string(),
	trash_score_set: z.string().optional(),
	trash_description: z.string().optional(),
	trash_url: z.string().optional(),
	visible: z.string().optional(),
	group: z.number().optional(),
	upgradeAllowed: z.boolean(),
	cutoff: z.string(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	minUpgradeFormatScore: z.number().optional(),
	language: z.string().optional(),
	items: z.array(
		z.looseObject({
			name: z.string(),
			allowed: z.boolean(),
			items: z.array(z.string()).optional(),
		}),
	),
	formatItems: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Quality Profile Groups Schema (quality-profile-groups/groups.json)
// ============================================================================

export const trashQualityProfileGroupSchema = z.looseObject({
	name: z.string(),
	profiles: z.record(z.string(), z.string()),
});

// ============================================================================
// Validation Stats Accumulator (delegates to IntegrationHealthRegistry)
// ============================================================================

import { integrationHealth, type IntegrationHealth } from "../validation/integration-health.js";

const TRASH_INTEGRATION = "trash-guides";

/** Aggregated validation health stats across all data types */
export type CacheValidationHealth = IntegrationHealth;

/** Reset stats before a new fetch cycle */
export function resetValidationHealth(): void {
	integrationHealth.resetIntegration(TRASH_INTEGRATION);
}

/** Record stats for a data category (e.g., "customFormats", "qualityProfiles") */
export function recordValidationStats(category: string, stats: ValidationStats): void {
	integrationHealth.record(TRASH_INTEGRATION, category, stats);
}

/** Get current validation health snapshot */
export function getValidationHealth(): CacheValidationHealth {
	return (
		integrationHealth.getByIntegration(TRASH_INTEGRATION) ?? {
			lastRefreshAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			consecutiveFailures: 0,
			state: "healthy" as const,
			categories: {},
			totals: { total: 0, validated: 0, rejected: 0 },
		}
	);
}
