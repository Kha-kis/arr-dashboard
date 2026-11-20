import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CalendarGrid } from "../calendar-grid";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	localStorage.clear();
});

describe("CalendarGrid viewer-local Today marker", () => {
	it.each([
		{ label: "afternoon", year: 2026, month: 8, day: 26, hour: 18 },
		{ label: "year end", year: 2026, month: 11, day: 31, hour: 18 },
		{ label: "year start", year: 2027, month: 0, day: 1, hour: 0 },
	])("draws the Today pulse on the local day at $label", ({ year, month, day, hour }) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(year, month, day, hour, 22, 3));
		const today = new Date(Date.UTC(year, month, day));
		const previous = new Date(Date.UTC(year, month, day - 1));
		const next = new Date(Date.UTC(year, month, day + 1));

		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<CalendarGrid
						days={[previous, today, next]}
						currentMonth={new Date(Date.UTC(year, month, 1))}
						selectedDate={null}
						onSelectDate={vi.fn()}
						eventsByDate={new Map()}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>,
		);

		// The existing pulse is the visual current-day marker; no test-only UI attributes.
		expect(
			screen.getByRole("button", { name: String(day) }).querySelector(".animate-ping"),
		).not.toBeNull();
		expect(
			screen
				.getByRole("button", { name: String(previous.getUTCDate()) })
				.querySelector(".animate-ping"),
		).toBeNull();
		expect(
			screen
				.getByRole("button", { name: String(next.getUTCDate()) })
				.querySelector(".animate-ping"),
		).toBeNull();
	});
});
