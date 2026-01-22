/**
 * Unit tests for DeploymentExecutorService
 *
 * Tests extractTrashId function and ID-based vs name-based matching behavior
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import type { SonarrClient } from "arr-sdk";
import { DeploymentExecutorService } from "../deployment-executor.js";
import type { ArrClientFactory } from "../../arr/client-factory.js";

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

// Helper to access private extractTrashId method in tests
// Uses index signature to bypass TypeScript's private member checking
const getExtractTrashId = (
	service: DeploymentExecutorService
): ((cf: SdkCustomFormat) => string | null) => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (service as unknown as { extractTrashId: (cf: SdkCustomFormat) => string | null }).extractTrashId.bind(service);
};

describe("DeploymentExecutorService - extractTrashId", () => {
	let service: DeploymentExecutorService;
	let mockPrisma: PrismaClient;
	let mockClientFactory: ArrClientFactory;

	beforeEach(() => {
		mockPrisma = {} as PrismaClient;
		mockClientFactory = {
			create: vi.fn(),
		} as unknown as ArrClientFactory;
		service = new DeploymentExecutorService(mockPrisma, mockClientFactory);
	});

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

		// Access private method via helper
		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when specifications are empty", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [],
		};

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
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

		const extractTrashId = getExtractTrashId(service);
		const trashId = extractTrashId(cfWithoutId);
		expect(trashId).toBeNull();

		// This null return allows callers to:
		// 1. Skip ID-based matching (existingCFMap.get(null) returns undefined)
		// 2. Explicitly use name-based matching (existingCFByName.get(cf.name))
		// This keeps ID-based and name-based matching distinct
	});
});

// ============================================================================
// TRaSH Guides PR #2590 - Quality Format Detection Tests
// ============================================================================

// Helper to access private format detection functions
// These are module-level functions, so we need to test them via their effects
// on the public API or by re-implementing the logic

/**
 * Reimplementation of format detection for testing purposes.
 * This mirrors the logic in deployment-executor.ts for verification.
 */
// Indicators should be normalized (no hyphens/spaces)
const LOW_QUALITY_INDICATORS = new Set([
	"unknown", "workprint", "cam", "telesync", "ts", "telecine",
	"tc", "dvdscr", "regional", "sdtv", "dvd", "rawhd",
]);

// Indicators should be normalized (no hyphens/spaces)
const HIGH_QUALITY_INDICATORS = new Set([
	"remux", "bluray", "br", "uhd", "2160p", "4k", "webdl", "hdtv",
]);

const getQualityItemName = (item: { name?: string; quality?: { name?: string } }): string => {
	return (item.name || item.quality?.name || "").toLowerCase().replace(/[\s-]/g, "");
};

const isLowQualityName = (name: string): boolean => {
	const normalized = name.toLowerCase().replace(/[\s-]/g, "");
	return [...LOW_QUALITY_INDICATORS].some(
		(indicator) => normalized.includes(indicator) || indicator.includes(normalized),
	);
};

const isHighQualityName = (name: string): boolean => {
	const normalized = name.toLowerCase().replace(/[\s-]/g, "");
	return [...HIGH_QUALITY_INDICATORS].some(
		(indicator) => normalized.includes(indicator) || indicator.includes(normalized),
	);
};

const isNewTrashQualityFormat = (
	items: Array<{ name?: string; quality?: { name?: string } }>,
): boolean => {
	if (!items || items.length < 2) return false;
	const firstItem = items[0];
	const lastItem = items[items.length - 1];
	if (!firstItem || !lastItem) return false;

	const firstName = getQualityItemName(firstItem);
	const lastName = getQualityItemName(lastItem);

	const firstIsLowQuality = isLowQualityName(firstName);
	const lastIsHighQuality = isHighQualityName(lastName);

	if (firstIsLowQuality && lastIsHighQuality) return true;
	if (isHighQualityName(firstName) || isLowQualityName(lastName)) return false;

	return false;
};

const reverseQualityItemsIfNeeded = <T>(items: T[]): T[] => {
	if (!items || items.length === 0) return items;
	const typedItems = items as Array<{ name?: string; quality?: { name?: string } }>;
	if (isNewTrashQualityFormat(typedItems)) {
		return [...items].reverse();
	}
	return items;
};

