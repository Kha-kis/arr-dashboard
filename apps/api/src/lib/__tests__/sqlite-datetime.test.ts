import { describe, expect, it } from "vitest";
import { encodeCanonicalSqliteDate, SqliteDateCompatibilityError } from "../sqlite-datetime.js";

describe("canonical SQLite date compatibility", () => {
	it.each([
		[0, "1970-01-01T00:00:00.000+00:00"],
		[-1, "1969-12-31T23:59:59.999+00:00"],
		[1000, "1970-01-01T00:00:01.000+00:00"],
		[1700000000001, "2023-11-14T22:13:20.001+00:00"],
		[-8640000000000000, "-271821-04-20T00:00:00.000+00:00"],
		[8640000000000000, "+275760-09-13T00:00:00.000+00:00"],
		["1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000+00:00"],
		["2024-02-29T12:30:45.123Z", "2024-02-29T12:30:45.123+00:00"],
		["2024-02-29T12:30:45.123+00:00", "2024-02-29T12:30:45.123+00:00"],
		["2024-02-29T14:30:45.123+02:00", "2024-02-29T12:30:45.123+00:00"],
		["2024-02-29T07:00:45.123-05:30", "2024-02-29T12:30:45.123+00:00"],
		["1970-01-01T00:30:00+01:00", "1969-12-31T23:30:00.000+00:00"],
		["2024-02-29T12:30:45.1Z", "2024-02-29T12:30:45.100+00:00"],
		["2024-02-29T12:30:45.12Z", "2024-02-29T12:30:45.120+00:00"],
		["2024-02-29T12:30:45.123000000Z", "2024-02-29T12:30:45.123+00:00"],
		["2024-02-29 12:30:45", "2024-02-29T12:30:45.000+00:00"],
		["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000+00:00"],
		["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000+00:00"],
		["+010000-01-01T00:00:00Z", "+010000-01-01T00:00:00.000+00:00"],
	])("preserves the exact instant of %s", (value, expected) => {
		expect(encodeCanonicalSqliteDate(value, false)).toBe(expected);
		expect(encodeCanonicalSqliteDate(expected, false)).toBe(expected);
	});

	it("preserves nullable absence without inventing an instant", () => {
		expect(encodeCanonicalSqliteDate(null, true)).toBeNull();
	});

	it.each([
		null,
		undefined,
		true,
		{},
		new Date(0),
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		8640000000000001,
		-8640000000000001,
		Number.MAX_SAFE_INTEGER + 1,
		"",
		"1700000000000",
		" 2024-02-29T00:00:00Z",
		"2024-02-29T00:00:00Z ",
		"2024-02-29",
		"2024-02-29T00:00:00",
		"2024-02-29 00:00:00.123",
		"2024-02-29T00:00:00.1231Z",
		"2024-02-29T00:00:00.123000001Z",
		"2024-02-29T00:00:00.1230000000Z",
		"2023-02-29T00:00:00Z",
		"2024-02-30T00:00:00Z",
		"1900-02-29T00:00:00Z",
		"2024-04-31T00:00:00Z",
		"2024-00-01T00:00:00Z",
		"2024-13-01T00:00:00Z",
		"2024-01-00T00:00:00Z",
		"2024-01-32T00:00:00Z",
		"2024-02-29T24:00:00Z",
		"2024-02-29T00:60:00Z",
		"2024-02-29T00:00:60Z",
		"2024-02-29T00:00:00+24:00",
		"2024-02-29T00:00:00+00:60",
		"2024-02-29T00:00:00+0200",
		"-000000-01-01T00:00:00Z",
		"+999999-01-01T00:00:00Z",
	])("refuses invalid or lossy nonnullable evidence %s", (value) => {
		expect(() => encodeCanonicalSqliteDate(value, false)).toThrow(SqliteDateCompatibilityError);
	});

	it("nullable columns still refuse malformed non-null evidence", () => {
		expect(() => encodeCanonicalSqliteDate("2024-02-30 00:00:00", true)).toThrow(
			SqliteDateCompatibilityError,
		);
	});

	it("reports a generic actionable category without retaining the input", () => {
		try {
			encodeCanonicalSqliteDate("private-invalid-value", false);
			throw new Error("Expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(SqliteDateCompatibilityError);
			expect(error).toMatchObject({ category: "format-migration-required" });
			expect(String(error)).not.toContain("private-invalid-value");
		}
	});
});
