/**
 * Tests for naming-deployer pure functions.
 *
 * Covers: extractPresets, resolvePayload, buildPreview,
 * validateSelectedPresets, and computeNamingHash.
 */

import { describe, expect, it } from "vitest";
import type {
	NamingSelectedPresets,
	RadarrSelectedPresets,
	SonarrSelectedPresets,
	TrashRadarrNaming,
	TrashSonarrNaming,
} from "@arr/shared";

import {
	buildPreview,
	computeNamingHash,
	extractPresets,
	resolvePayload,
	resolveRadarrPayload,
	resolveSonarrPayload,
	validateSelectedPresets,
} from "../naming-deployer.js";

// ============================================================================
// Fixtures
// ============================================================================

const RADARR_NAMING: TrashRadarrNaming = {
	_service: "RADARR",
	folder: {
		"TRaSH Recommended": "{Movie CleanTitle} ({Release Year})",
		Plex: "{Movie Title} ({Release Year})",
	},
	file: {
		"TRaSH Recommended": "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}",
		Plex: "{Movie Title} ({Release Year})",
	},
};

const SONARR_NAMING: TrashSonarrNaming = {
	_service: "SONARR",
	season: { Default: "Season {season:00}", Plex: "Season {season:00}" },
	series: { Default: "{Series TitleYear}", Plex: "{Series Title}" },
	episodes: {
		standard: {
			Default: "S{season:00}E{episode:00} - {Episode CleanTitle}",
			Plex: "S{season:00}E{episode:00} - {Episode Title}",
		},
		daily: { Default: "{Air-Date} - {Episode CleanTitle}" },
		anime: { Default: "S{season:00}E{episode:00} - {absolute:000}" },
	},
};

// Helpers to build full preset objects (all fields required as string | null)
function radarrPresets(overrides: Partial<Omit<RadarrSelectedPresets, "serviceType">> = {}): RadarrSelectedPresets {
	return {
		serviceType: "RADARR",
		filePreset: null,
		folderPreset: null,
		...overrides,
	};
}

function sonarrPresets(overrides: Partial<Omit<SonarrSelectedPresets, "serviceType">> = {}): SonarrSelectedPresets {
	return {
		serviceType: "SONARR",
		standardEpisodePreset: null,
		dailyEpisodePreset: null,
		animeEpisodePreset: null,
		seriesFolderPreset: null,
		seasonFolderPreset: null,
		...overrides,
	};
}

// ============================================================================
// extractPresets
// ============================================================================

describe("extractPresets", () => {
	it("should extract Radarr presets with serviceType discriminant", () => {
		const result = extractPresets(RADARR_NAMING);

		expect(result.serviceType).toBe("RADARR");
		if (result.serviceType === "RADARR") {
			expect(result.filePresets).toHaveLength(2);
			expect(result.folderPresets).toHaveLength(2);
			expect(result.filePresets).toContainEqual({
				name: "TRaSH Recommended",
				formatString: "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}",
			});
		}
	});

	it("should extract Sonarr presets with all 5 categories", () => {
		const result = extractPresets(SONARR_NAMING);

		expect(result.serviceType).toBe("SONARR");
		if (result.serviceType === "SONARR") {
			expect(result.standardEpisodePresets).toHaveLength(2);
			expect(result.dailyEpisodePresets).toHaveLength(1);
			expect(result.animeEpisodePresets).toHaveLength(1);
			expect(result.seriesFolderPresets).toHaveLength(2);
			expect(result.seasonFolderPresets).toHaveLength(2);
		}
	});

	it("should handle empty preset records", () => {
		const emptyRadarr: TrashRadarrNaming = { _service: "RADARR", folder: {}, file: {} };
		const result = extractPresets(emptyRadarr);

		if (result.serviceType === "RADARR") {
			expect(result.filePresets).toHaveLength(0);
			expect(result.folderPresets).toHaveLength(0);
		}
	});
});

// ============================================================================
// resolveRadarrPayload
// ============================================================================

