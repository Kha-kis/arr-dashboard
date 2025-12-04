/**
 * Unit tests for DeploymentExecutorService
 *
 * Tests extractTrashId function and ID-based vs name-based matching behavior
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { DeploymentExecutorService } from "../deployment-executor.js";
import type { CustomFormat, CustomFormatSpecification } from "../arr-api-client.js";

// Type for array-format fields (some arr instances return this format)
interface ArrayFieldFormat {
	name: string;
	value: unknown;
}

// Helper to create a specification with array-format fields
const createSpecWithArrayFields = (
	name: string,
	fields: ArrayFieldFormat[]
): CustomFormatSpecification => ({
	name,
	implementation: "test",
	negate: false,
	required: false,
	// Cast to the expected type since API can return array or object format
	fields: fields as unknown as Record<string, unknown>,
});

// Helper to access private extractTrashId method in tests
// Uses index signature to bypass TypeScript's private member checking
const getExtractTrashId = (
	service: DeploymentExecutorService
): ((cf: CustomFormat) => string | null) => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (service as unknown as { extractTrashId: (cf: CustomFormat) => string | null }).extractTrashId.bind(service);
};

describe("DeploymentExecutorService - extractTrashId", () => {
	let service: DeploymentExecutorService;
	let mockPrisma: PrismaClient;
	let mockEncryptor: { decrypt: (payload: { value: string; iv: string }) => string };

	beforeEach(() => {
		mockPrisma = {} as PrismaClient;
		mockEncryptor = {
			decrypt: vi.fn((payload) => payload.value),
		};
		service = new DeploymentExecutorService(mockPrisma, mockEncryptor);
	});

	it("should extract trash_id from array format fields", () => {
		const cf: CustomFormat = {
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
		const cf: CustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				{
					name: "test",
					implementation: "test",
					negate: false,
					required: false,
					fields: {
						trash_id: "test-uuid-456",
						other_field: "other_value",
					},
				},
			],
		};

		const extractTrashId = getExtractTrashId(service);
		const trashId = extractTrashId(cf);
		expect(trashId).toBe("test-uuid-456");
	});

	it("should return null when no trash_id is found", () => {
		const cf: CustomFormat = {
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
		const cf: CustomFormat = {
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
		} as unknown as CustomFormat;

		const extractTrashId = getExtractTrashId(service);
		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when no specifications have fields", () => {
		const cf: CustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				{
					name: "test1",
					implementation: "test",
					negate: false,
					required: false,
					fields: undefined as unknown as Record<string, unknown>,
				},
				{
					name: "test2",
					implementation: "test",
					negate: false,
					required: false,
					fields: null as unknown as Record<string, unknown>,
				},
			],
		};

		const extractTrashId = getExtractTrashId(service);
		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should handle multiple specifications and return first found trash_id", () => {
		const cf: CustomFormat = {
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
		const cf: CustomFormat = {
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
		const cfWithoutId: CustomFormat = {
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

describe("DeploymentExecutorService - ID-based vs name-based matching", () => {
	it("should demonstrate that null return enables explicit name-based matching", () => {
		// This test documents the expected behavior:
		// When extractTrashId returns null, callers should:
		// 1. NOT add the CF to existingCFMap (ID-based map)
		// 2. Still add the CF to existingCFByName (name-based map)
		// 3. Use name-based lookup when ID lookup fails

		const existingCFMap = new Map<string, CustomFormat>();
		const existingCFByName = new Map<string, CustomFormat>();

		// CF with trash_id - should be in both maps
		const cfWithId: CustomFormat = {
			id: 1,
			name: "CF With ID",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "trash_id", value: "uuid-123" },
				]),
			],
		};

		// CF without trash_id - should only be in name map
		const cfWithoutId: CustomFormat = {
			id: 2,
			name: "CF Without ID",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "other_field", value: "value" },
				]),
			],
		};

		// Simulate the mapping logic from deploySingleInstance
		const mockExtractTrashId = (cf: CustomFormat): string | null => {
			for (const spec of cf.specifications || []) {
				if (spec.fields && Array.isArray(spec.fields)) {
					const trashIdField = (spec.fields as ArrayFieldFormat[]).find(
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
		existingCFByName.set(cfWithId.name, cfWithId);

		// Process CF without ID
		const trashId2 = mockExtractTrashId(cfWithoutId);
		if (trashId2) {
			existingCFMap.set(trashId2, cfWithoutId);
		}
		existingCFByName.set(cfWithoutId.name, cfWithoutId);

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

