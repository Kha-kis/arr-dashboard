import { z } from "zod";

export const oidcProviderSchema = z.object({
	id: z.string(),
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

export const updateOidcProviderSchema = z.object({
	displayName: z.string().min(1).max(100).optional(),
	clientId: z.string().min(1).optional(),
	clientSecret: z.string().min(1).optional(),
	issuer: z.string().url().optional(),
	redirectUri: z.string().url().optional(),
	scopes: z.string().optional(),
	enabled: z.boolean().optional(),
});

export type UpdateOIDCProvider = z.infer<typeof updateOidcProviderSchema>;