describe("resolveRadarrPayload", () => {
	it("should resolve file preset to standardMovieFormat (no rename by default)", () => {
		const selected = radarrPresets({ filePreset: "TRaSH Recommended" });

		const payload = resolveRadarrPayload(RADARR_NAMING, selected);

		expect(payload.standardMovieFormat).toBe("{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}");
		expect(payload.renameMovies).toBeUndefined();
	});

	it("should resolve folder preset to movieFolderFormat (no rename by default)", () => {
		const selected = radarrPresets({ folderPreset: "Plex" });

		const payload = resolveRadarrPayload(RADARR_NAMING, selected);

		expect(payload.movieFolderFormat).toBe("{Movie Title} ({Release Year})");
		expect(payload.renameMovies).toBeUndefined();
	});

	it("should resolve both presets together (no rename by default)", () => {
		const selected = radarrPresets({
			filePreset: "TRaSH Recommended",
			folderPreset: "TRaSH Recommended",
		});

		const payload = resolveRadarrPayload(RADARR_NAMING, selected);

		expect(payload.standardMovieFormat).toBeDefined();
		expect(payload.movieFolderFormat).toBeDefined();
		expect(payload.renameMovies).toBeUndefined();
	});

	it("should set renameMovies=true when enableRename is true", () => {
		const selected = radarrPresets({ filePreset: "TRaSH Recommended" });

		const payload = resolveRadarrPayload(RADARR_NAMING, selected, true);

		expect(payload.standardMovieFormat).toBeDefined();
		expect(payload.renameMovies).toBe(true);
	});

	it("should set renameMovies=false when enableRename is false", () => {
		const selected = radarrPresets({ filePreset: "TRaSH Recommended" });

		const payload = resolveRadarrPayload(RADARR_NAMING, selected, false);

		expect(payload.renameMovies).toBe(false);
	});

	it("should return empty payload with no renameMovies when nothing selected", () => {
		const selected = radarrPresets();

		const payload = resolveRadarrPayload(RADARR_NAMING, selected);

		expect(payload).toEqual({});
		expect(payload.renameMovies).toBeUndefined();
	});

	it("should throw when selected preset name does not exist", () => {
		const selected = radarrPresets({ filePreset: "Nonexistent Preset" });

		expect(() => resolveRadarrPayload(RADARR_NAMING, selected)).toThrow(
			'Selected file preset "Nonexistent Preset" not found in naming data',
		);
	});
});

// ============================================================================
// resolveSonarrPayload
// ============================================================================

describe("resolveSonarrPayload", () => {
	it("should resolve all 5 Sonarr preset fields (no rename by default)", () => {
		const selected = sonarrPresets({
			standardEpisodePreset: "Default",
			dailyEpisodePreset: "Default",
			animeEpisodePreset: "Default",
			seriesFolderPreset: "Default",
			seasonFolderPreset: "Default",
		});

		const payload = resolveSonarrPayload(SONARR_NAMING, selected);

		expect(payload.standardEpisodeFormat).toBe("S{season:00}E{episode:00} - {Episode CleanTitle}");
		expect(payload.dailyEpisodeFormat).toBe("{Air-Date} - {Episode CleanTitle}");
		expect(payload.animeEpisodeFormat).toBe("S{season:00}E{episode:00} - {absolute:000}");
		expect(payload.seriesFolderFormat).toBe("{Series TitleYear}");
		expect(payload.seasonFolderFormat).toBe("Season {season:00}");
		expect(payload.renameEpisodes).toBeUndefined();
	});

	it("should resolve partial selection (only standard episode, no rename by default)", () => {
		const selected = sonarrPresets({ standardEpisodePreset: "Default" });

		const payload = resolveSonarrPayload(SONARR_NAMING, selected);

		expect(payload.standardEpisodeFormat).toBeDefined();
		expect(payload.dailyEpisodeFormat).toBeUndefined();
		expect(payload.renameEpisodes).toBeUndefined();
	});

	it("should set renameEpisodes=true when enableRename is true", () => {
		const selected = sonarrPresets({ standardEpisodePreset: "Default" });

		const payload = resolveSonarrPayload(SONARR_NAMING, selected, true);

		expect(payload.renameEpisodes).toBe(true);
	});

	it("should set renameEpisodes=false when enableRename is false", () => {
		const selected = sonarrPresets({ standardEpisodePreset: "Default" });

		const payload = resolveSonarrPayload(SONARR_NAMING, selected, false);

		expect(payload.renameEpisodes).toBe(false);
	});

	it("should return empty payload when all presets are null", () => {
		const selected = sonarrPresets();

		const payload = resolveSonarrPayload(SONARR_NAMING, selected);

		expect(payload).toEqual({});
		expect(payload.renameEpisodes).toBeUndefined();
	});

	it("should throw on nonexistent Sonarr preset", () => {
		const selected = sonarrPresets({ standardEpisodePreset: "Ghost Preset" });

		expect(() => resolveSonarrPayload(SONARR_NAMING, selected)).toThrow(
			'Selected standard episode preset "Ghost Preset" not found',
		);
	});
});

