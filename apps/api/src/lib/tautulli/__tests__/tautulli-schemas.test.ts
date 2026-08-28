/**
 * Tests for Tautulli Zod schemas.
 *
 * Particular focus on the get_metadata schema's tolerance of missing fields —
 * Tautulli's get_metadata API returns a "success" envelope with sparse data
 * when the rating_key isn't in its database (item deleted from Plex but still
 * in watch history). See issue #497.
 */
import { describe, expect, it } from "vitest";
import {
	parseTautulliPlayCount,
	tautulliHistoryDataSchema,
	tautulliLibraryMediaInfoSchema,
	tautulliMetadataSchema,
} from "../tautulli-schemas.js";

describe("tautulliMetadataSchema", () => {
	it("parses a full metadata response with all fields present", () => {
		const input = {
			guids: ["tmdb://12345", "imdb://tt1234567"],
			media_type: "movie",
			title: "The Matrix",
			rating_key: "118702",
			section_id: 7,
		};
		const result = tautulliMetadataSchema.parse(input);
		expect(result.guids).toEqual(["tmdb://12345", "imdb://tt1234567"]);
		expect(result.media_type).toBe("movie");
		expect(result.title).toBe("The Matrix");
		expect(result.rating_key).toBe("118702");
		expect(result.section_id).toBe("7");
	});

	it("accepts an empty {} response without throwing (#497 regression)", () => {
		// Tautulli's get_metadata sometimes returns `{response: {result: "success", data: {}}}`
		// when the rating_key isn't found in its DB (e.g., Plex item deleted).
		// Before the fix, this threw `UpstreamValidationError` for missing rating_key,
		// flooding Pulse/Dashboard with false-positive warnings. The schema now
		// tolerates empty data — callers use the local rating_key arg, not the
		// echoed one in the response.
		const result = tautulliMetadataSchema.parse({});
		expect(result.guids).toEqual([]);
		expect(result.media_type).toBe("unknown");
		expect(result.title).toBe("");
		expect(result.rating_key).toBeUndefined();
	});

	it("accepts partial responses with only some fields present", () => {
		// Real-world Tautulli responses can include some fields and omit others
		// depending on the metadata source. Each field should default
		// independently.
		const result = tautulliMetadataSchema.parse({
			title: "Partial Item",
			// guids, media_type, rating_key all missing
		});
		expect(result.guids).toEqual([]);
		expect(result.media_type).toBe("unknown");
		expect(result.title).toBe("Partial Item");
		expect(result.rating_key).toBeUndefined();
	});

	it("coerces numeric rating_key to string (Tautulli returns it as a number)", () => {
		const result = tautulliMetadataSchema.parse({
			guids: [],
			media_type: "movie",
			title: "Numeric Key Movie",
			rating_key: 118702,
		});
		expect(result.rating_key).toBe("118702");
	});

	it("preserves unknown extra fields (looseObject)", () => {
		// The schema uses z.looseObject, so unknown fields pass through —
		// important because Tautulli's API surface evolves and we should not
		// strip fields callers might want to read directly.
		const result = tautulliMetadataSchema.parse({
			guids: [],
			media_type: "movie",
			title: "X",
			rating_key: "1",
			year: 1999,
			summary: "A movie",
		}) as Record<string, unknown>;
		expect(result.year).toBe(1999);
		expect(result.summary).toBe("A movie");
	});

	it("treats null fields the same as missing (preprocess defaults)", () => {
		// Tautulli occasionally returns explicit nulls for fields it doesn't
		// know about. The preprocess wrappers normalize null and undefined.
		const result = tautulliMetadataSchema.parse({
			guids: null,
			media_type: null,
			title: null,
		});
		expect(result.guids).toEqual([]);
		expect(result.media_type).toBe("unknown");
		expect(result.title).toBe("");
	});
});

