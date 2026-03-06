/**
 * Naming Deployer Service
 *
 * Pure-function module for extracting presets from TRaSH naming data,
 * resolving API payloads, building previews, and computing hashes.
 *
 * All functions use discriminated union types (NamingSelectedPresets,
 * TrashNamingData) — callers narrow with `.serviceType` / `._service`.
 */

import { createHash } from "node:crypto";
import type {
	NamingFieldComparison,
	NamingPreset,
	NamingPresetsResponse,
	NamingPreviewResult,
	NamingSelectedPresets,
	RadarrSelectedPresets,
	SonarrSelectedPresets,
	TrashNamingData,
	TrashRadarrNaming,
	TrashSonarrNaming,
} from "@arr/shared";

// ============================================================================
// ARR API Payload Types
// ============================================================================

/**
 * Radarr /api/v3/config/naming response/request shape (relevant fields).
 * @internal — scoped to this module; not exported to shared package.
 */
export interface RadarrNamingPayload {
	renameMovies: boolean;
	standardMovieFormat: string;
	movieFolderFormat: string;
	[key: string]: unknown;
}

/**
 * Sonarr /api/v3/config/naming response/request shape (relevant fields).
 * @internal — scoped to this module; not exported to shared package.
 */
export interface SonarrNamingPayload {
	renameEpisodes: boolean;
	standardEpisodeFormat: string;
	dailyEpisodeFormat: string;
	animeEpisodeFormat: string;
	seriesFolderFormat: string;
	seasonFolderFormat: string;
	[key: string]: unknown;
}

// ============================================================================
// Preset Extraction
// ============================================================================

function recordToPresets(record: Record<string, string>): NamingPreset[] {
	return Object.entries(record).map(([name, formatString]) => ({
		name,
		formatString,
	}));
}

/**
 * Extract available presets from naming data.
 * Returns a discriminated union response — narrow with `response.serviceType`.
 */
export function extractPresets(naming: TrashNamingData): NamingPresetsResponse {
	if (naming._service === "RADARR") {
		return {
			serviceType: "RADARR",
			filePresets: recordToPresets(naming.file),
			folderPresets: recordToPresets(naming.folder),
		};
	}
	return {
		serviceType: "SONARR",
		standardEpisodePresets: recordToPresets(naming.episodes.standard),
		dailyEpisodePresets: recordToPresets(naming.episodes.daily),
		animeEpisodePresets: recordToPresets(naming.episodes.anime),
		seriesFolderPresets: recordToPresets(naming.series),
		seasonFolderPresets: recordToPresets(naming.season),
	};
}

// ============================================================================
// Payload Resolution
// ============================================================================

/**
 * Look up a preset value from a record, throwing if the user selected a
 * preset name that no longer exists in the naming data (stale data).
 */
function requirePresetValue(
	record: Record<string, string>,
	presetName: string,
	fieldLabel: string,
): string {
	const value = record[presetName];
	if (value === undefined) {
		throw new Error(`Selected ${fieldLabel} preset "${presetName}" not found in naming data`);
	}
	return value;
}

/**
 * Resolve selected presets into a partial Radarr naming API payload.
 * Throws if a selected preset name is not found in the naming data.
 *
 * @param enableRename - When true, sets renameMovies=true. When false, sets renameMovies=false.
 *   When undefined, omits the field (preserving the instance's current value).
 */
export function resolveRadarrPayload(
	naming: TrashRadarrNaming,
	selected: RadarrSelectedPresets,
	enableRename?: boolean,
): Partial<RadarrNamingPayload> {
	const payload: Partial<RadarrNamingPayload> = {};

	if (selected.filePreset) {
		payload.standardMovieFormat = requirePresetValue(naming.file, selected.filePreset, "file");
	}

	if (selected.folderPreset) {
		payload.movieFolderFormat = requirePresetValue(naming.folder, selected.folderPreset, "folder");
	}

	if (enableRename !== undefined) {
		payload.renameMovies = enableRename;
	}

	return payload;
}

/**
 * Resolve selected presets into a partial Sonarr naming API payload.
 * Throws if a selected preset name is not found in the naming data.
 *
 * @param enableRename - When true, sets renameEpisodes=true. When false, sets renameEpisodes=false.
 *   When undefined, omits the field (preserving the instance's current value).
 */
export function resolveSonarrPayload(
	naming: TrashSonarrNaming,
	selected: SonarrSelectedPresets,
	enableRename?: boolean,
): Partial<SonarrNamingPayload> {
	const payload: Partial<SonarrNamingPayload> = {};

	if (selected.standardEpisodePreset) {
		payload.standardEpisodeFormat = requirePresetValue(
			naming.episodes.standard,
			selected.standardEpisodePreset,
			"standard episode",
		);
	}

	if (selected.dailyEpisodePreset) {
		payload.dailyEpisodeFormat = requirePresetValue(
			naming.episodes.daily,
			selected.dailyEpisodePreset,
			"daily episode",
		);
	}

	if (selected.animeEpisodePreset) {
		payload.animeEpisodeFormat = requirePresetValue(
			naming.episodes.anime,
			selected.animeEpisodePreset,
			"anime episode",
		);
	}

	if (selected.seriesFolderPreset) {
		payload.seriesFolderFormat = requirePresetValue(
			naming.series,
			selected.seriesFolderPreset,
			"series folder",
		);
	}

	if (selected.seasonFolderPreset) {
		payload.seasonFolderFormat = requirePresetValue(
			naming.season,
			selected.seasonFolderPreset,
			"season folder",
		);
	}

	if (enableRename !== undefined) {
		payload.renameEpisodes = enableRename;
	}

	return payload;
}

