import type { CalendarItem } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { getCalendarDateKey } from "./calendar-formatters";

const createItem = (overrides: Partial<CalendarItem> = {}): CalendarItem => ({
	id: 1,
	title: "Test event",
	service: "sonarr",
	type: "episode",
	instanceId: "sonarr-1",
	instanceName: "Sonarr",
	...overrides,
});

describe("getCalendarDateKey", () => {
	it("uses the local day of a Sonarr airDateUtc for timezones east of UTC", () => {
		const item = createItem({
			airDate: "2026-08-16",
			airDateUtc: "2026-08-17T00:00:00Z",
		});

		expect(getCalendarDateKey(item, "Europe/Stockholm")).toBe("2026-08-17");
	});

	it("uses the local day of a Sonarr airDateUtc for timezones west of UTC", () => {
		const item = createItem({
			airDate: "2026-08-16",
			airDateUtc: "2026-08-17T00:00:00Z",
		});

		expect(getCalendarDateKey(item, "America/New_York")).toBe("2026-08-16");
	});

	it("preserves date-only semantics for non-Sonarr services", () => {
		const item = createItem({
			service: "radarr",
			type: "movie",
			airDate: "2026-08-17T00:00:00Z",
			airDateUtc: "2026-08-17T00:00:00Z",
		});

		expect(getCalendarDateKey(item, "America/Los_Angeles")).toBe("2026-08-17");
	});

	it("falls back to airDate when Sonarr provides an invalid UTC timestamp", () => {
		const item = createItem({
			airDate: "2026-08-17",
			airDateUtc: "not-a-date",
		});

		expect(getCalendarDateKey(item, "Europe/Stockholm")).toBe("2026-08-17");
	});

	it("returns undefined when an item has no calendar date", () => {
		expect(getCalendarDateKey(createItem(), "Europe/Stockholm")).toBeUndefined();
	});
});
