/**
 * Locks in the trash_id mapping for the migration-notices registry.
 * If TRaSH renames a group again, the differ will silently stop firing
 * the hint unless this test catches the drift.
 *
 * Also pins the trust-correctness rule: notices suppress once the user
 * has both the kept and introduced groups (migration complete).
 */

import { describe, expect, it } from "vitest";
import { getMigrationNotices } from "../migration-notices.js";

const RADARR_OPTIONAL_MISCELLANEOUS = "9337080378236ce4c0b183e35790d2a7";
const RADARR_UNWANTED_FORMATS = "a3ac6af01d78e4f21fcb75f601ac96df";
const SONARR_OPTIONAL_MISCELLANEOUS = "f4a0410a1df109a66d6e47dcadcce014";
const SONARR_UNWANTED_FORMATS = "59c3af66780d08332fdc64e68297098f";

describe("getMigrationNotices", () => {
	it("emits the unwanted-formats notice for Radarr templates that contain only [Optional] Miscellaneous", () => {
		const notices = getMigrationNotices("RADARR", new Set([RADARR_OPTIONAL_MISCELLANEOUS]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2711-radarr-unwanted-formats");
	});

	it("emits the unwanted-formats notice for Sonarr templates that contain only [Optional] Miscellaneous", () => {
		const notices = getMigrationNotices("SONARR", new Set([SONARR_OPTIONAL_MISCELLANEOUS]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2711-sonarr-unwanted-formats");
	});

	it("returns nothing for templates that don't contain a registered kept group", () => {
		expect(getMigrationNotices("RADARR", new Set(["unrelated-trash-id"]))).toEqual([]);
		expect(getMigrationNotices("SONARR", new Set())).toEqual([]);
	});

	it("does not cross service boundaries (Radarr id should not match in Sonarr template)", () => {
		const notices = getMigrationNotices("SONARR", new Set([RADARR_OPTIONAL_MISCELLANEOUS]));
		expect(notices).toEqual([]);
	});

	it("suppresses the Radarr notice when the migration is already complete (both groups present)", () => {
		const notices = getMigrationNotices(
			"RADARR",
			new Set([RADARR_OPTIONAL_MISCELLANEOUS, RADARR_UNWANTED_FORMATS]),
		);
		expect(notices).toEqual([]);
	});

	it("suppresses the Sonarr notice when the migration is already complete (both groups present)", () => {
		const notices = getMigrationNotices(
			"SONARR",
			new Set([SONARR_OPTIONAL_MISCELLANEOUS, SONARR_UNWANTED_FORMATS]),
		);
		expect(notices).toEqual([]);
	});

	it("does not fire when only the introduced group is present (user added unwanted-formats but never had optional-miscellaneous)", () => {
		const notices = getMigrationNotices("RADARR", new Set([RADARR_UNWANTED_FORMATS]));
		expect(notices).toEqual([]);
	});
});
