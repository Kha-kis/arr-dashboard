import { z } from "zod";

/**
 * Shared password validation schema
 * Used across the application for consistent password strength requirements
 */
export const passwordSchema = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.max(128, "Password must not exceed 128 characters")
	.regex(/[a-z]/, "Password must contain at least one lowercase letter")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character");

export type Password = z.infer<typeof passwordSchema>;