/**
 * Resolve selected presets into a partial naming API payload.
 * Double-narrows both `naming._service` and `selected.serviceType` to
 * eliminate `as` casts and ensure compile-time type safety.
 * Throws on service type mismatch or missing preset names.
 */
export function resolvePayload(
	naming: TrashNamingData,
	selected: NamingSelectedPresets,
	enableRename?: boolean,
): Partial<RadarrNamingPayload | SonarrNamingPayload> {
	if (naming._service === "RADARR" && selected.serviceType === "RADARR") {
		return resolveRadarrPayload(naming, selected, enableRename);
	}
	if (naming._service === "SONARR" && selected.serviceType === "SONARR") {
		return resolveSonarrPayload(naming, selected, enableRename);
	}
	throw new Error(
		`Service mismatch: naming data is ${naming._service} but presets are for ${selected.serviceType}`,
	);
}

// ============================================================================
// Preview / Diff Building
// ============================================================================

interface FieldMapping {
	fieldGroup: string;
	arrApiField: string;
	presetName: string;
	presetValue: string;
}

function buildFieldMappingsRadarr(
	naming: TrashRadarrNaming,
	selected: RadarrSelectedPresets,
): FieldMapping[] {
	const mappings: FieldMapping[] = [];

	if (selected.filePreset) {
		mappings.push({
			fieldGroup: "Movie File",
			arrApiField: "standardMovieFormat",
			presetName: selected.filePreset,
			presetValue: requirePresetValue(naming.file, selected.filePreset, "file"),
		});
	}

	if (selected.folderPreset) {
		mappings.push({
			fieldGroup: "Movie Folder",
			arrApiField: "movieFolderFormat",
			presetName: selected.folderPreset,
			presetValue: requirePresetValue(naming.folder, selected.folderPreset, "folder"),
		});
	}

	return mappings;
}

function buildFieldMappingsSonarr(
	naming: TrashSonarrNaming,
	selected: SonarrSelectedPresets,
): FieldMapping[] {
	const mappings: FieldMapping[] = [];

	if (selected.standardEpisodePreset) {
		mappings.push({
			fieldGroup: "Standard Episode",
			arrApiField: "standardEpisodeFormat",
			presetName: selected.standardEpisodePreset,
			presetValue: requirePresetValue(
				naming.episodes.standard,
				selected.standardEpisodePreset,
				"standard episode",
			),
		});
	}

	if (selected.dailyEpisodePreset) {
		mappings.push({
			fieldGroup: "Daily Episode",
			arrApiField: "dailyEpisodeFormat",
			presetName: selected.dailyEpisodePreset,
			presetValue: requirePresetValue(
				naming.episodes.daily,
				selected.dailyEpisodePreset,
				"daily episode",
			),
		});
	}

	if (selected.animeEpisodePreset) {
		mappings.push({
			fieldGroup: "Anime Episode",
			arrApiField: "animeEpisodeFormat",
			presetName: selected.animeEpisodePreset,
			presetValue: requirePresetValue(
				naming.episodes.anime,
				selected.animeEpisodePreset,
				"anime episode",
			),
		});
	}

	if (selected.seriesFolderPreset) {
		mappings.push({
			fieldGroup: "Series Folder",
			arrApiField: "seriesFolderFormat",
			presetName: selected.seriesFolderPreset,
			presetValue: requirePresetValue(
				naming.series,
				selected.seriesFolderPreset,
				"series folder",
			),
		});
	}

	if (selected.seasonFolderPreset) {
		mappings.push({
			fieldGroup: "Season Folder",
			arrApiField: "seasonFolderFormat",
			presetName: selected.seasonFolderPreset,
			presetValue: requirePresetValue(
				naming.season,
				selected.seasonFolderPreset,
				"season folder",
			),
		});
	}

	return mappings;
}

/**
 * Build a preview comparing selected presets against the instance's current naming config.
 * Double-narrows both discriminants to eliminate `as` casts.
 * Throws on service type mismatch (caller should validate first).
 */
