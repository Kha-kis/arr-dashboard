import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const oidcProviderSchema = z.object({
	displayName: z.string().min(1).max(100),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	issuer: z.string().url(),
	redirectUri: z.string().url(),
	scopes: z.string().default("openid,email,profile"),
	enabled: z.boolean().default(true),
});

const updateOidcProviderSchema = oidcProviderSchema.partial();

type OidcProviderInput = z.infer<typeof oidcProviderSchema>;
type UpdateOidcProviderInput = z.infer<typeof updateOidcProviderSchema>;

export default async function oidcProvidersRoutes(app: FastifyInstance) {
	/**
	 * GET /api/oidc-providers
	 * Get the configured OIDC provider (admin only)
	 */
	app.get("/api/oidc-providers", async (request, reply) => {
		// Require authentication (single-admin architecture)
		if (!request.currentUser) {
			return reply.status(403).send({ error: "Authentication required" });
		}

		const provider = await app.prisma.oIDCProvider.findFirst();

		if (!provider) {
			return reply.send({ provider: null });
		}

		// Return provider without exposing client secret
		return reply.send({
			provider: {
				id: provider.id,
				displayName: provider.displayName,
				clientId: provider.clientId,
				issuer: provider.issuer,
				redirectUri: provider.redirectUri,
				scopes: provider.scopes,
				enabled: provider.enabled,
				createdAt: provider.createdAt,
				updatedAt: provider.updatedAt,
			}
		});
	});

	/**
	 * POST /api/oidc-providers
	 * Create the OIDC provider (admin only - only one allowed)
	 */
	app.post<{ Body: OidcProviderInput }>("/api/oidc-providers", async (request, reply) => {
		// Require authentication (single-admin architecture)
		if (!request.currentUser) {
			return reply.status(403).send({ error: "Authentication required" });
		}

		const validation = oidcProviderSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.status(400).send({ error: validation.error.errors });
		}

		const data = validation.data;

		// Check if provider already exists (only one allowed)
		const existing = await app.prisma.oIDCProvider.findFirst();

		if (existing) {
			return reply.status(409).send({
				error: "An OIDC provider already exists. Please update or delete the existing provider first.",
			});
		}

		// Encrypt client secret
		const { value: encryptedClientSecret, iv: clientSecretIv} = app.encryptor.encrypt(
			data.clientSecret,
		);

		// Create provider
		const provider = await app.prisma.oIDCProvider.create({
			data: {
				displayName: data.displayName,
				clientId: data.clientId,
				encryptedClientSecret,
				clientSecretIv,
				issuer: data.issuer,
				redirectUri: data.redirectUri,
				scopes: data.scopes,
				enabled: data.enabled,
			},
		});

		return reply.status(201).send({
			id: provider.id,
			displayName: provider.displayName,
			clientId: provider.clientId,
			issuer: provider.issuer,
			redirectUri: provider.redirectUri,
			scopes: provider.scopes,
			enabled: provider.enabled,
			createdAt: provider.createdAt,
			updatedAt: provider.updatedAt,
		});
	});

	/**
	 * PUT /api/oidc-providers/:id
	 * Update an existing OIDC provider (admin only)
	 */
	app.put<{ Params: { id: string }; Body: UpdateOidcProviderInput }>(
		"/api/oidc-providers/:id",
		async (request, reply) => {
			// Require authentication (single-admin architecture)
			if (!request.currentUser) {
				return reply.status(403).send({ error: "Authentication required" });
			}

			const validation = updateOidcProviderSchema.safeParse(request.body);
			if (!validation.success) {
				return reply.status(400).send({ error: validation.error.errors });
			}

			const data = validation.data;
			const { id } = request.params;

			// Check if provider exists
			const existing = await app.prisma.oIDCProvider.findUnique({
				where: { id },
			});

			if (!existing) {
				return reply.status(404).send({ error: "OIDC provider not found" });
			}

			// Prepare update data
			const updateData: Prisma.OIDCProviderUpdateInput = {
				...(data.displayName && { displayName: data.displayName }),
				...(data.clientId && { clientId: data.clientId }),
				...(data.issuer && { issuer: data.issuer }),
				...(data.redirectUri && { redirectUri: data.redirectUri }),
				...(data.scopes && { scopes: data.scopes }),
				...(data.enabled !== undefined && { enabled: data.enabled }),
			};

			// Encrypt new client secret if provided
			if (data.clientSecret) {
				const { value: encryptedClientSecret, iv: clientSecretIv } = app.encryptor.encrypt(
					data.clientSecret,
				);
				updateData.encryptedClientSecret = encryptedClientSecret;
				updateData.clientSecretIv = clientSecretIv;
			}

			// Update provider
			const provider = await app.prisma.oIDCProvider.update({
				where: { id },
				data: updateData,
			});

			return {
				id: provider.id,
				displayName: provider.displayName,
				clientId: provider.clientId,
				issuer: provider.issuer,
				redirectUri: provider.redirectUri,
				scopes: provider.scopes,
				enabled: provider.enabled,
				createdAt: provider.createdAt,
				updatedAt: provider.updatedAt,
			};
		},
	);

	/**
	 * DELETE /api/oidc-providers/:id
	 * Delete an OIDC provider (admin only)
	 */
	app.delete<{ Params: { id: string } }>("/api/oidc-providers/:id", async (request, reply) => {
		// Require authentication (single-admin architecture)
		if (!request.currentUser) {
			return reply.status(403).send({ error: "Authentication required" });
		}

		const { id } = request.params;

		// Check if provider exists
		const existing = await app.prisma.oIDCProvider.findUnique({
			where: { id },
		});

		if (!existing) {
			return reply.status(404).send({ error: "OIDC provider not found" });
		}

		// Delete provider
		await app.prisma.oIDCProvider.delete({
			where: { id },
		});

		return reply.status(204).send();
	});
}
