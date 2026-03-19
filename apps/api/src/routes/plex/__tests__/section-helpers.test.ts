import { describe, expect, it } from "vitest";
import { mapToSections } from "../lib/section-helpers.js";

describe("mapToSections", () => {
	const instanceNameMap = new Map([
		["inst-1", "My Plex"],
		["inst-2", "Remote Plex"],
	]);

	it("maps groupBy rows to PlexSection objects", () => {
		const groups = [
			{ instanceId: "inst-1", sectionId: "1", sectionTitle: "Movies", mediaType: "movie" },
			{ instanceId: "inst-2", sectionId: "3", sectionTitle: "TV Shows", mediaType: "show" },
		];

		const sections = mapToSections(groups, instanceNameMap);

		expect(sections).toEqual([
			{
				instanceId: "inst-1",
				instanceName: "My Plex",
				sectionId: "1",
				sectionTitle: "Movies",
				mediaType: "movie",
			},
			{
				instanceId: "inst-2",
				instanceName: "Remote Plex",
				sectionId: "3",
				sectionTitle: "TV Shows",
				mediaType: "show",
			},
		]);
	});

	it("returns 'Unknown' for unmapped instance IDs", () => {
		const groups = [
			{ instanceId: "inst-999", sectionId: "1", sectionTitle: "Movies", mediaType: "movie" },
		];

		const sections = mapToSections(groups, instanceNameMap);
		expect(sections[0]!.instanceName).toBe("Unknown");
	});

	it("returns empty array for empty input", () => {
		expect(mapToSections([], instanceNameMap)).toEqual([]);
	});
});
