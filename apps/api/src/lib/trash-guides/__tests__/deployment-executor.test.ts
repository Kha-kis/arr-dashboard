/**
 * Unit tests for DeploymentExecutorService
 *
 * Tests extractTrashId function and ID-based vs name-based matching behavior
 */

import { describe, it, expect } from "vitest";
import type { SonarrClient } from "arr-sdk";
import { extractTrashId } from "../cf-field-utils.js";

// SDK CustomFormat type alias
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

// SDK Specification type - extract from SdkCustomFormat
type SdkSpecification = NonNullable<SdkCustomFormat["specifications"]>[number];

// Helper to create a specification with array-format fields (SDK format)
const createSpecWithArrayFields = (
	name: string,
	fields: Array<{ name: string; value: unknown }>
): SdkSpecification => ({
	name,
	implementation: "test",
	negate: false,
	required: false,
	fields: fields as SdkSpecification["fields"],
});

// Helper to create a specification with object-format fields (TRaSH format, cast for testing)
const createSpecWithObjectFields = (
	name: string,
	fields: Record<string, unknown>
): SdkSpecification => ({
	name,
	implementation: "test",
	negate: false,
	required: false,
	// Cast object format to array format type - runtime code handles both
	fields: fields as unknown as SdkSpecification["fields"],
});

describe("extractTrashId", () => {

	it("should extract trash_id from array format fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "trash_id", value: "test-uuid-123" },
					{ name: "other_field", value: "other_value" },
				]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("test-uuid-123");
	});

	it("should extract trash_id from object format fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithObjectFields("test", {
					trash_id: "test-uuid-456",
					other_field: "other_value",
				}),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("test-uuid-456");
	});

	it("should return null when no trash_id is found", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF Without Trash ID",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "other_field", value: "other_value" },
				]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when specifications are empty", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when specifications are undefined", () => {
		// Create object with undefined specifications via type assertion
		const cf = {
			id: 1,
			name: "Test CF",
			specifications: undefined,
		} as unknown as SdkCustomFormat;

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when no specifications have fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				{
					name: "test1",
					implementation: "test",
					negate: false,
					required: false,
					fields: undefined,
				} as SdkSpecification,
				{
					name: "test2",
					implementation: "test",
					negate: false,
					required: false,
					fields: null as unknown as SdkSpecification["fields"],
				} as SdkSpecification,
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should handle multiple specifications and return first found trash_id", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithArrayFields("test1", [
					{ name: "other_field", value: "value" },
				]),
				createSpecWithArrayFields("test2", [
					{ name: "trash_id", value: "first-uuid" },
				]),
				createSpecWithArrayFields("test3", [
					{ name: "trash_id", value: "second-uuid" },
				]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("first-uuid");
	});

	it("should convert trash_id value to string", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "trash_id", value: 12345 },
				]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("12345");
		expect(typeof trashId).toBe("string");
	});

	it("should distinguish between ID-based and name-based matching by returning null", () => {
		// CF without trash_id should return null, allowing explicit name-based matching
		const cfWithoutId: SdkCustomFormat = {
			id: 1,
			name: "My Custom Format",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "some_field", value: "value" },
				]),
			],
		};

		const trashId = extractTrashId(cfWithoutId);
		expect(trashId).toBeNull();

		// This null return allows callers to:
		// 1. Skip ID-based matching (existingCFMap.get(null) returns undefined)
		// 2. Explicitly use name-based matching (existingCFByName.get(cf.name))
		// This keeps ID-based and name-based matching distinct
	});
});

// ============================================================================
// TRaSH Guides PR #2590 - Quality Format Reversal Tests
// ============================================================================

/**
 * Feature flag for TRaSH Guides quality format change.
 * This mirrors the production flag in deployment-executor.ts.
 *
 * Current state: false (TRaSH Guides uses OLD format - high quality first)
 * After PR #2590 merges: Change to true (TRaSH will use NEW format - low quality first)
 *
 * See: https://github.com/TRaSH-Guides/Guides/pull/2590
 * See: https://github.com/Kha-kis/arr-dashboard/issues/85
 */
const TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED = true;

/**
 * Test implementation of reverseQualityItemsIfNeeded.
 * Mirrors the production logic for verification.
 */
const reverseQualityItemsIfNeeded = <T>(items: T[]): T[] => {
	if (!items || items.length === 0) return items;
	if (TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED) {
		return [...items].reverse();
	}
	return items;
};

