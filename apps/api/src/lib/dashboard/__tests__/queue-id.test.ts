import { describe, expect, it } from "vitest";
import { parseQueueId } from "../queue-utils.js";

describe("destructive queue identity parsing", () => {
	it.each([
		{ value: 1, expected: 1 },
		{ value: 11, expected: 11 },
		{ value: "11", expected: 11 },
		{ value: " 11 ", expected: 11 },
		{ value: "0011", expected: 11 },
		{ value: 4294967296, expected: 4294967296 },
		{ value: "4294967296", expected: 4294967296 },
		{ value: 9007199254740991, expected: 9007199254740991 },
		{ value: "9007199254740991", expected: 9007199254740991 },
	])("preserves exact positive safe decimal identity $value", ({ value, expected }) => {
		expect(parseQueueId(value)).toBe(expected);
	});

	it.each([
		"11garbage",
		"11.9",
		"11e3",
		"+11",
		"-11",
		"0x0b",
		"",
		" \t\n ",
		"0",
		"0000",
		"9007199254740992",
		"9999999999999999999999999999999999999999",
		"١١",
		"１１",
		"11\n12",
		"1_1",
		"11.",
		".11",
		0,
		-0,
		-1,
		11.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		9007199254740992,
	])(
		"refuses malformed, nonpositive or unsafe identity %j instead of selecting another target",
		(value) => {
			expect(parseQueueId(value)).toBeNull();
		},
	);
});
