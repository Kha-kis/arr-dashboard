/**
 * Zod schemas for validating TRaSH Guides GitHub JSON data.
 *
 * These schemas validate data at the fetch boundary — when raw JSON is
 * retrieved from GitHub. All schemas use z.looseObject() to tolerate
 * new fields TRaSH may add without breaking validation.
 */

import { z } from "zod";

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
// Validation Helper
// ============================================================================

interface Logger {
	warn: (msg: string | object, ...args: unknown[]) => void;
	error: (msg: string | object, ...args: unknown[]) => void;
}

/** Validation stats returned alongside validated items */
export interface ValidationStats {
	total: number;
	validated: number;
	rejected: number;
}

/** Result of validateAndCollect — items array + validation stats */
export interface ValidationResult<T> {
	items: T[];
	stats: ValidationStats;
}

/**
 * Validate raw GitHub JSON data against a Zod schema.
 *
 * Handles both single-item and array responses (flattens to array).
 * Invalid items are logged and skipped — one bad item doesn't break the batch.
 * Escalates to error-level when all items fail or rejection rate exceeds 50%.
 */
export function validateAndCollect<T>(
	rawData: unknown,
	schema: z.ZodType<T>,
	fileName: string,
	log: Logger,
): ValidationResult<T> {
	const items = Array.isArray(rawData) ? rawData : [rawData];
	const results: T[] = [];

	for (let i = 0; i < items.length; i++) {
		const result = schema.safeParse(items[i]);
		if (result.success) {
			results.push(result.data);
		} else {
			log.warn(
				`Skipping invalid item ${i} in ${fileName}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")}`,
			);
		}
	}

	const rejected = items.length - results.length;
	if (items.length > 0 && results.length === 0) {
		log.error(
			`All ${items.length} items failed validation in ${fileName} — upstream schema may have changed`,
		);
	} else if (items.length > 1 && rejected > items.length / 2) {
		log.warn(
			`High rejection rate in ${fileName}: ${rejected}/${items.length} items failed validation`,
		);
	}

	return { items: results, stats: { total: items.length, validated: results.length, rejected } };
}

// ============================================================================
// Validation Stats Accumulator
// ============================================================================

/** Aggregated validation health stats across all data types */
export interface CacheValidationHealth {
	lastRefreshAt: string | null;
	categories: Record<string, ValidationStats>;
	totals: ValidationStats;
}

let lastHealth: CacheValidationHealth = {
	lastRefreshAt: null,
	categories: {},
	totals: { total: 0, validated: 0, rejected: 0 },
};

/** Reset stats before a new fetch cycle */
export function resetValidationHealth(): void {
	lastHealth = {
		lastRefreshAt: new Date().toISOString(),
		categories: {},
		totals: { total: 0, validated: 0, rejected: 0 },
	};
}

/** Record stats for a data category (e.g., "customFormats", "qualityProfiles") */
export function recordValidationStats(category: string, stats: ValidationStats): void {
	const existing = lastHealth.categories[category];
	if (existing) {
		existing.total += stats.total;
		existing.validated += stats.validated;
		existing.rejected += stats.rejected;
	} else {
		lastHealth.categories[category] = { ...stats };
	}
	lastHealth.totals.total += stats.total;
	lastHealth.totals.validated += stats.validated;
	lastHealth.totals.rejected += stats.rejected;
}

/** Get current validation health snapshot */
export function getValidationHealth(): CacheValidationHealth {
	return lastHealth;
}
