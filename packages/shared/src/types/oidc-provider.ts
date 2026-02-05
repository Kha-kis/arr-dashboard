import { z } from "zod";
// Use strict schema for OIDC disable - security-critical operation
import { passwordSchemaStrict } from "./password.js";

/**
 * Public OIDC Provider shape (without client secret)
 * Used for API responses - never includes encrypted secrets
 * Singleton: id is always 1
 */
export const oidcProviderSchema = z.object({
	id: z.number(),
	displayName: z.string(),
	clientId: z.string(),
	issuer: z.string(),
	redirectUri: z.string(),
	scopes: z.string(),
	enabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type OIDCProvider = z.infer<typeof oidcProviderSchema>;

/**
 * Input schema for creating an OIDC provider
 * Includes clientSecret which will be encrypted on the backend
 */
export const createOidcProviderSchema = z.object({
	displayName: z.string().min(1).max(100),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	issuer: z.string().url(),
	redirectUri: z.string().url().optional(),
	scopes: z.string().default("openid,email,profile"),
	enabled: z.boolean().default(true),
});

export type CreateOIDCProvider = z.infer<typeof createOidcProviderSchema>;

/**
 * Input schema for updating an OIDC provider
 * All fields optional - only provided fields will be updated
 * If clientSecret is provided, it will be re-encrypted on the backend
 */
export const updateOidcProviderSchema = createOidcProviderSchema.partial();

export type UpdateOIDCProvider = z.infer<typeof updateOidcProviderSchema>;

/**
 * Response wrapper for the single OIDC provider endpoint
 */
export const oidcProviderResponseSchema = z.object({
	provider: oidcProviderSchema.nullable(),
});

export type OIDCProviderResponse = z.infer<typeof oidcProviderResponseSchema>;

/**
 * Input schema for deleting OIDC provider
 * Requires replacement password to prevent lockout
 */
export const deleteOidcProviderSchema = z.object({
	replacementPassword: passwordSchemaStrict,
});

export type DeleteOIDCProvider = z.infer<typeof deleteOidcProviderSchema>;
