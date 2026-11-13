import { describe, expect, expectTypeOf, it } from "vitest";
import { type ManualImportFetchQuery, manualImportFetchQuerySchema } from "../manual-import.js";

describe("manual import literal boolean query", () => {
	it.each([
		{ input: "false", expected: false },
		{ input: "true", expected: true },
		{ input: false, expected: false },
		{ input: true, expected: true },
	])("decodes $input as $expected without truthiness", ({ input, expected }) => {
		expect(manualImportFetchQuerySchema.parse({ filterExistingFiles: input })).toEqual({
			filterExistingFiles: expected,
		});
	});

	it("leaves an omitted filter undefined rather than inventing a default", () => {
		expect(manualImportFetchQuerySchema.parse({ downloadId: "source" })).toEqual({
			downloadId: "source",
		});
		expect(manualImportFetchQuerySchema.parse({}).filterExistingFiles).toBeUndefined();
	});

	it.each(
		[
			"",
			"0",
			"1",
			"yes",
			"no",
			"FALSE",
			"True",
			" false",
			"true ",
			0,
			1,
			-1,
			Number.NaN,
			null,
			[],
			["false"],
			["true", "false"],
			{},
			{ value: false },
		].map((input) => ({ input })),
	)("rejects nonboolean query value $input", ({ input }) => {
		expect(manualImportFetchQuerySchema.safeParse({ filterExistingFiles: input }).success).toBe(
			false,
		);
	});

	it("retains the optional boolean output contract", () => {
		expectTypeOf<ManualImportFetchQuery["filterExistingFiles"]>().toEqualTypeOf<
			boolean | undefined
		>();
	});
});
