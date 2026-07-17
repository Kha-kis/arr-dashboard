import { describe, expect, it } from "vitest";
import { NAVIGATION_GROUPS, NAVIGATION_ITEMS } from "../navigation";

const AUTHENTICATED_ROUTES = [
	"/auto-tag",
	"/calendar",
	"/console",
	"/cross-seed",
	"/dashboard",
	"/discover",
	"/history",
	"/hunting",
	"/indexers",
	"/label-sync",
	"/library-cleanup",
	"/library",
	"/pulse",
	"/queue-cleaner",
	"/qui-activity",
	"/qui",
	"/requests",
	"/search",
	"/settings",
	"/statistics",
	"/trash-guides",
];

describe("authenticated navigation inventory", () => {
	it("gives every authenticated route exactly one navigation home", () => {
		const hrefs = NAVIGATION_ITEMS.map((item) => item.href).sort();

		expect(hrefs).toEqual([...AUTHENTICATED_ROUTES].sort());
		expect(new Set(hrefs)).toHaveLength(hrefs.length);
	});

	it("keeps media planning with the rest of the media workflow", () => {
		const media = NAVIGATION_GROUPS.find((group) => group.id === "media");

		expect(media?.items.map((item) => item.href)).toContain("/calendar");
		expect(media?.items.map((item) => item.href)).toContain("/history");
	});

	it("gives every destination a concise orientation cue for the shared shell", () => {
		expect(NAVIGATION_ITEMS.every((item) => item.description.trim().length > 0)).toBe(true);
	});
});
