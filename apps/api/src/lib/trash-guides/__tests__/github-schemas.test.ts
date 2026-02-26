/**
 * Tests for Zod schemas and validateAndCollect helper.
 *
 * Validates that schemas accept realistic TRaSH GitHub JSON,
 * reject malformed data, normalize trash_ids to lowercase,
 * and inject _service discriminants via .transform().
 */

import { describe, expect, it, vi } from "vitest";

import {
	radarrNamingSchema,
	sonarrNamingSchema,
	trashCustomFormatGroupSchema,
	trashCustomFormatSchema,
	trashNamingSchemeSchema,
	trashQualityProfileGroupSchema,
	trashQualityProfileSchema,
	trashQualitySizeSchema,
	validateAndCollect,
} from "../github-schemas.js";

// ============================================================================
// Fixtures — representative TRaSH GitHub JSON shapes
// ============================================================================

const VALID_CUSTOM_FORMAT = {
	trash_id: "ABCdef1234567890ABCdef1234567890",
	name: "BR-DISK",
	score: -10000,
	trash_scores: { default: -10000, "anime-radarr": -10000 },
	trash_description: "Avoid BR-DISK releases",
	includeCustomFormatWhenRenaming: false,
	specifications: [
		{
			name: "BR-DISK",
			implementation: "ReleaseTitleSpecification",
			negate: false,
			required: false,
			fields: { value: "\\bBR\\-?DISK\\b" },
		},
	],
};

const VALID_CF_GROUP = {
	trash_id: "AA11BB22CC33DD44EE55FF6677889900",
	name: "HD Streaming Services",
	trash_description: "CFs for streaming service detection",
	default: "true",
	custom_formats: [
		{ name: "AMZN", trash_id: "11223344556677889900aabbccddeeff", required: true, default: true },
		{ name: "NF", trash_id: "aabbccddeeff11223344556677889900", required: false },
	],
	quality_profiles: {
		include: { "HD Bluray + WEB": "deadbeef12345678deadbeef12345678" },
	},
};

const VALID_QUALITY_SIZE = {
	trash_id: "AABB11223344556677889900CCDDFF00",
	type: "movie",
	qualities: [
		{ quality: "HDTV-720p", min: 2.3, preferred: 14.3, max: 100 },
		{ quality: "Bluray-1080p", min: 3.3, preferred: 30.3, max: 100 },
	],
};

const VALID_NAMING_SCHEME = {
	type: "movie" as const,
	standard: "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{MediaInfo AudioLanguages}{[Mediainfo VideoCodec]}{-Release Group}",
	folder: "{Movie CleanTitle} ({Release Year})",
};

const VALID_RADARR_NAMING = {
	folder: {
		"TRaSH Recommended": "{Movie CleanTitle} ({Release Year})",
		Plex: "{Movie Title} ({Release Year})",
	},
	file: {
		"TRaSH Recommended": "{Movie CleanTitle} {(Release Year)} ...format...",
		Plex: "{Movie Title} ({Release Year}) ...format...",
	},
};

const VALID_SONARR_NAMING = {
	season: { Default: "Season {season:00}" },
	series: { Default: "{Series TitleYear}" },
	episodes: {
		standard: { Default: "{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle}" },
		daily: { Default: "{Series TitleYear} - {Air-Date} - {Episode CleanTitle}" },
		anime: { Default: "{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000}" },
	},
};

const VALID_QUALITY_PROFILE = {
	trash_id: "DEADBEEF12345678DEADBEEF12345678",
	name: "HD Bluray + WEB",
	trash_score_set: "default",
	trash_description: "High quality profile",
	trash_url: "https://trash-guides.info/Radarr/radarr-setup-quality-profiles/#hd-bluray-web",
	visible: "public",
	group: 1,
	upgradeAllowed: true,
	cutoff: "Bluray-1080p",
	minFormatScore: 0,
	cutoffFormatScore: 10000,
	minUpgradeFormatScore: 1,
	language: "Original",
	items: [
		{ name: "Bluray-1080p", allowed: true },
		{ name: "WEB 1080p", allowed: true, items: ["WEBDL-1080p", "WEBRip-1080p"] },
		{ name: "Bluray-720p", allowed: false },
	],
	formatItems: {
		"BR-DISK": "abcdef1234567890abcdef1234567890",
		REMUX: "1234567890abcdef1234567890abcdef",
	},
};

