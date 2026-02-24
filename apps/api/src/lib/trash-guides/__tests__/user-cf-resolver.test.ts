/**
 * Unit tests for resolveUserCustomFormats
 *
 * Tests the batch resolution of user-created custom formats from the database,
 * including filtering, JSON parsing, error handling, and output construction.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	resolveUserCustomFormats,
	USER_CF_PREFIX,
	type CFSelection,
	type StructuredLogger,
} from "../user-cf-resolver.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock Prisma client with configurable findMany behavior */
function createMockPrisma(findManyResult: unknown[] = []) {
	return {
		userCustomFormat: {
			findMany: vi.fn().mockResolvedValue(findManyResult),
		},
	} as any;
}

/** Create a mock structured logger that captures warnings */
function createMockLogger() {
	return { warn: vi.fn() } satisfies StructuredLogger;
}

/** Create a realistic UserCustomFormat database record */
function createUserCF(overrides: {
	id: string;
	name: string;
	specifications?: string;
	userId?: string;
	defaultScore?: number;
	includeCustomFormatWhenRenaming?: boolean;
}) {
	return {
		id: overrides.id,
		name: overrides.name,
		userId: overrides.userId ?? "test-user",
		serviceType: "RADARR" as const,
		specifications: overrides.specifications ?? JSON.stringify([
			{ name: "TestSpec", implementation: "ReleaseTitleSpecification", negate: false, required: false, fields: { value: "test" } },
		]),
		defaultScore: overrides.defaultScore ?? 100,
		includeCustomFormatWhenRenaming: overrides.includeCustomFormatWhenRenaming ?? false,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

/** Create a selection map entry */
function sel(selected: boolean, scoreOverride?: number, conditionsEnabled: Record<string, boolean> = {}): CFSelection {
	return { selected, scoreOverride, conditionsEnabled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveUserCustomFormats", () => {
	let mockPrisma: ReturnType<typeof createMockPrisma>;
	let log: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		mockPrisma = createMockPrisma();
		log = createMockLogger();
	});

	// -----------------------------------------------------------------------
	// Filtering & early return
	// -----------------------------------------------------------------------

	describe("filtering", () => {
		it("returns empty array when no selections have user- prefix", async () => {
			const selections: Record<string, CFSelection> = {
				"abc123-trash-id": sel(true),
				"def456-trash-id": sel(true),
			};

			const result = await resolveUserCustomFormats(mockPrisma, "test-user", selections, log);

			expect(result).toEqual([]);
			expect(mockPrisma.userCustomFormat.findMany).not.toHaveBeenCalled();
		});

		it("returns empty array when all selections are empty", async () => {
			const result = await resolveUserCustomFormats(mockPrisma, "test-user", {}, log);

			expect(result).toEqual([]);
			expect(mockPrisma.userCustomFormat.findMany).not.toHaveBeenCalled();
		});

		it("skips user CFs that are not selected", async () => {
			const selections: Record<string, CFSelection> = {
				"user-cf1": sel(false),
				"user-cf2": sel(false),
			};

			const result = await resolveUserCustomFormats(mockPrisma, "test-user", selections, log);

			expect(result).toEqual([]);
			expect(mockPrisma.userCustomFormat.findMany).not.toHaveBeenCalled();
		});

		it("only processes user- prefixed entries, ignores trash CFs", async () => {
			const userCF = createUserCF({ id: "cf1", name: "My Custom" });
			mockPrisma = createMockPrisma([userCF]);

			const selections: Record<string, CFSelection> = {
				"trash-id-abc": sel(true),
				"user-cf1": sel(true),
				"another-trash-id": sel(true),
			};

			const result = await resolveUserCustomFormats(mockPrisma, "test-user", selections, log);

			// Only "cf1" should be queried (stripped from "user-cf1")
			expect(mockPrisma.userCustomFormat.findMany).toHaveBeenCalledWith({
				where: { id: { in: ["cf1"] }, userId: "test-user" },
			});
			expect(result).toHaveLength(1);
			expect(result[0]!.trashId).toBe("user-cf1");
		});
	});

	// -----------------------------------------------------------------------
	// ID extraction
	// -----------------------------------------------------------------------

	describe("ID extraction", () => {
		it("correctly strips USER_CF_PREFIX to extract database ID", async () => {
			const userCF = createUserCF({ id: "clx123abc", name: "Test" });
			mockPrisma = createMockPrisma([userCF]);

			await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ [`${USER_CF_PREFIX}clx123abc`]: sel(true) },
				log,
			);

			expect(mockPrisma.userCustomFormat.findMany).toHaveBeenCalledWith({
				where: { id: { in: ["clx123abc"] }, userId: "test-user" },
			});
		});

		it("handles multiple user CFs in a single batch query", async () => {
			const cfs = [
				createUserCF({ id: "cf1", name: "CF One" }),
				createUserCF({ id: "cf2", name: "CF Two" }),
				createUserCF({ id: "cf3", name: "CF Three" }),
			];
			mockPrisma = createMockPrisma(cfs);

			const selections: Record<string, CFSelection> = {
				"user-cf1": sel(true),
				"user-cf2": sel(true),
				"user-cf3": sel(true),
			};

			const result = await resolveUserCustomFormats(mockPrisma, "test-user", selections, log);

			expect(mockPrisma.userCustomFormat.findMany).toHaveBeenCalledTimes(1);
			expect(mockPrisma.userCustomFormat.findMany).toHaveBeenCalledWith({
				where: { id: { in: ["cf1", "cf2", "cf3"] }, userId: "test-user" },
			});
			expect(result).toHaveLength(3);
		});
	});

	// -----------------------------------------------------------------------
	// Ownership check
	// -----------------------------------------------------------------------

	describe("ownership", () => {
		it("passes userId to the database query for ownership check", async () => {
			mockPrisma = createMockPrisma([]);

			await resolveUserCustomFormats(
				mockPrisma,
				"specific-user-id",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(mockPrisma.userCustomFormat.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ userId: "specific-user-id" }),
				}),
			);
		});
	});

	// -----------------------------------------------------------------------
	// Database error propagation
	// -----------------------------------------------------------------------

	describe("database errors", () => {
		it("propagates Prisma query errors to the caller", async () => {
			const dbError = new Error("Connection refused");
			mockPrisma.userCustomFormat.findMany = vi.fn().mockRejectedValue(dbError);

			await expect(
				resolveUserCustomFormats(mockPrisma, "test-user", { "user-cf1": sel(true) }, log),
			).rejects.toThrow("Connection refused");
		});
	});

	// -----------------------------------------------------------------------
	// Missing database records
	// -----------------------------------------------------------------------

	describe("missing database records", () => {
		it("skips CFs not found in database and logs warning", async () => {
			mockPrisma = createMockPrisma([]); // Empty result = not found

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-missing-id": sel(true) },
				log,
			);

			expect(result).toEqual([]);
			expect(log.warn).toHaveBeenCalledWith(
				{ cfTrashId: "user-missing-id", userCFId: "missing-id" },
				"User-created custom format not found in database, skipping",
			);
		});

		it("resolves found CFs while skipping missing ones", async () => {
			const userCF = createUserCF({ id: "found", name: "Found CF" });
			mockPrisma = createMockPrisma([userCF]);

			const selections: Record<string, CFSelection> = {
				"user-found": sel(true),
				"user-gone": sel(true),
			};

			const result = await resolveUserCustomFormats(mockPrisma, "test-user", selections, log);

			expect(result).toHaveLength(1);
			expect(result[0]!.trashId).toBe("user-found");
			expect(log.warn).toHaveBeenCalledTimes(1); // Only "gone" warned
		});
	});

	// -----------------------------------------------------------------------
	// JSON parsing
	// -----------------------------------------------------------------------

	describe("specifications parsing", () => {
		it("parses valid JSON array specifications", async () => {
			const specs = [
				{ name: "Spec1", implementation: "ReleaseTitleSpecification", negate: false, required: false, fields: { value: "test" } },
				{ name: "Spec2", implementation: "SizeSpecification", negate: true, required: true, fields: { min: 0, max: 100 } },
			];
			const userCF = createUserCF({ id: "cf1", name: "My CF", specifications: JSON.stringify(specs) });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toHaveLength(1);
			expect(result[0]!.originalConfig.specifications).toHaveLength(2);
			expect(result[0]!.originalConfig.specifications[0]!.name).toBe("Spec1");
			expect(result[0]!.originalConfig.specifications[1]!.name).toBe("Spec2");
		});

		it("skips CF with malformed JSON and logs warning", async () => {
			const userCF = createUserCF({ id: "cf1", name: "Bad JSON", specifications: "not-valid-json" });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toEqual([]);
			expect(log.warn).toHaveBeenCalledWith(
				expect.objectContaining({ userCFId: "cf1", userCFName: "Bad JSON" }),
				expect.stringContaining("Failed to parse specifications JSON"),
			);
		});

		it("skips CF when JSON is an object instead of array", async () => {
			const userCF = createUserCF({ id: "cf1", name: "Object Specs", specifications: '{"key": "value"}' });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toEqual([]);
			expect(log.warn).toHaveBeenCalledWith(
				expect.objectContaining({ userCFId: "cf1", userCFName: "Object Specs" }),
				expect.stringContaining("is not an array"),
			);
		});

		it("skips CF when JSON is a primitive string", async () => {
			const userCF = createUserCF({ id: "cf1", name: "String Specs", specifications: '"just a string"' });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toEqual([]);
			expect(log.warn).toHaveBeenCalledWith(
				expect.objectContaining({ userCFId: "cf1", userCFName: "String Specs" }),
				expect.stringContaining("is not an array"),
			);
		});

		it("includes CF with explicitly empty array specifications", async () => {
			const userCF = createUserCF({ id: "cf1", name: "Empty Specs", specifications: "[]" });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			// An explicitly empty array is valid — the user may want a CF placeholder
			expect(result).toHaveLength(1);
			expect(result[0]!.originalConfig.specifications).toEqual([]);
		});

		it("filters out array elements that don't match specification shape and logs warning", async () => {
			const mixedSpecs = [
				{ name: "Valid", implementation: "ReleaseTitleSpecification", negate: false, required: false, fields: {} },
				"not an object",
				42,
				null,
				{ name: "Also Valid", implementation: "SizeSpecification", negate: true, required: true, fields: {} },
			];
			const userCF = createUserCF({ id: "cf1", name: "Mixed", specifications: JSON.stringify(mixedSpecs) });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toHaveLength(1);
			// Only the two valid objects should pass the type guard
			expect(result[0]!.originalConfig.specifications).toHaveLength(2);
			// Should log that 3 of 5 specs were dropped
			expect(log.warn).toHaveBeenCalledWith(
				expect.objectContaining({ userCFId: "cf1", totalSpecs: 5, validSpecs: 2 }),
				expect.stringContaining("failed validation and were dropped"),
			);
		});

		it("handles whitespace-padded empty array as valid empty specs", async () => {
			// Regression test: "[ ]" should be treated the same as "[]"
			const userCF = createUserCF({ id: "cf1", name: "Spaced Empty", specifications: "[ ]" });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result).toHaveLength(1);
			expect(result[0]!.originalConfig.specifications).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Output construction
	// -----------------------------------------------------------------------

	describe("output construction", () => {
		it("passes through scoreOverride and conditionsEnabled from selections", async () => {
			const userCF = createUserCF({ id: "cf1", name: "My CF" });
			mockPrisma = createMockPrisma([userCF]);

			const conditions = { condition1: true, condition2: false };
			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true, 250, conditions) },
				log,
			);

			expect(result).toHaveLength(1);
			expect(result[0]!.scoreOverride).toBe(250);
			expect(result[0]!.conditionsEnabled).toEqual(conditions);
		});

		it("sets undefined scoreOverride when not provided", async () => {
			const userCF = createUserCF({ id: "cf1", name: "My CF" });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result[0]!.scoreOverride).toBeUndefined();
		});

		it("constructs correct originalConfig with trash_scores", async () => {
			const userCF = createUserCF({
				id: "cf1",
				name: "Premium CF",
				defaultScore: 500,
				includeCustomFormatWhenRenaming: true,
			});
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-cf1": sel(true) },
				log,
			);

			expect(result[0]!.name).toBe("Premium CF");
			expect(result[0]!.originalConfig).toEqual(expect.objectContaining({
				trash_id: "user-cf1",
				name: "Premium CF",
				includeCustomFormatWhenRenaming: true,
				trash_scores: { default: 500 },
			}));
		});

		it("uses the synthetic trash_id (user-{id}) in both trashId and originalConfig", async () => {
			const userCF = createUserCF({ id: "abc123", name: "Test" });
			mockPrisma = createMockPrisma([userCF]);

			const result = await resolveUserCustomFormats(
				mockPrisma,
				"test-user",
				{ "user-abc123": sel(true) },
				log,
			);

			expect(result[0]!.trashId).toBe("user-abc123");
			expect(result[0]!.originalConfig.trash_id).toBe("user-abc123");
		});
	});

	// -----------------------------------------------------------------------
	// USER_CF_PREFIX constant
	// -----------------------------------------------------------------------

	describe("USER_CF_PREFIX", () => {
		it("equals 'user-'", () => {
			expect(USER_CF_PREFIX).toBe("user-");
		});
	});
});
