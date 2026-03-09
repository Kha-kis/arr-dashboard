/**
 * Tests for github-fetcher.ts validation improvements.
 *
 * Validates:
 * - parseUpstreamOrThrow with directory schema returns typed array on valid data
 * - Invalid directory data throws UpstreamValidationError with correct integration
 * - trashMetadataSchema validates realistic metadata, passes extra fields, rejects non-objects
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { githubDirectoryEntrySchema, trashMetadataSchema } from "../../trash-guides/github-fetcher.js";
import { parseUpstreamOrThrow, UpstreamValidationError } from "../parse-upstream.js";

describe("GitHub directory listing validation", () => {
	const directorySchema = z.array(githubDirectoryEntrySchema);
	const source = { integration: "trash-guides", category: "directory-listing" };

	it("returns typed array on valid directory listing", () => {
		const raw = [
			{ name: "test.json", type: "file", download_url: "https://example.com/test.json" },
			{ name: "subdir", type: "dir", download_url: null },
		];

		const result = parseUpstreamOrThrow(raw, directorySchema, source);

		expect(result).toHaveLength(2);
		expect(result[0]!.name).toBe("test.json");
		expect(result[0]!.type).toBe("file");
		expect(result[1]!.type).toBe("dir");
	});

	it("tolerates extra fields from GitHub API (looseObject)", () => {
		const raw = [
			{
				name: "test.json",
				type: "file",
				download_url: "https://example.com/test.json",
				sha: "abc123",
				size: 1234,
				path: "docs/json/radarr/test.json",
			},
		];

		const result = parseUpstreamOrThrow(raw, directorySchema, source);
		expect(result).toHaveLength(1);
	});

	it("throws UpstreamValidationError on invalid data", () => {
		const raw = [{ name: 123, type: true }]; // name should be string

		try {
			parseUpstreamOrThrow(raw, directorySchema, source);
			expect.fail("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(UpstreamValidationError);
			if (error instanceof UpstreamValidationError) {
				expect(error.integration).toBe("trash-guides");
				expect(error.category).toBe("directory-listing");
				expect(error.issues.length).toBeGreaterThan(0);
			}
		}
	});

	it("throws UpstreamValidationError when response is not an array", () => {
		const raw = { message: "Not Found" };

		try {
			parseUpstreamOrThrow(raw, directorySchema, source);
			expect.fail("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(UpstreamValidationError);
		}
	});
});

describe("trashMetadataSchema", () => {
	it("validates realistic metadata", () => {
		const raw = { version: "6.0.0", lastUpdated: "2025-01-15T10:00:00Z" };

		const result = trashMetadataSchema.parse(raw);

		expect(result.version).toBe("6.0.0");
		expect(result.lastUpdated).toBe("2025-01-15T10:00:00Z");
	});

	it("passes with extra fields (looseObject)", () => {
		const raw = {
			version: "6.0.0",
			lastUpdated: "2025-01-15",
			description: "TRaSH Guides data",
			contributors: ["user1"],
		};

		const result = trashMetadataSchema.parse(raw);
		expect(result.version).toBe("6.0.0");
	});

	it("passes when optional fields are missing", () => {
		const raw = {};

		const result = trashMetadataSchema.parse(raw);
		expect(result.version).toBeUndefined();
		expect(result.lastUpdated).toBeUndefined();
	});

	it("rejects non-objects", () => {
		expect(() => trashMetadataSchema.parse("not-an-object")).toThrow();
		expect(() => trashMetadataSchema.parse(null)).toThrow();
		expect(() => trashMetadataSchema.parse(42)).toThrow();
	});

	it("works with parseUpstreamOrThrow", () => {
		const raw = { version: "5.0.0" };

		const result = parseUpstreamOrThrow(raw, trashMetadataSchema, {
			integration: "trash-guides",
			category: "metadata",
		});

		expect(result.version).toBe("5.0.0");
	});
});
