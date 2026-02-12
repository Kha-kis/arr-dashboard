import type { ZodSchema, ZodError, z } from "zod";

/**
 * Thrown when Zod validation fails. Caught by the centralized error handler
 * in server.ts and returned as a 400 response with flattened details.
 */
export class ZodValidationError extends Error {
	readonly statusCode = 400;
	readonly details: ReturnType<ZodError["flatten"]>;
	constructor(zodError: ZodError) {
		super("Invalid payload");
		this.name = "ZodValidationError";
		this.details = zodError.flatten();
	}
}

/**
 * Validate `data` against a Zod schema.
 *
 * @returns The parsed and typed data on success.
 * @throws {ZodValidationError} on validation failure (caught by centralized error handler).
 */
export function validateRequest<T extends ZodSchema>(schema: T, data: unknown): z.infer<T> {
	const result = schema.safeParse(data);
	if (!result.success) {
		throw new ZodValidationError(result.error);
	}
	return result.data;
}
