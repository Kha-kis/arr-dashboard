import type { FastifyInstance } from "fastify";
import { z } from "zod";

const oidcProviderSchema = z.object({
	type: z.enum(["authelia", "authentik", "generic"]),
	displayName: z.string().min(1).max(100),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	issuer: z.string().url(),
	redirectUri: z.string().url(),
	scopes: z.string().default("openid,email,profile"),
	enabled: z.boolean().default(true),
});

const updateOidcProviderSchema = oidcProviderSchema.partial().omit({ type: true });

type OidcProviderInput = z.infer<typeof oidcProviderSchema>;
type UpdateOidcProviderInput = z.infer<typeof updateOidcProviderSchema>;

export default async function oidcProvidersRoutes(app: FastifyInstance) {
	/**
	 * GET /api/oidc-providers
	 * List all OIDC providers (admin only)
	 */
	app.get("/api/oidc-providers", async (request, reply) => {
		// Require admin role
		if (!request.currentUser || request.currentUser.role !== "ADMIN") {
			return reply.status(403).send({ error: "Admin access required" });
		}

		const providers = await app.prisma.oIDCProvider.findMany({
			orderBy: { createdAt: "asc" },
		});

		// Return providers without exposing client secrets
		return providers.map((provider) => ({
			id: provider.id,
			type: provider.type,
			displayName: provider.displayName,
			clientId: provider.clientId,
			issuer: provider.issuer,
			redirectUri: provider.redirectUri,
			scopes: provider.scopes,
			enabled: provider.enabled,
			createdAt: provider.createdAt,
			updatedAt: provider.updatedAt,
		}));
	});

	/**
	 * POST /api/oidc-providers
	 * Create a new OIDC provider (admin only)
	 */
	app.post<{ Body: OidcProviderInput }>("/api/oidc-providers", async (request, reply) => {
		// Require admin role
		if (!request.currentUser || request.currentUser.role !== "ADMIN") {
			return reply.status(403).send({ error: "Admin access required" });
		}

		const validation = oidcProviderSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.status(400).send({ error: validation.error.errors });
		}

		const data = validation.data;

		// Check if provider type already exists
		const existing = await app.prisma.oIDCProvider.findUnique({
			where: { type: data.type },
		});

		if (existing) {
			return reply.status(409).send({
				error: `OIDC provider type '${data.type}' already exists. Please update the existing provider or choose a different type.`,
			});
		}

		// Encrypt client secret
		const { value: encryptedClientSecret, iv: clientSecretIv } = app.encryptor.encrypt(
			data.clientSecret,
		);

		// Create provider
		const provider = await app.prisma.oIDCProvider.create({
			data: {
				type: data.type,
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
			type: provider.type,
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
			// Require admin role
			if (!request.currentUser || request.currentUser.role !== "ADMIN") {
				return reply.status(403).send({ error: "Admin access required" });
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
			const updateData: any = {
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
				type: provider.type,
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
		// Require admin role
		if (!request.currentUser || request.currentUser.role !== "ADMIN") {
			return reply.status(403).send({ error: "Admin access required" });
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
