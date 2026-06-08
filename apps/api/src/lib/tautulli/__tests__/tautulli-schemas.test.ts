/**
 * Tests for Tautulli Zod schemas.
 *
 * Particular focus on the get_metadata schema's tolerance of missing fields —
 * Tautulli's get_metadata API returns a "success" envelope with sparse data
 * when the rating_key isn't in its database (item deleted from Plex but still
 * in watch history). See issue #497.
 */
import { describe, expect, it } from "vitest";
import { tautulliMetadataSchema } from "../tautulli-schemas.js";

describe("tautulliMetadataSchema", () => {
	it("parses a full metadata response with all fields present", () => {
		const input = {
			guids: ["tmdb://12345", "imdb://tt1234567"],
			media_type: "movie",
			title: "The Matrix",
			rating_key: "118702",
		};
		const result = tautulliMetadataSchema.parse(input);
		expect(result.guids).toEqual(["tmdb://12345", "imdb://tt1234567"]);
		expect(result.media_type).toBe("movie");
		expect(result.title).toBe("The Matrix");
		expect(result.rating_key).toBe("118702");
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
