import { describe, expect, it } from "vitest";
import { normalizeCalendarItem } from "../calendar-utils.js";

describe("scheduled Calendar row normalization", () => {
	it.each([
		null,
		[],
		"row",
		{ airDate: "2026-10-15" },
		{ id: 0, airDate: "2026-10-15" },
		{ id: " ", airDate: "2026-10-15" },
		{ id: 1, airDate: "2026-02-30" },
		{ id: 1 },
		{ id: 1, airDate: "2026-10-15", series: [] },
		{ id: 1, airDate: "2026-10-15", series: { images: [null] } },
	])("rejects an ineligible row %#", (row) => {
		expect(() => normalizeCalendarItem(row, "sonarr")).toThrow("Calendar item was invalid");
	});
	it("selects the first eligible stable identifier without inventing identity", () => {
		expect(
			normalizeCalendarItem(
				{ id: false, eventId: "  event-7  ", episodeId: 9, airDate: "2026-10-15" },
				"sonarr",
			).id,
		).toBe("event-7");
	});
	it.each(["id", "eventId", "episodeId", "movieId", "albumId", "bookId", "sourceId"])(
		"recognizes the existing %s identifier",
		(field) => {
			expect(normalizeCalendarItem({ [field]: 7, airDate: "2026-10-15" }, "sonarr").id).toBe(7);
		},
	);
	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, false, {}, []])(
		"rejects an invalid identifier without a eligible fallback %#",
		(id) => {
			expect(() => normalizeCalendarItem({ id, airDate: "2026-10-15" }, "sonarr")).toThrow(
				"Calendar item was invalid",
			);
		},
	);
	it("uses valid local date after invalid preferred UTC and preserves a leap day", () => {
		const row = normalizeCalendarItem(
			{ id: 1, airDateUtc: "2026-02-30T12:00:00Z", airDate: "2024-02-29" },
			"sonarr",
		);
		expect(row.airDate).toBe("2024-02-29");
		expect(row.airDateUtc).toBeUndefined();
	});
	it.each(["radarr", "lidarr", "readarr"] as const)("keeps %s date-only schedules", (service) => {
		expect(normalizeCalendarItem({ id: 1, releaseDate: "2026-10-15" }, service).airDate).toBe(
			"2026-10-15",
		);
	});
	it("uses the next valid Radarr release field", () => {
		expect(
			normalizeCalendarItem(
				{ id: 1, inCinemas: "2026-02-30", digitalRelease: "2026-10-15" },
				"radarr",
			).airDate,
		).toBe("2026-10-15");
	});
});