// ============================================================================
// resolvePayload (double-narrowing dispatch)
// ============================================================================

describe("resolvePayload", () => {
	it("should dispatch to Radarr when both discriminants match", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });

		const payload = resolvePayload(RADARR_NAMING, selected);

		expect(payload).toHaveProperty("standardMovieFormat");
	});

	it("should dispatch to Sonarr when both discriminants match", () => {
		const selected: NamingSelectedPresets = sonarrPresets({ standardEpisodePreset: "Default" });

		const payload = resolvePayload(SONARR_NAMING, selected);

		expect(payload).toHaveProperty("standardEpisodeFormat");
	});

	it("should throw on service mismatch (Radarr data + Sonarr presets)", () => {
		const selected: NamingSelectedPresets = sonarrPresets({ standardEpisodePreset: "Default" });

		expect(() => resolvePayload(RADARR_NAMING, selected)).toThrow(
			"Service mismatch: naming data is RADARR but presets are for SONARR",
		);
	});

	it("should throw on service mismatch (Sonarr data + Radarr presets)", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });

		expect(() => resolvePayload(SONARR_NAMING, selected)).toThrow(
			"Service mismatch: naming data is SONARR but presets are for RADARR",
		);
	});
});

// ============================================================================
// buildPreview
// ============================================================================

describe("buildPreview", () => {
	it("should detect changed fields", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });
		const currentConfig = { standardMovieFormat: "old format string" };

		const preview = buildPreview(RADARR_NAMING, selected, currentConfig);

		expect(preview.changedCount).toBe(1);
		expect(preview.unchangedCount).toBe(0);
		expect(preview.comparisons).toHaveLength(1);
		expect(preview.comparisons[0]!.changed).toBe(true);
		expect(preview.comparisons[0]!.currentValue).toBe("old format string");
	});

	it("should detect unchanged fields", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });
		const currentConfig = {
			standardMovieFormat: "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}",
		};

		const preview = buildPreview(RADARR_NAMING, selected, currentConfig);

		expect(preview.changedCount).toBe(0);
		expect(preview.unchangedCount).toBe(1);
		expect(preview.comparisons[0]!.changed).toBe(false);
	});

	it("should handle null current value (field missing from instance)", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });

		const preview = buildPreview(RADARR_NAMING, selected, {});

		expect(preview.comparisons[0]!.currentValue).toBeNull();
		expect(preview.comparisons[0]!.changed).toBe(true);
	});

	it("should handle non-string current values as null", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });
		const currentConfig = { standardMovieFormat: 12345 };

		const preview = buildPreview(RADARR_NAMING, selected, currentConfig);

		expect(preview.comparisons[0]!.currentValue).toBeNull();
		expect(preview.comparisons[0]!.changed).toBe(true);
	});

	it("should preview multiple Radarr fields with mixed changes", () => {
		const selected: NamingSelectedPresets = radarrPresets({
			filePreset: "TRaSH Recommended",
			folderPreset: "TRaSH Recommended",
		});
		const currentConfig = {
			standardMovieFormat: "old",
			movieFolderFormat: "{Movie CleanTitle} ({Release Year})", // matches
		};

		const preview = buildPreview(RADARR_NAMING, selected, currentConfig);

		expect(preview.comparisons).toHaveLength(2);
		expect(preview.changedCount).toBe(1);
		expect(preview.unchangedCount).toBe(1);
	});

	it("should preview Sonarr fields correctly", () => {
		const selected: NamingSelectedPresets = sonarrPresets({
			standardEpisodePreset: "Default",
			seasonFolderPreset: "Default",
		});
		const currentConfig = {
			standardEpisodeFormat: "old format",
			seasonFolderFormat: "Season {season:00}", // matches
		};

		const preview = buildPreview(SONARR_NAMING, selected, currentConfig);

		expect(preview.comparisons).toHaveLength(2);
		expect(preview.changedCount).toBe(1);
		expect(preview.unchangedCount).toBe(1);
	});

	it("should return empty comparisons when no presets selected", () => {
		const selected: NamingSelectedPresets = radarrPresets();

		const preview = buildPreview(RADARR_NAMING, selected, { standardMovieFormat: "whatever" });

		expect(preview.comparisons).toHaveLength(0);
		expect(preview.changedCount).toBe(0);
		expect(preview.unchangedCount).toBe(0);
	});

	it("should throw on service mismatch", () => {
		const selected: NamingSelectedPresets = sonarrPresets({ standardEpisodePreset: "Default" });

		expect(() => buildPreview(RADARR_NAMING, selected, {})).toThrow("Service mismatch");
	});

	it("should populate all comparison fields", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "TRaSH Recommended" });

		const preview = buildPreview(RADARR_NAMING, selected, { standardMovieFormat: "old" });
		const comp = preview.comparisons[0]!;

		expect(comp.fieldGroup).toBe("Movie File");
		expect(comp.arrApiField).toBe("standardMovieFormat");
		expect(comp.presetName).toBe("TRaSH Recommended");
		expect(comp.presetValue).toBe("{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}}");
		expect(comp.currentValue).toBe("old");
		expect(comp.changed).toBe(true);
	});
});