export function buildPreview(
	naming: TrashNamingData,
	selected: NamingSelectedPresets,
	currentConfig: Record<string, unknown>,
	enableRename?: boolean,
): NamingPreviewResult {
	let fieldMappings: FieldMapping[];

	if (naming._service === "RADARR" && selected.serviceType === "RADARR") {
		fieldMappings = buildFieldMappingsRadarr(naming, selected);
	} else if (naming._service === "SONARR" && selected.serviceType === "SONARR") {
		fieldMappings = buildFieldMappingsSonarr(naming, selected);
	} else {
		throw new Error(
			`Service mismatch: naming data is ${naming._service} but presets are for ${selected.serviceType}`,
		);
	}

	// If enableRename is explicitly set, include it in the preview
	if (enableRename !== undefined) {
		const renameField =
			naming._service === "RADARR" ? "renameMovies" : "renameEpisodes";
		const renameLabel =
			naming._service === "RADARR" ? "Rename Movies" : "Rename Episodes";
		const currentValue = currentConfig[renameField];

		fieldMappings.push({
			fieldGroup: renameLabel,
			arrApiField: renameField,
			presetName: enableRename ? "Enabled" : "Disabled",
			presetValue: String(enableRename),
		});

		// Override the presetValue check in buildPreviewFromMappings by
		// injecting the boolean comparison directly
		const boolChanged = currentValue !== enableRename;
		const result = buildPreviewFromMappings(fieldMappings.slice(0, -1), currentConfig);
		result.comparisons.push({
			fieldGroup: renameLabel,
			arrApiField: renameField,
			presetName: enableRename ? "Enabled" : "Disabled",
			presetValue: String(enableRename),
			currentValue: currentValue != null ? String(currentValue) : null,
			changed: boolChanged,
		});
		if (boolChanged) {
			result.changedCount++;
		} else {
			result.unchangedCount++;
		}
		return result;
	}

	return buildPreviewFromMappings(fieldMappings, currentConfig);
}

function buildPreviewFromMappings(
	fieldMappings: FieldMapping[],
	currentConfig: Record<string, unknown>,
): NamingPreviewResult {
	const comparisons: NamingFieldComparison[] = [];

	for (const mapping of fieldMappings) {
		const currentValue =
			typeof currentConfig[mapping.arrApiField] === "string"
				? (currentConfig[mapping.arrApiField] as string)
				: null;
		const changed = currentValue !== mapping.presetValue;

		comparisons.push({
			fieldGroup: mapping.fieldGroup,
			arrApiField: mapping.arrApiField,
			presetName: mapping.presetName,
			presetValue: mapping.presetValue,
			currentValue,
			changed,
		});
	}

	const changedCount = comparisons.filter((c) => c.changed).length;
	return { comparisons, changedCount, unchangedCount: comparisons.length - changedCount };
}

// ============================================================================
// Hash Computation
// ============================================================================

/**
 * Compute a SHA-256 hash of the naming payload for change detection.
 * NOTE: Assumes payload values are all primitives (no nested objects).
 * The replacer-as-array approach only serializes listed top-level keys.
 */
export function computeNamingHash(payload: Record<string, unknown>): string {
	const sorted = JSON.stringify(payload, Object.keys(payload).sort());
	return createHash("sha256").update(sorted).digest("hex");
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that selected presets exist in the naming data.
 * Returns an array of error messages (empty if valid).
 * The discriminated union type eliminates cross-service validation — the
 * type system ensures Radarr presets can't be passed with Sonarr data.
 */
export function validateSelectedPresets(
	naming: TrashNamingData,
	selected: NamingSelectedPresets,
): string[] {
	const errors: string[] = [];

	if (naming._service === "RADARR" && selected.serviceType === "RADARR") {
		if (selected.filePreset && !naming.file[selected.filePreset]) {
			errors.push(`File preset "${selected.filePreset}" not found in Radarr naming data`);
		}
		if (selected.folderPreset && !naming.folder[selected.folderPreset]) {
			errors.push(`Folder preset "${selected.folderPreset}" not found in Radarr naming data`);
		}
	} else if (naming._service === "SONARR" && selected.serviceType === "SONARR") {
		if (
			selected.standardEpisodePreset &&
			!naming.episodes.standard[selected.standardEpisodePreset]
		) {
			errors.push(
				`Standard episode preset "${selected.standardEpisodePreset}" not found in Sonarr naming data`,
			);
		}
		if (selected.dailyEpisodePreset && !naming.episodes.daily[selected.dailyEpisodePreset]) {
			errors.push(
				`Daily episode preset "${selected.dailyEpisodePreset}" not found in Sonarr naming data`,
			);
		}
		if (selected.animeEpisodePreset && !naming.episodes.anime[selected.animeEpisodePreset]) {
			errors.push(
				`Anime episode preset "${selected.animeEpisodePreset}" not found in Sonarr naming data`,
			);
		}
		if (selected.seriesFolderPreset && !naming.series[selected.seriesFolderPreset]) {
			errors.push(
				`Series folder preset "${selected.seriesFolderPreset}" not found in Sonarr naming data`,
			);
		}
		if (selected.seasonFolderPreset && !naming.season[selected.seasonFolderPreset]) {
			errors.push(
				`Season folder preset "${selected.seasonFolderPreset}" not found in Sonarr naming data`,
			);
		}
	} else {
		errors.push(
			`Service type mismatch: naming data is ${naming._service} but presets are for ${selected.serviceType}`,
		);
	}

	return errors;
}
