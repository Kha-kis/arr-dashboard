import { z } from "zod";

/**
 * Password policy types
 */
export type PasswordPolicy = "strict" | "relaxed";

/**
 * Strict password schema - Corporate requirements
 * Requires: lowercase, uppercase, number, special character
 */
export const passwordSchemaStrict = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.max(128, "Password must not exceed 128 characters")
	.regex(/[a-z]/, "Password must contain at least one lowercase letter")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character");

/**
 * Relaxed password schema - Passphrase-friendly
 * Only requires minimum length (8 characters)
 */
export const passwordSchemaRelaxed = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.max(128, "Password must not exceed 128 characters");

/**
 * Default password schema (strict) for backwards compatibility
 */
export const passwordSchema = passwordSchemaStrict;

/**
 * Get the appropriate password schema based on policy
 */
export const getPasswordSchema = (policy: PasswordPolicy) =>
	policy === "relaxed" ? passwordSchemaRelaxed : passwordSchemaStrict;

export type Password = z.infer<typeof passwordSchemaStrict>;