describe("tautulliLibraryMediaInfoSchema", () => {
	function parsePlayCount(playCount: unknown): number | null {
		const item: Record<string, unknown> = {
			section_id: "1",
			rating_key: "100",
			media_type: "movie",
			last_played: null,
		};
		if (playCount !== undefined) item.play_count = playCount;
		return tautulliLibraryMediaInfoSchema.parse({
			data: [item],
			recordsFiltered: 1,
			recordsTotal: 1,
			last_refreshed: 1,
		}).data[0]!.play_count;
	}

	it("normalizes the exact catalog fields without retaining titles or payload details", () => {
		const parsed = tautulliLibraryMediaInfoSchema.parse({
			data: [
				{
					section_id: 2,
					rating_key: 100,
					media_type: "movie",
					play_count: "3",
					last_played: "1777000000",
					title: "Sensitive",
				},
			],
			recordsFiltered: 1,
			recordsTotal: 1,
			last_refreshed: 1_777_000_001,
		});
		expect(parsed.data[0]).toMatchObject({
			section_id: "2",
			rating_key: "100",
			play_count: 3,
			last_played: 1_777_000_000,
		});
	});

	it("rejects malformed totals before collection", () => {
		expect(() =>
			tautulliLibraryMediaInfoSchema.parse({
				data: [],
				recordsFiltered: "many",
				recordsTotal: 0,
				last_refreshed: 1,
			}),
		).toThrow();
	});

	it.each([
		["recordsFiltered", { recordsFiltered: -0, recordsTotal: 0 }],
		["recordsTotal", { recordsFiltered: 0, recordsTotal: -0 }],
		["last_refreshed", { recordsFiltered: 0, recordsTotal: 0, last_refreshed: -0 }],
	] as const)("rejects negative zero in catalog %s", (_label, values) => {
		expect(() =>
			tautulliLibraryMediaInfoSchema.parse({
				data: [],
				recordsFiltered: values.recordsFiltered,
				recordsTotal: values.recordsTotal,
				last_refreshed: "last_refreshed" in values ? values.last_refreshed : null,
			}),
		).toThrow();
	});

	it.each([
		["null", null, null],
		["missing", undefined, null],
		["empty", "", null],
		["explicit zero", 0, 0],
		["canonical string zero", "0", 0],
		["positive integer one", 1, 1],
		["positive integer", 42, 42],
		["canonical positive string one", "1", 1],
		["canonical positive string", "42", 42],
		["maximum safe integer", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		[
			"canonical maximum safe integer string",
			String(Number.MAX_SAFE_INTEGER),
			Number.MAX_SAFE_INTEGER,
		],
	])("preserves %s play-count semantics", (_label, playCount, expected) => {
		expect(parseTautulliPlayCount(playCount)).toBe(expected);
		expect(parsePlayCount(playCount)).toBe(expected);
	});

	it.each([
		["numeric negative zero", -0],
		["false", false],
		["true", true],
		["space", " "],
		["tab", "\t"],
		["newline", "\n"],
		["plus sign", "+1"],
		["plus zero", "+0"],
		["negative zero", "-0"],
		["negative string", "-1"],
		["decimal zero", "1.0"],
		["fractional string", "1.5"],
		["exponent", "1e2"],
		["double zero", "00"],
		["leading zero", "01"],
		["NaN string", "NaN"],
		["Infinity string", "Infinity"],
		["object", {}],
		["array", []],
		["negative number", -1],
		["fractional number", 1.5],
		["NaN number", Number.NaN],
		["Infinity number", Number.POSITIVE_INFINITY],
		["negative Infinity number", Number.NEGATIVE_INFINITY],
		["minimum safe integer", Number.MIN_SAFE_INTEGER],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["boxed zero", new Number(0)],
	])("normalizes malformed %s play count to unknown", (_label, playCount) => {
		expect(parseTautulliPlayCount(playCount)).toBeNull();
		expect(parsePlayCount(playCount)).toBeNull();
	});
});

describe("tautulliHistoryDataSchema", () => {
	it("normalizes the nullable and numeric fields returned by Tautulli v2.17.2", () => {
		const parsed = tautulliHistoryDataSchema.parse({
			data: [
				{
					row_id: 1,
					rating_key: 100,
					parent_rating_key: 0,
					grandparent_rating_key: 0,
					title: "Fixture",
					grandparent_title: null,
					media_type: "movie",
					user: "Fixture User",
					date: 1_777_000_000,
					group_count: 1,
				},
			],
			recordsFiltered: 1,
			recordsTotal: 1,
		});
		expect(parsed.data[0]).toMatchObject({
			rating_key: "100",
			parent_rating_key: "0",
			grandparent_rating_key: "0",
			grandparent_title: "",
		});
	});

	it.each([
		["row id", { row_id: -0 }],
		["date", { date: -0 }],
		["play count", { play_count: -0 }],
		["group count", { group_count: -0 }],
		["filtered total", { recordsFiltered: -0 }],
		["record total", { recordsTotal: -0 }],
	] as const)("rejects negative zero in history %s", (_label, override) => {
		const fields = override as Record<string, number>;
		const item = {
			row_id: 1,
			rating_key: "100",
			parent_rating_key: "0",
			grandparent_rating_key: "0",
			title: "Fixture",
			grandparent_title: "",
			media_type: "movie",
			user: "Fixture User",
			date: 1_777_000_000,
			group_count: 1,
			...(fields.recordsFiltered === undefined && fields.recordsTotal === undefined ? fields : {}),
		};
		expect(() =>
			tautulliHistoryDataSchema.parse({
				data: [item],
				recordsFiltered: fields.recordsFiltered ?? 1,
				recordsTotal: fields.recordsTotal ?? 1,
			}),
		).toThrow();
	});
});
