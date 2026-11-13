import type { CalendarItem, MultiInstanceCalendarResponse } from "@arr/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCalendarData } from "../use-calendar-data";
import type { CalendarFilters } from "../use-calendar-state";

const filters: CalendarFilters = {
	serviceFilter: "all",
	instanceFilter: "all",
	searchTerm: "",
	includeUnmonitored: false,
};
const range = { start: "2026-10-01", end: "2026-10-31" };
const event: CalendarItem = {
	id: 31,
	service: "radarr",
	type: "movie",
	title: "Synthetic event",
	tmdbId: 42,
	airDate: "2026-10-15",
	instanceId: "north",
	instanceName: "North",
};
const source: MultiInstanceCalendarResponse["instances"][number] = {
	instanceId: "north",
	instanceName: "North",
	service: "radarr",
	data: [event],
	availability: "available",
	reason: null,
	rejectedItemCount: 0,
};
const failed: MultiInstanceCalendarResponse["instances"][number] = {
	instanceId: "south",
	instanceName: "South",
	service: "sonarr",
	data: [],
	availability: "unavailable",
	reason: "provider-unavailable",
	rejectedItemCount: 0,
};
const data: MultiInstanceCalendarResponse = {
	instances: [source, failed],
	aggregated: [event],
	totalCount: 1,
	availability: "partial",
};

describe("selected Calendar source evidence", () => {
	it.each([
		{ selected: filters, want: "partial", count: 1 },
		{ selected: { ...filters, serviceFilter: "radarr" as const }, want: "available", count: 1 },
		{ selected: { ...filters, serviceFilter: "sonarr" as const }, want: "unavailable", count: 0 },
		{ selected: { ...filters, instanceFilter: "south" }, want: "unavailable", count: 0 },
		{ selected: { ...filters, instanceFilter: "north" }, want: "available", count: 1 },
		{ selected: { ...filters, instanceFilter: "deleted" }, want: "not-configured", count: 0 },
		{ selected: { ...filters, searchTerm: "no match" }, want: "partial", count: 0 },
		{
			selected: { ...filters, serviceFilter: "readarr" as const },
			want: "not-configured",
			count: 0,
		},
	])("derives source availability before display filtering %#", ({ selected, want, count }) => {
		const { result } = renderHook(() => useCalendarData(data, undefined, selected, range));
		expect(result.current.availability).toBe(want);
		expect(result.current.filteredEvents).toHaveLength(count);
	});
	it("date clipping cannot erase incomplete coverage", () => {
		const { result } = renderHook(() =>
			useCalendarData(data, undefined, filters, { start: "2026-11-01", end: "2026-11-30" }),
		);
		expect(result.current.filteredEvents).toHaveLength(0);
		expect(result.current.availability).toBe("partial");
	});
	it("deduplicates positive schedules without hiding failed source coverage", () => {
		const second = { ...event, id: 32, instanceId: "east", instanceName: "East" };
		const duplicated = {
			...data,
			instances: [
				...data.instances,
				{ ...source, instanceId: "east", instanceName: "East", data: [second] },
			],
			aggregated: [event, second],
			totalCount: 2,
		};
		const { result } = renderHook(() => useCalendarData(duplicated, undefined, filters, range));
		expect(result.current.availability).toBe("partial");
		expect(result.current.filteredEvents).toHaveLength(1);
		expect(result.current.filteredEvents[0]?.allInstances).toEqual([
			{ instanceId: "north", instanceName: "North" },
			{ instanceId: "east", instanceName: "East" },
		]);
	});
	it("updates source evidence on recovery without effect state", () => {
		const { result, rerender } = renderHook(
			({ current }) => useCalendarData(current, undefined, filters, range),
			{ initialProps: { current: data } },
		);
		expect(result.current.availability).toBe("partial");
		rerender({
			current: {
				...data,
				availability: "available",
				instances: [source, { ...failed, availability: "available", reason: null }],
			},
		});
		expect(result.current.availability).toBe("available");
	});
	it("does not invent healthy coverage without a response", () => {
		const { result } = renderHook(() => useCalendarData(undefined, undefined, filters, range));
		expect(result.current.availability).toBe("unavailable");
	});
	it.each([
		{ service: "sonarr", type: "episode" },
		{ service: "radarr", type: "movie" },
		{ service: "lidarr", type: "album" },
		{ service: "readarr", type: "book" },
	] as const)("selects complete $service evidence independently", ({ service, type }) => {
		const selectedEvent = { ...event, service, type };
		const selectedData: MultiInstanceCalendarResponse = {
			instances: [{ ...source, service, data: [selectedEvent] }],
			aggregated: [selectedEvent],
			totalCount: 1,
			availability: "available",
		};
		const { result } = renderHook(() =>
			useCalendarData(selectedData, undefined, { ...filters, serviceFilter: service }, range),
		);
		expect(result.current.availability).toBe("available");
		expect(result.current.filteredEvents[0]?.id).toBe(31);
	});
	it.each([
		{
			boundary: "outside the local month",
			airDate: "2026-10-31",
			airDateUtc: new Date(2026, 10, 1, 0, 30).toISOString(),
			count: 0,
		},
		{
			boundary: "inside the local month",
			airDate: "2026-11-01",
			airDateUtc: new Date(2026, 9, 31, 23, 30).toISOString(),
			count: 1,
		},
	])(
		"clips a padded timestamp $boundary by its actual local date",
		({ airDate, airDateUtc, count }) => {
			const scheduled: CalendarItem = {
				...event,
				service: "sonarr",
				type: "episode",
				airDate,
				airDateUtc,
			};
			const { result } = renderHook(() =>
				useCalendarData(
					{
						...data,
						instances: [{ ...source, service: "sonarr", data: [scheduled] }, failed],
						aggregated: [scheduled],
					},
					undefined,
					filters,
					range,
				),
			);
			expect(result.current.filteredEvents).toHaveLength(count);
			expect(result.current.availability).toBe("partial");
		},
	);
});
