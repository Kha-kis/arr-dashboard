/**
 * Unit tests for validateRequest helper.
 *
 * Verifies that valid data passes through typed, and invalid data
 * throws ZodValidationError with statusCode 400 and flattened details.
 *
 * Run with: npx vitest run validate.test.ts
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateRequest, ZodValidationError } from "../validate.js";

const testSchema = z.object({
	name: z.string().min(1),
	age: z.number().int().positive(),
	email: z.string().email().optional(),
});

describe("validateRequest", () => {
	it("returns typed data for valid input", () => {
		const input = { name: "Alice", age: 30 };
		const result = validateRequest(testSchema, input);

		expect(result).toEqual({ name: "Alice", age: 30 });
		// Type-level check: result.name is a string, result.age is a number
		expect(typeof result.name).toBe("string");
		expect(typeof result.age).toBe("number");
	});

	it("strips unknown keys (Zod default behavior)", () => {
		const input = { name: "Bob", age: 25, unknownField: "should be stripped" };
		const result = validateRequest(testSchema, input);

		expect(result).toEqual({ name: "Bob", age: 25 });
		expect("unknownField" in result).toBe(false);
	});

	it("throws ZodValidationError for missing required fields", () => {
		const input = { name: "Charlie" }; // missing age

		try {
			validateRequest(testSchema, input);
			expect.fail("Expected ZodValidationError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ZodValidationError);
			const validationError = err as ZodValidationError;
			expect(validationError.statusCode).toBe(400);
			expect(validationError.message).toBe("Invalid payload");
			expect(validationError.name).toBe("ZodValidationError");
			expect(validationError.details.fieldErrors).toHaveProperty("age");
		}
	});

	it("throws ZodValidationError for wrong types", () => {
		const input = { name: 123, age: "not a number" };

		try {
			validateRequest(testSchema, input);
			expect.fail("Expected ZodValidationError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ZodValidationError);
			const validationError = err as ZodValidationError;
			expect(validationError.statusCode).toBe(400);
			expect(validationError.details.fieldErrors).toHaveProperty("name");
			expect(validationError.details.fieldErrors).toHaveProperty("age");
		}
	});

	it("throws ZodValidationError for constraint violations", () => {
		const input = { name: "", age: -5, email: "not-an-email" };

		try {
			validateRequest(testSchema, input);
			expect.fail("Expected ZodValidationError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ZodValidationError);
			const validationError = err as ZodValidationError;
			expect(validationError.statusCode).toBe(400);
			expect(validationError.details.fieldErrors).toHaveProperty("name");
			expect(validationError.details.fieldErrors).toHaveProperty("age");
			expect(validationError.details.fieldErrors).toHaveProperty("email");
		}
	});

	it("throws ZodValidationError for completely invalid input (null)", () => {
		try {
			validateRequest(testSchema, null);
			expect.fail("Expected ZodValidationError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ZodValidationError);
			const validationError = err as ZodValidationError;
			expect(validationError.statusCode).toBe(400);
		}
	});
});

describe("ZodValidationError", () => {
	it("has correct shape for centralized error handler", () => {
		const schema = z.object({ id: z.string().uuid() });
		const result = schema.safeParse({ id: "not-a-uuid" });

		expect(result.success).toBe(false);
		if (!result.success) {
			const error = new ZodValidationError(result.error);

			// These properties are checked by the centralized error handler in server.ts
			expect(error.statusCode).toBe(400);
			expect(error.message).toBe("Invalid payload");
			expect(error.name).toBe("ZodValidationError");
			expect(error.details).toHaveProperty("formErrors");
			expect(error.details).toHaveProperty("fieldErrors");
			expect(Array.isArray(error.details.formErrors)).toBe(true);
			expect(error.details.fieldErrors).toHaveProperty("id");
		}
	});
});
