import { describe, expect, it } from "vitest";
import {
	canonicalizeDateInput,
	getTimeRangeStart,
	localDateInputValue,
	validateDateRange,
} from "./date-utils";

describe("History date bounds", () => {
	it("canonicalizes local start and inclusive local end with milliseconds", () => {
		expect(canonicalizeDateInput("2026-09-01", "start")).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/,
		);
		expect(canonicalizeDateInput("2026-09-01", "end")).toMatch(
			/^\d{4}-\d{2}-\d{02}T\d{2}:\d{2}:\d{2}\.999Z$/,
		);
	});

	it("rejects rollover and invalid input instead of broadening to null", () => {
		expect(canonicalizeDateInput("2026-02-30", "start")).toBeNull();
		expect(canonicalizeDateInput("not-a-date", "end")).toBeNull();
		expect(localDateInputValue("2026-09-01T00:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("rejects both reversed edit orders and accepts clearing", () => {
		expect(validateDateRange("2026-09-02T00:00:00.000Z", "2026-09-01T23:59:59.999Z")).toBe(false);
		expect(validateDateRange("2026-09-02T00:00:00.000Z", "2026-09-01T23:59:59.999Z")).toBe(false);
		expect(validateDateRange("", "2026-09-01T23:59:59.999Z")).toBe(true);
	});

	it("keeps preset semantics", () => {
		expect(getTimeRangeStart("all")).toBeUndefined();
		expect(getTimeRangeStart("24h")).toMatch(/\.\d{3}Z$/);
	});
});
