import { describe, expect, it } from "vitest";
import {
	isCanonicalTautulliNonNegativeSafeInteger,
	parseCanonicalTautulliNonNegativeSafeInteger,
} from "../tautulli-canonical-numbers.js";

describe("canonical Tautulli authority numbers", () => {
	it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])("accepts canonical numeric %s", (value) => {
		expect(isCanonicalTautulliNonNegativeSafeInteger(value)).toBe(true);
		expect(parseCanonicalTautulliNonNegativeSafeInteger(value)).toBe(value);
	});

	it.each([
		["0", 0],
		["1", 1],
		["42", 42],
		[String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
	] as const)("accepts canonical string %s", (value, expected) => {
		expect(parseCanonicalTautulliNonNegativeSafeInteger(value)).toBe(expected);
	});

	it.each([
		-0,
		-1,
		Number.MIN_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER + 1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		false,
		true,
		"",
		" ",
		"\t",
		"\n",
		"+0",
		"+1",
		"-0",
		"-1",
		"00",
		"01",
		"1.0",
		"1.5",
		"1e2",
		"NaN",
		"Infinity",
		"-Infinity",
		{},
		[],
		null,
		undefined,
		new Number(0),
	])("rejects noncanonical value %#", (value) => {
		expect(isCanonicalTautulliNonNegativeSafeInteger(value)).toBe(false);
		expect(parseCanonicalTautulliNonNegativeSafeInteger(value)).toBeNull();
	});
});
