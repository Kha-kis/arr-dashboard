import { describe, expect, it } from "vitest";
import { evaluatePlexLiveSettlement } from "../plex-live-settlement.js";

const sections = [
	{
		key: "1",
		uuid: "movies-uuid",
		title: "Movies",
		type: "movie" as const,
		refreshing: false,
		scannedAt: 1_777_000_000,
		updatedAt: 1_777_000_100,
	},
	{
		key: "2",
		uuid: "music-uuid",
		title: "Music",
		type: "artist" as const,
		refreshing: false,
		scannedAt: 1_777_000_000,
		updatedAt: 1_777_000_100,
	},
];

describe("Plex live settlement classification", () => {
	it("accepts a settled supported selection", () => {
		expect(
			evaluatePlexLiveSettlement({ activities: [], sections, selectedSectionKeys: ["1"] }),
		).toEqual({ settled: true, reasonCodes: [] });
	});

	it.each([
		[
			"supported section scan",
			[{ type: "library.update.section", Context: { librarySectionID: "1" } }],
			["plex_library_scan_in_progress"],
		],
		[
			"unattributable metadata refresh",
			[{ type: "library.update.item.metadata" }],
			["plex_metadata_refresh_in_progress"],
		],
		[
			"malformed library activity",
			[{ type: "library.update.section", Context: {} }],
			["plex_library_activity_unknown"],
		],
		[
			"unknown library activity",
			[{ type: "library.update.mystery" }],
			["plex_library_activity_unknown"],
		],
	] as const)("fails closed for %s", (_name, activities, reasonCodes) => {
		expect(
			evaluatePlexLiveSettlement({ activities, sections, selectedSectionKeys: ["1"] }),
		).toEqual({ settled: false, reasonCodes });
	});

	it("does not let an attributed unsupported music scan revoke Movie authority", () => {
		expect(
			evaluatePlexLiveSettlement({
				activities: [{ type: "library.update.section", Context: { librarySectionID: "2" } }],
				sections,
				selectedSectionKeys: ["1"],
			}),
		).toEqual({ settled: true, reasonCodes: [] });
	});

	it("fails a refreshing supported section even without activity", () => {
		expect(
			evaluatePlexLiveSettlement({
				activities: [],
				sections: [{ ...sections[0]!, refreshing: true }, sections[1]!],
				selectedSectionKeys: ["1"],
			}),
		).toEqual({ settled: false, reasonCodes: ["plex_library_scan_in_progress"] });
	});

	it("fails closed when a new supported section has no completed scan revision", () => {
		expect(
			evaluatePlexLiveSettlement({
				activities: [],
				sections: [{ ...sections[0]!, scannedAt: null }, sections[1]!],
				selectedSectionKeys: ["1"],
			}),
		).toEqual({ settled: false, reasonCodes: ["plex_library_revision_changed"] });
	});

	it("ignores validated unrelated non-library activity", () => {
		expect(
			evaluatePlexLiveSettlement({
				activities: [{ type: "media.generate.bif" }],
				sections,
				selectedSectionKeys: ["1"],
			}),
		).toEqual({ settled: true, reasonCodes: [] });
	});
});
