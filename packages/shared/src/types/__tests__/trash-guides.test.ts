/**
 * Unit tests for TRaSH Guides type helpers
 *
 * Tests the isCFGroupApplicableToProfile function which handles
 * both legacy `exclude` semantics and new `include` semantics (TRaSH Guides PR #2590)
 */

import { describe, it, expect } from "vitest";
import {
	isCFGroupApplicableToProfile,
	type TrashCustomFormatGroup,
} from "../trash-guides.js";

// ============================================================================
// Helper factories for test data
// ============================================================================

/**
 * Creates a CF Group with legacy `exclude` semantics
 */
function createGroupWithExclude(
	trashId: string,
	excludedProfiles: Record<string, string>,
): TrashCustomFormatGroup {
	return {
		trash_id: trashId,
		name: `Test Group (${trashId})`,
		custom_formats: [],
		quality_profiles: {
			exclude: excludedProfiles,
		},
	};
}

/**
 * Creates a CF Group with new `include` semantics (TRaSH Guides PR #2590)
 */
function createGroupWithInclude(
	trashId: string,
	includedProfiles: Record<string, string>,
): TrashCustomFormatGroup {
	return {
		trash_id: trashId,
		name: `Test Group (${trashId})`,
		custom_formats: [],
		quality_profiles: {
			include: includedProfiles,
		},
	};
}

/**
 * Creates a CF Group with no profile restrictions
 */
function createGroupWithNoRestrictions(trashId: string): TrashCustomFormatGroup {
	return {
		trash_id: trashId,
		name: `Test Group (${trashId})`,
		custom_formats: [],
	};
}

// ============================================================================
// Test Suite: isCFGroupApplicableToProfile
// ============================================================================

describe("isCFGroupApplicableToProfile", () => {
	const PROFILE_HD_BLURAY = "hd-bluray-trash-id";
	const PROFILE_UHD_BLURAY = "uhd-bluray-trash-id";
	const PROFILE_WEB_1080P = "web-1080p-trash-id";
	const PROFILE_ANIME = "anime-trash-id";

	describe("Legacy exclude semantics", () => {
		it("should return true for profiles NOT in exclude list", () => {
			const group = createGroupWithExclude("group-1", {
				"excluded-profile": PROFILE_UHD_BLURAY,
			});

			// These profiles are NOT excluded, so group applies
			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_WEB_1080P)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_ANIME)).toBe(true);
		});

		it("should return false for profiles IN exclude list", () => {
			const group = createGroupWithExclude("group-1", {
				"excluded-profile": PROFILE_UHD_BLURAY,
			});

			// This profile IS excluded, so group does NOT apply
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
		});

		it("should handle multiple excluded profiles", () => {
			const group = createGroupWithExclude("group-1", {
				"excluded-1": PROFILE_UHD_BLURAY,
				"excluded-2": PROFILE_ANIME,
			});

			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
			expect(isCFGroupApplicableToProfile(group, PROFILE_ANIME)).toBe(false);
		});

		it("should handle empty exclude object (applies to all)", () => {
			const group = createGroupWithExclude("group-1", {});

			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(true);
		});
	});

	describe("New include semantics (TRaSH Guides PR #2590)", () => {
		it("should return true for profiles IN include list", () => {
			const group = createGroupWithInclude("group-1", {
				"included-profile": PROFILE_HD_BLURAY,
			});

			// This profile IS included, so group applies
			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
		});

		it("should return false for profiles NOT in include list", () => {
			const group = createGroupWithInclude("group-1", {
				"included-profile": PROFILE_HD_BLURAY,
			});

			// These profiles are NOT included, so group does NOT apply
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
			expect(isCFGroupApplicableToProfile(group, PROFILE_WEB_1080P)).toBe(false);
			expect(isCFGroupApplicableToProfile(group, PROFILE_ANIME)).toBe(false);
		});

		it("should handle multiple included profiles", () => {
			const group = createGroupWithInclude("group-1", {
				"included-1": PROFILE_HD_BLURAY,
				"included-2": PROFILE_WEB_1080P,
			});

			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_WEB_1080P)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
		});

		it("should handle empty include object (applies to none)", () => {
			const group = createGroupWithInclude("group-1", {});

			// Empty include means no profiles are included
			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(false);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
		});
	});

	describe("Priority: include takes precedence over exclude", () => {
		it("should use include semantics when both include and exclude are present", () => {
			// This shouldn't happen in practice, but test the priority
			const group: TrashCustomFormatGroup = {
				trash_id: "group-1",
				name: "Test Group",
				custom_formats: [],
				quality_profiles: {
					include: {
						"included": PROFILE_HD_BLURAY,
					},
					exclude: {
						"excluded": PROFILE_HD_BLURAY, // Same profile in both!
					},
				},
			};

			// Include takes priority - HD_BLURAY is included, so it should apply
			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			// Other profiles not in include list should not apply
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(false);
		});
	});

	describe("No restrictions (applies to all profiles)", () => {
		it("should return true when quality_profiles is undefined", () => {
			const group = createGroupWithNoRestrictions("group-1");

			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_WEB_1080P)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_ANIME)).toBe(true);
		});

		it("should return true when quality_profiles has only score", () => {
			const group: TrashCustomFormatGroup = {
				trash_id: "group-1",
				name: "Test Group",
				custom_formats: [],
				quality_profiles: {
					score: 100,
				},
			};

			expect(isCFGroupApplicableToProfile(group, PROFILE_HD_BLURAY)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, PROFILE_UHD_BLURAY)).toBe(true);
		});
	});

	describe("Edge cases", () => {
		it("should handle profile IDs with special characters", () => {
			const profileWithDash = "profile-with-dashes";
			const profileWithUnderscore = "profile_with_underscores";

			const group = createGroupWithInclude("group-1", {
				"special-1": profileWithDash,
				"special-2": profileWithUnderscore,
			});

			expect(isCFGroupApplicableToProfile(group, profileWithDash)).toBe(true);
			expect(isCFGroupApplicableToProfile(group, profileWithUnderscore)).toBe(true);
		});

		it("should be case-sensitive for profile IDs", () => {
			const group = createGroupWithInclude("group-1", {
				"included": "Profile-ID",
			});

			expect(isCFGroupApplicableToProfile(group, "Profile-ID")).toBe(true);
			expect(isCFGroupApplicableToProfile(group, "profile-id")).toBe(false);
			expect(isCFGroupApplicableToProfile(group, "PROFILE-ID")).toBe(false);
		});

		it("should handle UUID-style profile IDs", () => {
			const uuidProfile = "550e8400-e29b-41d4-a716-446655440000";

			const group = createGroupWithInclude("group-1", {
				"uuid-profile": uuidProfile,
			});

			expect(isCFGroupApplicableToProfile(group, uuidProfile)).toBe(true);
		});
	});
});