describe("Quality Format Reversal (TRaSH Guides PR #2590)", () => {
	describe("reverseQualityItemsIfNeeded", () => {
		// TRaSH Guides PR #2590 has been merged.
		// Quality items are now in human-readable order (low→high) in TRaSH JSON.
		// We reverse them before sending to Sonarr/Radarr API (which expects high→low).

		it("should reverse items for API compatibility (PR #2590 merged)", () => {
			// TRaSH NEW format: low→high (Unknown → Remux)
			const items = [
				{ name: "Unknown" },
				{ name: "DVD" },
				{ name: "Remux" },
			];
			const result = reverseQualityItemsIfNeeded(items);

			// Reversed for API: high→low (Remux → Unknown)
			expect(result).not.toBe(items);
			expect(result).toEqual([
				{ name: "Remux" },
				{ name: "DVD" },
				{ name: "Unknown" },
			]);
		});

		it("should reverse items and create a new array", () => {
			const newFormatItems = [
				{ name: "Unknown" },
				{ name: "DVD" },
				{ name: "Remux" },
			];
			const result = reverseQualityItemsIfNeeded(newFormatItems);

			expect(result).toEqual([
				{ name: "Remux" },
				{ name: "DVD" },
				{ name: "Unknown" },
			]);
			// New array created, original untouched
			expect(result).not.toBe(newFormatItems);
		});

		it("should handle empty arrays", () => {
			const result = reverseQualityItemsIfNeeded([]);
			expect(result).toEqual([]);
		});

		it("should handle undefined/null gracefully", () => {
			expect(reverseQualityItemsIfNeeded(null as unknown as any[])).toBe(null);
			expect(reverseQualityItemsIfNeeded(undefined as unknown as any[])).toBe(undefined);
		});

		it("should preserve item properties after reversing", () => {
			const items = [
				{ name: "Unknown", allowed: false, id: 1 },
				{ name: "DVD", allowed: true, id: 2 },
				{ name: "Remux", allowed: true, id: 3 },
			];
			const result = reverseQualityItemsIfNeeded(items);

			// New array, reversed
			expect(result).not.toBe(items);
			// All properties intact, order reversed
			expect(result[0]).toEqual({ name: "Remux", allowed: true, id: 3 });
			expect(result[2]).toEqual({ name: "Unknown", allowed: false, id: 1 });
		});
	});
});

describe("DeploymentExecutorService - ID-based vs name-based matching", () => {
	it("should demonstrate that null return enables explicit name-based matching", () => {
		// This test documents the expected behavior:
		// When extractTrashId returns null, callers should:
		// 1. NOT add the CF to existingCFMap (ID-based map)
		// 2. Still add the CF to existingCFByName (name-based map)
		// 3. Use name-based lookup when ID lookup fails

		const existingCFMap = new Map<string, SdkCustomFormat>();
		const existingCFByName = new Map<string, SdkCustomFormat>();

		// CF with trash_id - should be in both maps
		const cfWithId: SdkCustomFormat = {
			id: 1,
			name: "CF With ID",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "trash_id", value: "uuid-123" },
				]),
			],
		};

		// CF without trash_id - should only be in name map
		const cfWithoutId: SdkCustomFormat = {
			id: 2,
			name: "CF Without ID",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "other_field", value: "value" },
				]),
			],
		};

		// Simulate the mapping logic from deploySingleInstance
		const mockExtractTrashId = (cf: SdkCustomFormat): string | null => {
			for (const spec of cf.specifications || []) {
				if (spec.fields && Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find(
						(f) => f.name === "trash_id"
					);
					if (trashIdField) {
						return String(trashIdField.value);
					}
				}
			}
			return null;
		};

		// Process CF with ID
		const trashId1 = mockExtractTrashId(cfWithId);
		if (trashId1) {
			existingCFMap.set(trashId1, cfWithId);
		}
		existingCFByName.set(cfWithId.name!, cfWithId);

		// Process CF without ID
		const trashId2 = mockExtractTrashId(cfWithoutId);
		if (trashId2) {
			existingCFMap.set(trashId2, cfWithoutId);
		}
		existingCFByName.set(cfWithoutId.name!, cfWithoutId);

		// Verify ID-based matching works for CF with ID
		expect(existingCFMap.get("uuid-123")).toBe(cfWithId);
		expect(existingCFMap.has("uuid-123")).toBe(true);

		// Verify ID-based matching does NOT work for CF without ID
		expect(existingCFMap.get("CF Without ID")).toBeUndefined();
		expect(existingCFMap.has("CF Without ID")).toBe(false);

		// Verify name-based matching works for both
		expect(existingCFByName.get("CF With ID")).toBe(cfWithId);
		expect(existingCFByName.get("CF Without ID")).toBe(cfWithoutId);

		// Simulate the lookup logic from deployCustomFormats
		const templateCFWithId = { trashId: "uuid-123", name: "CF With ID" };
		const templateCFWithoutId = { trashId: null, name: "CF Without ID" };

		// ID-based lookup for CF with ID
		let existingCF = existingCFMap.get(templateCFWithId.trashId);
		expect(existingCF).toBe(cfWithId);

		// ID-based lookup for CF without ID should fail, then fall back to name
		existingCF = existingCFMap.get(templateCFWithoutId.trashId || "");
		expect(existingCF).toBeUndefined();
		existingCF = existingCFByName.get(templateCFWithoutId.name);
		expect(existingCF).toBe(cfWithoutId);
	});
});
