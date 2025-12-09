import type { Prisma, OIDCProvider as PrismaOIDCProvider } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
	createOidcProviderSchema,
	updateOidcProviderSchema,
	type ErrorResponse,
	type OIDCProvider,
	type OIDCProviderResponse,
} from "@arr/shared";

/**
 * Transform a Prisma OIDCProvider model to the public DTO shape
 * Strips encrypted client secret and IVs from response
 */
function toPublicProvider(provider: PrismaOIDCProvider): OIDCProvider {
	return {
		id: provider.id,
		displayName: provider.displayName,
		clientId: provider.clientId,
		issuer: provider.issuer,
		redirectUri: provider.redirectUri,
		scopes: provider.scopes,
		enabled: provider.enabled,
		createdAt: provider.createdAt.toISOString(),
		updatedAt: provider.updatedAt.toISOString(),
	};
}

export default async function oidcProvidersRoutes(app: FastifyInstance) {
	/**
	 * GET /api/oidc-providers
	 * Get the configured OIDC provider (admin only)
	 */
	app.get<{ Reply: OIDCProviderResponse | ErrorResponse }>("/api/oidc-providers", async (request, reply) => {
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
			provider: toPublicProvider(provider),
		});
	});

	/**
	 * POST /api/oidc-providers
	 * Create the OIDC provider (admin only - only one allowed)
	 */
	app.post<{ Body: unknown; Reply: OIDCProvider | ErrorResponse }>("/api/oidc-providers", async (request, reply) => {
		// Require authentication (single-admin architecture)
		if (!request.currentUser) {
			return reply.status(403).send({ error: "Authentication required" });
		}

		const validation = createOidcProviderSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.status(400).send({ error: "Validation failed", details: validation.error.errors });
		}

		const data = validation.data;

		// Auto-generate redirect URI if not provided
		// Use the request origin to detect the correct URL (works in Docker/proxy environments)
		let redirectUri = data.redirectUri;
		if (!redirectUri) {
			const protocol = request.headers['x-forwarded-proto'] || request.protocol;
			const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000';
			redirectUri = `${protocol}://${host}/auth/oidc/callback`;
			request.log.info({ redirectUri, protocol, host }, "Auto-generated redirect URI from request");
		}

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
				redirectUri,
				scopes: data.scopes,
				enabled: data.enabled,
			},
		});

		return reply.status(201).send(toPublicProvider(provider));
	});

	/**
	 * PUT /api/oidc-providers
	 * Update the OIDC provider (admin only, singleton)
	 */
	app.put<{ Body: unknown; Reply: OIDCProvider | ErrorResponse }>(
		"/api/oidc-providers",
		async (request, reply) => {
			// Require authentication (single-admin architecture)
			if (!request.currentUser) {
				return reply.status(403).send({ error: "Authentication required" });
			}

			const validation = updateOidcProviderSchema.safeParse(request.body);
			if (!validation.success) {
				return reply.status(400).send({ error: "Validation failed", details: validation.error.errors });
			}

			const data = validation.data;

			// Check if provider exists (singleton with id=1)
			const existing = await app.prisma.oIDCProvider.findUnique({
				where: { id: 1 },
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

			// Update provider (singleton with id=1)
			const provider = await app.prisma.oIDCProvider.update({
				where: { id: 1 },
				data: updateData,
			});

			return toPublicProvider(provider);
		},
	);

	/**
	 * DELETE /api/oidc-providers
	 * Delete the OIDC provider (admin only, singleton)
	 */
	app.delete<{ Reply: ErrorResponse | undefined }>("/api/oidc-providers", async (request, reply) => {
		// Require authentication (single-admin architecture)
		if (!request.currentUser) {
			return reply.status(403).send({ error: "Authentication required" });
		}

		// Check if provider exists (singleton with id=1)
		const existing = await app.prisma.oIDCProvider.findUnique({
			where: { id: 1 },
		});

		if (!existing) {
			return reply.status(404).send({ error: "OIDC provider not found" });
		}

		// Delete provider (singleton with id=1)
		await app.prisma.oIDCProvider.delete({
			where: { id: 1 },
		});

		return reply.status(204).send();
	});
}
