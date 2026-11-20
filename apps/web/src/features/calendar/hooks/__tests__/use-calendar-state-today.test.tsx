import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCalendarState } from "../use-calendar-state";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const localDays = [
	{
		label: "afternoon near UTC midnight",
		year: 2026,
		month: 8,
		day: 26,
		hour: 18,
		key: "2026-09-26",
	},
	{
		label: "last afternoon of the year",
		year: 2026,
		month: 11,
		day: 31,
		hour: 18,
		key: "2026-12-31",
	},
	{ label: "first minutes of the year", year: 2027, month: 0, day: 1, hour: 0, key: "2027-01-01" },
];

describe("viewer-local Calendar Today", () => {
	it.each(localDays)(
		"initializes month and selected day for $label",
		({ year, month, day, hour, key }) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(year, month, day, hour, 22, 3));

			const { result } = renderHook(() => useCalendarState());

			expect(result.current.currentMonth.toISOString()).toBe(`${key.slice(0, 7)}-01T00:00:00.000Z`);
			expect(result.current.selectedDate?.toISOString()).toBe(`${key}T00:00:00.000Z`);
			expect(result.current.daysInView).toHaveLength(42);
			expect(result.current.daysInView.every((date) => date.getUTCHours() === 0)).toBe(true);
		},
	);

	it.each(localDays)(
		"Go Today returns to the local month and day for $label",
		({ year, month, day, hour, key }) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2025, 5, 15, 12));
			const { result } = renderHook(() => useCalendarState(1));

			act(() => result.current.handlePreviousMonth());
			expect(result.current.currentMonth.toISOString()).toBe("2025-05-01T00:00:00.000Z");
			act(() => result.current.handleNextMonth());
			expect(result.current.currentMonth.toISOString()).toBe("2025-06-01T00:00:00.000Z");

			vi.setSystemTime(new Date(year, month, day, hour, 22, 3));
			act(() => result.current.handleGoToday());

			expect(result.current.currentMonth.toISOString()).toBe(`${key.slice(0, 7)}-01T00:00:00.000Z`);
			expect(result.current.selectedDate?.toISOString()).toBe(`${key}T00:00:00.000Z`);
			expect(result.current.calendarStart.getUTCDay()).toBe(1);
			expect(result.current.daysInView).toHaveLength(42);
		},
	);
});
