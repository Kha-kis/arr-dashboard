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

// PR #2719 — split German unwanted formats into a dedicated group
const RADARR_RELEASE_GROUPS_GERMAN = "bc85e56ee3bd0f01467866d5f1261543";
const RADARR_UNWANTED_FORMATS_GERMAN = "0ca61b4b233178d07113082a7acff72d";
const SONARR_RELEASE_GROUPS_GERMAN = "cae54a0be4f9773169e82e129dd1fcfb";
const SONARR_UNWANTED_FORMATS_GERMAN = "6f0872eebfc95b1f93474b7ac866ced0";

// PR #2721 — split French unwanted formats into a dedicated group
const RADARR_RELEASE_GROUPS_FRENCH = "12a919c8a5e2342db6e9c0b4e3c0756e";
const RADARR_UNWANTED_FORMATS_FRENCH = "59f7ab9ff64d0026b011b985b1cc8670";
const SONARR_RELEASE_GROUPS_FRENCH = "9fa0bf3c8f8f00154431c3323a29eef2";
const SONARR_UNWANTED_FORMATS_FRENCH = "a23c8675c79118544fd74153394fa589";

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

	// PR #2719 — German unwanted formats
	it("emits the German unwanted-formats notice for Radarr templates anchored on [Release Groups] German", () => {
		const notices = getMigrationNotices("RADARR", new Set([RADARR_RELEASE_GROUPS_GERMAN]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2719-radarr-german-unwanted");
	});

	it("emits the German unwanted-formats notice for Sonarr templates anchored on [Release Groups] German", () => {
		const notices = getMigrationNotices("SONARR", new Set([SONARR_RELEASE_GROUPS_GERMAN]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2719-sonarr-german-unwanted");
	});

	it("suppresses the Radarr German notice when the new German unwanted group is already present", () => {
		const notices = getMigrationNotices(
			"RADARR",
			new Set([RADARR_RELEASE_GROUPS_GERMAN, RADARR_UNWANTED_FORMATS_GERMAN]),
		);
		expect(notices).toEqual([]);
	});

	it("suppresses the Sonarr German notice when the new German unwanted group is already present", () => {
		const notices = getMigrationNotices(
			"SONARR",
			new Set([SONARR_RELEASE_GROUPS_GERMAN, SONARR_UNWANTED_FORMATS_GERMAN]),
		);
		expect(notices).toEqual([]);
	});

	// PR #2721 — French unwanted formats
	it("emits the French unwanted-formats notice for Radarr templates anchored on [Release Groups] French", () => {
		const notices = getMigrationNotices("RADARR", new Set([RADARR_RELEASE_GROUPS_FRENCH]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2721-radarr-french-unwanted");
	});

	it("emits the French unwanted-formats notice for Sonarr templates anchored on [Release Groups] French", () => {
		const notices = getMigrationNotices("SONARR", new Set([SONARR_RELEASE_GROUPS_FRENCH]));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.id).toBe("trash-pr-2721-sonarr-french-unwanted");
	});

	it("suppresses the Radarr French notice when the new French unwanted group is already present", () => {
		const notices = getMigrationNotices(
			"RADARR",
			new Set([RADARR_RELEASE_GROUPS_FRENCH, RADARR_UNWANTED_FORMATS_FRENCH]),
		);
		expect(notices).toEqual([]);
	});

	it("suppresses the Sonarr French notice when the new French unwanted group is already present", () => {
		const notices = getMigrationNotices(
			"SONARR",
			new Set([SONARR_RELEASE_GROUPS_FRENCH, SONARR_UNWANTED_FORMATS_FRENCH]),
		);
		expect(notices).toEqual([]);
	});

	// Co-occurrence sanity: a German Radarr template that happens to also have the
	// generic optional-miscellaneous group should fire BOTH the #2711 and #2719
	// notices, not be deduped. This pins that the registry walks all entries.
	it("emits both #2711 and #2719 Radarr notices when a template has both the generic and German anchors", () => {
		const notices = getMigrationNotices(
			"RADARR",
			new Set([RADARR_OPTIONAL_MISCELLANEOUS, RADARR_RELEASE_GROUPS_GERMAN]),
		);
		const ids = notices.map((n) => n.id).sort();
		expect(ids).toEqual([
			"trash-pr-2711-radarr-unwanted-formats",
			"trash-pr-2719-radarr-german-unwanted",
		]);
	});
});