const VALID_PROFILE_GROUP = {
	name: "Standard",
	profiles: {
		"HD Bluray + WEB": "deadbeef12345678deadbeef12345678",
		"UHD Bluray + WEB": "cafebabe12345678cafebabe12345678",
	},
};

// ============================================================================
// Mock Logger
// ============================================================================

function createMockLogger() {
	return { warn: vi.fn(), error: vi.fn() };
}

// ============================================================================
// Custom Format Schema
// ============================================================================

describe("trashCustomFormatSchema", () => {
	it("should accept a valid custom format", () => {
		const result = trashCustomFormatSchema.safeParse(VALID_CUSTOM_FORMAT);
		expect(result.success).toBe(true);
	});

	it("should normalize trash_id to lowercase", () => {
		const result = trashCustomFormatSchema.safeParse(VALID_CUSTOM_FORMAT);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.trash_id).toBe("abcdef1234567890abcdef1234567890");
		}
	});

	it("should accept extra fields (looseObject)", () => {
		const withExtra = { ...VALID_CUSTOM_FORMAT, newField: "future-TRaSH-field" };
		const result = trashCustomFormatSchema.safeParse(withExtra);
		expect(result.success).toBe(true);
	});

	it("should reject missing trash_id", () => {
		const { trash_id: _, ...noId } = VALID_CUSTOM_FORMAT;
		const result = trashCustomFormatSchema.safeParse(noId);
		expect(result.success).toBe(false);
	});

	it("should reject missing specifications", () => {
		const { specifications: _, ...noSpecs } = VALID_CUSTOM_FORMAT;
		const result = trashCustomFormatSchema.safeParse(noSpecs);
		expect(result.success).toBe(false);
	});

	it("should reject non-string trash_id", () => {
		const result = trashCustomFormatSchema.safeParse({
			...VALID_CUSTOM_FORMAT,
			trash_id: 12345,
		});
		expect(result.success).toBe(false);
	});

	it("should accept optional fields when missing", () => {
		const minimal = {
			trash_id: "abcdef1234567890abcdef1234567890",
			name: "Test CF",
			specifications: [],
		};
		const result = trashCustomFormatSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// Custom Format Group Schema
// ============================================================================

describe("trashCustomFormatGroupSchema", () => {
	it("should accept a valid CF group with include semantics", () => {
		const result = trashCustomFormatGroupSchema.safeParse(VALID_CF_GROUP);
		expect(result.success).toBe(true);
	});

	it("should accept CF group with exclude semantics (legacy)", () => {
		const withExclude = {
			...VALID_CF_GROUP,
			quality_profiles: {
				exclude: { "Anime": "11111111222222223333333344444444" },
			},
		};
		const result = trashCustomFormatGroupSchema.safeParse(withExclude);
		expect(result.success).toBe(true);
	});

	it("should accept CF group without quality_profiles", () => {
		const { quality_profiles: _, ...noQP } = VALID_CF_GROUP;
		const result = trashCustomFormatGroupSchema.safeParse(noQP);
		expect(result.success).toBe(true);
	});

	it("should accept string custom_formats (trash_id shorthand)", () => {
		const withStrings = {
			...VALID_CF_GROUP,
			custom_formats: ["abcdef1234567890abcdef1234567890", "1234567890abcdef1234567890abcdef"],
		};
		const result = trashCustomFormatGroupSchema.safeParse(withStrings);
		expect(result.success).toBe(true);
	});

	it("should accept boolean default on CF items", () => {
		const withBoolDefault = {
			...VALID_CF_GROUP,
			custom_formats: [
				{ name: "AMZN", trash_id: "11223344556677889900aabbccddeeff", required: true, default: true },
			],
		};
		const result = trashCustomFormatGroupSchema.safeParse(withBoolDefault);
		expect(result.success).toBe(true);
	});

	it("should normalize trash_ids to lowercase", () => {
		const result = trashCustomFormatGroupSchema.safeParse(VALID_CF_GROUP);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.trash_id).toBe("aa11bb22cc33dd44ee55ff6677889900");
		}
	});

	it("should reject missing custom_formats", () => {
		const { custom_formats: _, ...noCFs } = VALID_CF_GROUP;
		const result = trashCustomFormatGroupSchema.safeParse(noCFs);
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Quality Size Schema
// ============================================================================

describe("trashQualitySizeSchema", () => {
	it("should accept a valid quality size", () => {
		const result = trashQualitySizeSchema.safeParse(VALID_QUALITY_SIZE);
		expect(result.success).toBe(true);
	});

	it("should reject missing qualities array", () => {
		const { qualities: _, ...noQ } = VALID_QUALITY_SIZE;
		const result = trashQualitySizeSchema.safeParse(noQ);
		expect(result.success).toBe(false);
	});

	it("should reject quality entry with missing min", () => {
		const badQuality = {
			...VALID_QUALITY_SIZE,
			qualities: [{ quality: "HDTV-720p", preferred: 14, max: 100 }],
		};
		const result = trashQualitySizeSchema.safeParse(badQuality);
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Naming Scheme Schema
// ============================================================================

describe("trashNamingSchemeSchema", () => {
	it("should accept a valid movie naming scheme", () => {
		const result = trashNamingSchemeSchema.safeParse(VALID_NAMING_SCHEME);
		expect(result.success).toBe(true);
	});

	it("should accept a series naming scheme", () => {
		const series = { type: "series", standard: "{format}", season_folder: "Season {season:00}" };
		const result = trashNamingSchemeSchema.safeParse(series);
		expect(result.success).toBe(true);
	});

	it("should reject invalid type value", () => {
		const result = trashNamingSchemeSchema.safeParse({ ...VALID_NAMING_SCHEME, type: "anime" });
		expect(result.success).toBe(false);
	});

	it("should accept when optional fields are missing", () => {
		const result = trashNamingSchemeSchema.safeParse({ type: "movie" });
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// Radarr / Sonarr Naming Schemas (Feature 2)
// ============================================================================

describe("radarrNamingSchema", () => {
	it("should accept valid Radarr naming data", () => {
		const result = radarrNamingSchema.safeParse(VALID_RADARR_NAMING);
		expect(result.success).toBe(true);
	});

	it("should inject _service: RADARR discriminant", () => {
		const result = radarrNamingSchema.safeParse(VALID_RADARR_NAMING);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data._service).toBe("RADARR");
		}
	});

	it("should preserve original fields alongside injected _service", () => {
		const result = radarrNamingSchema.safeParse(VALID_RADARR_NAMING);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.folder).toEqual(VALID_RADARR_NAMING.folder);
			expect(result.data.file).toEqual(VALID_RADARR_NAMING.file);
		}
	});

	it("should reject when folder is missing", () => {
		const { folder: _, ...noFolder } = VALID_RADARR_NAMING;
		const result = radarrNamingSchema.safeParse(noFolder);
		expect(result.success).toBe(false);
	});

	it("should reject when file is missing", () => {
		const { file: _, ...noFile } = VALID_RADARR_NAMING;
		const result = radarrNamingSchema.safeParse(noFile);
		expect(result.success).toBe(false);
	});

	it("should tolerate extra fields", () => {
		const withExtra = { ...VALID_RADARR_NAMING, futureField: "value" };
		const result = radarrNamingSchema.safeParse(withExtra);
		expect(result.success).toBe(true);
	});
});

describe("sonarrNamingSchema", () => {
	it("should accept valid Sonarr naming data", () => {
		const result = sonarrNamingSchema.safeParse(VALID_SONARR_NAMING);
		expect(result.success).toBe(true);
	});

	it("should inject _service: SONARR discriminant", () => {
		const result = sonarrNamingSchema.safeParse(VALID_SONARR_NAMING);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data._service).toBe("SONARR");
		}
	});

	it("should preserve nested episodes structure", () => {
		const result = sonarrNamingSchema.safeParse(VALID_SONARR_NAMING);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.episodes.standard).toEqual(VALID_SONARR_NAMING.episodes.standard);
			expect(result.data.episodes.daily).toEqual(VALID_SONARR_NAMING.episodes.daily);
			expect(result.data.episodes.anime).toEqual(VALID_SONARR_NAMING.episodes.anime);
		}
	});

	it("should reject when episodes is missing", () => {
		const { episodes: _, ...noEpisodes } = VALID_SONARR_NAMING;
		const result = sonarrNamingSchema.safeParse(noEpisodes);
		expect(result.success).toBe(false);
	});

	it("should reject when episodes.standard is missing", () => {
		const badNaming = {
			...VALID_SONARR_NAMING,
			episodes: { daily: VALID_SONARR_NAMING.episodes.daily, anime: VALID_SONARR_NAMING.episodes.anime },
		};
		const result = sonarrNamingSchema.safeParse(badNaming);
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// Quality Profile Schema
// ============================================================================

describe("trashQualityProfileSchema", () => {
	it("should accept a valid quality profile", () => {
		const result = trashQualityProfileSchema.safeParse(VALID_QUALITY_PROFILE);
		expect(result.success).toBe(true);
	});

	it("should normalize trash_id to lowercase", () => {
		const result = trashQualityProfileSchema.safeParse(VALID_QUALITY_PROFILE);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.trash_id).toBe("deadbeef12345678deadbeef12345678");
		}
	});

	it("should accept items with nested quality groups", () => {
		const result = trashQualityProfileSchema.safeParse(VALID_QUALITY_PROFILE);
		expect(result.success).toBe(true);
		if (result.success) {
			const webGroup = result.data.items.find((i) => i.name === "WEB 1080p");
			expect(webGroup?.items).toEqual(["WEBDL-1080p", "WEBRip-1080p"]);
		}
	});

	it("should reject missing upgradeAllowed", () => {
		const { upgradeAllowed: _, ...noUpgrade } = VALID_QUALITY_PROFILE;
		const result = trashQualityProfileSchema.safeParse(noUpgrade);
		expect(result.success).toBe(false);
	});

	it("should reject missing cutoff", () => {
		const { cutoff: _, ...noCutoff } = VALID_QUALITY_PROFILE;
		const result = trashQualityProfileSchema.safeParse(noCutoff);
		expect(result.success).toBe(false);
	});

	it("should reject missing items array", () => {
		const { items: _, ...noItems } = VALID_QUALITY_PROFILE;
		const result = trashQualityProfileSchema.safeParse(noItems);
		expect(result.success).toBe(false);
	});

	it("should accept when optional fields are missing", () => {
		const minimal = {
			trash_id: "abcdef1234567890abcdef1234567890",
			name: "Minimal Profile",
			upgradeAllowed: false,
			cutoff: "HDTV-720p",
			items: [{ name: "HDTV-720p", allowed: true }],
		};
		const result = trashQualityProfileSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// Quality Profile Group Schema
// ============================================================================

describe("trashQualityProfileGroupSchema", () => {
	it("should accept a valid profile group", () => {
		const result = trashQualityProfileGroupSchema.safeParse(VALID_PROFILE_GROUP);
		expect(result.success).toBe(true);
	});

	it("should reject missing profiles", () => {
		const result = trashQualityProfileGroupSchema.safeParse({ name: "Standard" });
		expect(result.success).toBe(false);
	});

	it("should reject missing name", () => {
		const result = trashQualityProfileGroupSchema.safeParse({
			profiles: { "HD": "deadbeef12345678deadbeef12345678" },
		});
		expect(result.success).toBe(false);
	});
});

// ============================================================================
// validateAndCollect
// ============================================================================

describe("validateAndCollect", () => {
	it("should validate an array of items and return valid ones", () => {
		const log = createMockLogger();
		const items = [VALID_CUSTOM_FORMAT, VALID_CUSTOM_FORMAT];

		const results = validateAndCollect(items, trashCustomFormatSchema, "cf/test.json", log);

		expect(results).toHaveLength(2);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("should wrap single item in array", () => {
		const log = createMockLogger();

		const results = validateAndCollect(VALID_CUSTOM_FORMAT, trashCustomFormatSchema, "cf/test.json", log);

		expect(results).toHaveLength(1);
		expect(results[0]!.name).toBe("BR-DISK");
	});

	it("should skip invalid items and log warnings", () => {
		const log = createMockLogger();
		const items = [
			VALID_CUSTOM_FORMAT,
			{ name: "Bad CF" }, // Missing trash_id + specifications
			VALID_CUSTOM_FORMAT,
		];

		const results = validateAndCollect(items, trashCustomFormatSchema, "cf/test.json", log);

		expect(results).toHaveLength(2);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping invalid item 1"));
	});

	it("should escalate to error when ALL items fail", () => {
		const log = createMockLogger();
		const items = [{ bad: true }, { also: "bad" }, { nope: 123 }];

		const results = validateAndCollect(items, trashCustomFormatSchema, "cf/broken.json", log);

		expect(results).toHaveLength(0);
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("All 3 items failed validation"),
		);
	});

	it("should warn on high rejection rate (>50%)", () => {
		const log = createMockLogger();
		const items = [VALID_CUSTOM_FORMAT, { bad: true }, { bad: true }, { bad: true }];

		const results = validateAndCollect(items, trashCustomFormatSchema, "cf/mixed.json", log);

		expect(results).toHaveLength(1);
		// 3 individual skip warnings + 1 high rejection warning
		expect(log.warn).toHaveBeenCalledTimes(4);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("High rejection rate"),
		);
	});

	it("should not warn on acceptable rejection rate (<=50%)", () => {
		const log = createMockLogger();
		const items = [VALID_CUSTOM_FORMAT, VALID_CUSTOM_FORMAT, { bad: true }];

		const results = validateAndCollect(items, trashCustomFormatSchema, "cf/ok.json", log);

		expect(results).toHaveLength(2);
		// 1 skip warning, NO high rejection warning
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping invalid item 2"));
	});

	it("should handle empty array input", () => {
		const log = createMockLogger();

		const results = validateAndCollect([], trashCustomFormatSchema, "cf/empty.json", log);

		expect(results).toHaveLength(0);
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("should apply schema transforms (lowercase trash_id)", () => {
		const log = createMockLogger();
		const cfWithUpperId = {
			...VALID_CUSTOM_FORMAT,
			trash_id: "ABCDEF1234567890ABCDEF1234567890",
		};

		const results = validateAndCollect([cfWithUpperId], trashCustomFormatSchema, "cf/test.json", log);

		expect(results).toHaveLength(1);
		expect(results[0]!.trash_id).toBe("abcdef1234567890abcdef1234567890");
	});

	it("should work with naming schemas that inject _service", () => {
		const log = createMockLogger();

		const results = validateAndCollect(VALID_RADARR_NAMING, radarrNamingSchema, "naming/radarr.json", log);

		expect(results).toHaveLength(1);
		expect(results[0]!._service).toBe("RADARR");
	});
});