describe("Quality Format Detection (TRaSH Guides PR #2590)", () => {
	describe("isLowQualityName", () => {
		it("should identify low quality names", () => {
			expect(isLowQualityName("Unknown")).toBe(true);
			expect(isLowQualityName("Workprint")).toBe(true);
			expect(isLowQualityName("CAM")).toBe(true);
			expect(isLowQualityName("SDTV")).toBe(true);
			expect(isLowQualityName("DVD")).toBe(true);
			expect(isLowQualityName("Raw-HD")).toBe(true);
		});

		it("should not identify high quality names as low quality", () => {
			expect(isLowQualityName("Remux")).toBe(false);
			expect(isLowQualityName("Bluray")).toBe(false);
			expect(isLowQualityName("WEB-DL")).toBe(false);
			expect(isLowQualityName("HDTV")).toBe(false);
		});
	});

	describe("isHighQualityName", () => {
		it("should identify high quality names", () => {
			expect(isHighQualityName("Remux")).toBe(true);
			expect(isHighQualityName("Bluray")).toBe(true);
			expect(isHighQualityName("BR")).toBe(true);
			expect(isHighQualityName("UHD")).toBe(true);
			expect(isHighQualityName("2160p")).toBe(true);
			expect(isHighQualityName("4K")).toBe(true);
			expect(isHighQualityName("WEB-DL")).toBe(true);
			expect(isHighQualityName("HDTV")).toBe(true);
		});

		it("should not identify low quality names as high quality", () => {
			expect(isHighQualityName("Unknown")).toBe(false);
			expect(isHighQualityName("CAM")).toBe(false);
			expect(isHighQualityName("SDTV")).toBe(false);
		});
	});

	describe("isNewTrashQualityFormat", () => {
		it("should detect NEW format (low quality first, high quality last)", () => {
			// NEW format: Unknown → ... → Remux (low to high)
			const newFormatItems = [
				{ name: "Unknown" },
				{ name: "SDTV" },
				{ name: "DVD" },
				{ name: "HDTV-720p" },
				{ name: "WEB-DL 1080p" },
				{ name: "Bluray-2160p Remux" },
			];
			expect(isNewTrashQualityFormat(newFormatItems)).toBe(true);
		});

		it("should detect OLD format (high quality first, low quality last)", () => {
			// OLD format: Remux → ... → Unknown (high to low)
			const oldFormatItems = [
				{ name: "Bluray-2160p Remux" },
				{ name: "WEB-DL 1080p" },
				{ name: "HDTV-720p" },
				{ name: "DVD" },
				{ name: "SDTV" },
				{ name: "Unknown" },
			];
			expect(isNewTrashQualityFormat(oldFormatItems)).toBe(false);
		});

		it("should handle quality wrapper objects", () => {
			const newFormatWithQualityWrapper = [
				{ quality: { name: "Unknown" } },
				{ quality: { name: "SDTV" } },
				{ quality: { name: "Remux" } },
			];
			expect(isNewTrashQualityFormat(newFormatWithQualityWrapper)).toBe(true);

			const oldFormatWithQualityWrapper = [
				{ quality: { name: "Remux" } },
				{ quality: { name: "SDTV" } },
				{ quality: { name: "Unknown" } },
			];
			expect(isNewTrashQualityFormat(oldFormatWithQualityWrapper)).toBe(false);
		});

		it("should return false for inconclusive format", () => {
			// Neither clear low nor high quality at edges
			const inconclusiveItems = [
				{ name: "HDTV-720p" },
				{ name: "WEB-DL 720p" },
				{ name: "HDTV-1080p" },
			];
			expect(isNewTrashQualityFormat(inconclusiveItems)).toBe(false);
		});

		it("should return false for less than 2 items", () => {
			expect(isNewTrashQualityFormat([])).toBe(false);
			expect(isNewTrashQualityFormat([{ name: "Unknown" }])).toBe(false);
		});

		it("should return false for empty or undefined items", () => {
			expect(isNewTrashQualityFormat(null as unknown as any[])).toBe(false);
			expect(isNewTrashQualityFormat(undefined as unknown as any[])).toBe(false);
		});
	});

	describe("reverseQualityItemsIfNeeded", () => {
		it("should reverse items when in NEW format", () => {
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
			// Should not mutate original
			expect(newFormatItems[0]?.name).toBe("Unknown");
		});

		it("should NOT reverse items when in OLD format", () => {
			const oldFormatItems = [
				{ name: "Remux" },
				{ name: "DVD" },
				{ name: "Unknown" },
			];
			const result = reverseQualityItemsIfNeeded(oldFormatItems);

			expect(result).toEqual([
				{ name: "Remux" },
				{ name: "DVD" },
				{ name: "Unknown" },
			]);
			// Should be the same reference (no copy needed)
			expect(result).toBe(oldFormatItems);
		});

		it("should handle empty arrays", () => {
			const result = reverseQualityItemsIfNeeded([]);
			expect(result).toEqual([]);
		});

		it("should handle undefined/null", () => {
			expect(reverseQualityItemsIfNeeded(null as unknown as any[])).toBe(null);
			expect(reverseQualityItemsIfNeeded(undefined as unknown as any[])).toBe(undefined);
		});

		it("should preserve all item properties during reversal", () => {
			const newFormatItems = [
				{ name: "Unknown", allowed: false, id: 1 },
				{ name: "DVD", allowed: true, id: 2 },
				{ name: "Remux", allowed: true, id: 3 },
			];
			const result = reverseQualityItemsIfNeeded(newFormatItems);

			expect(result).toEqual([
				{ name: "Remux", allowed: true, id: 3 },
				{ name: "DVD", allowed: true, id: 2 },
				{ name: "Unknown", allowed: false, id: 1 },
			]);
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