// ============================================================================
// computeNamingHash
// ============================================================================

describe("computeNamingHash", () => {
	it("should produce consistent hash for same payload", () => {
		const payload = { standardMovieFormat: "format1", movieFolderFormat: "format2" };

		const hash1 = computeNamingHash(payload);
		const hash2 = computeNamingHash(payload);

		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	it("should produce same hash regardless of key insertion order", () => {
		const payload1 = { b: "2", a: "1", c: "3" };
		const payload2 = { a: "1", c: "3", b: "2" };

		expect(computeNamingHash(payload1)).toBe(computeNamingHash(payload2));
	});

	it("should produce different hashes for different payloads", () => {
		const payload1 = { standardMovieFormat: "format1" };
		const payload2 = { standardMovieFormat: "format2" };

		expect(computeNamingHash(payload1)).not.toBe(computeNamingHash(payload2));
	});

	it("should handle empty payload", () => {
		const hash = computeNamingHash({});

		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});
});

// ============================================================================
// validateSelectedPresets
// ============================================================================

describe("validateSelectedPresets", () => {
	it("should return no errors for valid Radarr presets", () => {
		const selected: NamingSelectedPresets = radarrPresets({
			filePreset: "TRaSH Recommended",
			folderPreset: "Plex",
		});

		const errors = validateSelectedPresets(RADARR_NAMING, selected);

		expect(errors).toHaveLength(0);
	});

	it("should return no errors for valid Sonarr presets", () => {
		const selected: NamingSelectedPresets = sonarrPresets({
			standardEpisodePreset: "Default",
			dailyEpisodePreset: "Default",
			animeEpisodePreset: "Default",
			seriesFolderPreset: "Default",
			seasonFolderPreset: "Default",
		});

		const errors = validateSelectedPresets(SONARR_NAMING, selected);

		expect(errors).toHaveLength(0);
	});

	it("should return error for nonexistent Radarr file preset", () => {
		const selected: NamingSelectedPresets = radarrPresets({ filePreset: "Nonexistent" });

		const errors = validateSelectedPresets(RADARR_NAMING, selected);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Nonexistent");
		expect(errors[0]).toContain("Radarr");
	});

	it("should return errors for multiple invalid Sonarr presets", () => {
		const selected: NamingSelectedPresets = sonarrPresets({
			standardEpisodePreset: "Bad1",
			dailyEpisodePreset: "Bad2",
			animeEpisodePreset: "Bad3",
		});

		const errors = validateSelectedPresets(SONARR_NAMING, selected);

		expect(errors).toHaveLength(3);
	});

	it("should skip validation for null preset fields", () => {
		const selected: NamingSelectedPresets = radarrPresets();

		const errors = validateSelectedPresets(RADARR_NAMING, selected);

		expect(errors).toHaveLength(0);
	});

	it("should return service mismatch error", () => {
		const selected: NamingSelectedPresets = sonarrPresets({ standardEpisodePreset: "Default" });

		const errors = validateSelectedPresets(RADARR_NAMING, selected);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Service type mismatch");
	});

	it("should detect mix of valid and invalid presets", () => {
		const selected: NamingSelectedPresets = radarrPresets({
			filePreset: "TRaSH Recommended", // valid
			folderPreset: "Nonexistent", // invalid
		});

		const errors = validateSelectedPresets(RADARR_NAMING, selected);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Nonexistent");
	});
});
