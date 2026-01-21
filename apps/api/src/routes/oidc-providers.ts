import {
	type ErrorResponse,
	type OIDCProvider,
	type OIDCProviderResponse,
	createOidcProviderSchema,
	deleteOidcProviderSchema,
	updateOidcProviderSchema,
} from "@arr/shared";
import type { Prisma, OIDCProvider as PrismaOIDCProvider } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../lib/auth/password.js";
import { normalizeIssuerUrl } from "../lib/auth/oidc-utils.js";

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
	app.get<{ Reply: OIDCProviderResponse | ErrorResponse }>(
		"/api/oidc-providers",
		async (request, reply) => {
			// Require authentication (single-admin architecture)
			if (!request.currentUser) {
				return reply.status(403).send({ error: "Authentication required" });
			}

			try {
				const provider = await app.prisma.oIDCProvider.findFirst();

				if (!provider) {
					return reply.send({ provider: null });
				}

				// Return provider without exposing client secret
				return reply.send({
					provider: toPublicProvider(provider),
				});
			} catch (error) {
				request.log.error({ err: error }, "Failed to fetch OIDC provider");
				return reply.status(500).send({ error: "Failed to fetch OIDC provider" });
			}
		},
	);

	/**
	 * POST /api/oidc-providers
	 * Create the OIDC provider (admin only - only one allowed)
	 */
	app.post<{ Body: unknown; Reply: OIDCProvider | ErrorResponse }>(
		"/api/oidc-providers",
		async (request, reply) => {
			// Require authentication (single-admin architecture)
			if (!request.currentUser) {
				return reply.status(403).send({ error: "Authentication required" });
			}

			const validation = createOidcProviderSchema.safeParse(request.body);
			if (!validation.success) {
				return reply
					.status(400)
					.send({ error: "Validation failed", details: validation.error.issues });
			}

			const data = validation.data;

			// Normalize issuer URL to prevent discovery failures
			let normalizedIssuer: string;
			try {
				normalizedIssuer = normalizeIssuerUrl(data.issuer);
				if (normalizedIssuer !== data.issuer) {
					request.log.info(
						{ original: data.issuer, normalized: normalizedIssuer },
						"Normalized OIDC issuer URL",
					);
				}
			} catch (error) {
				return reply.status(400).send({
					error: "Invalid issuer URL",
					details: error instanceof Error ? error.message : "Could not parse issuer URL",
				});
			}

			// Auto-generate redirect URI if not provided
			// Use the request origin to detect the correct URL (works in Docker/proxy environments)
			let redirectUri = data.redirectUri;
			if (!redirectUri) {
				const protocol = request.headers["x-forwarded-proto"] || request.protocol;
				const host =
					request.headers["x-forwarded-host"] || request.headers.host || "localhost:3000";
				redirectUri = `${protocol}://${host}/auth/oidc/callback`;
				request.log.info(
					{ redirectUri, protocol, host },
					"Auto-generated redirect URI from request",
				);
			}

			try {
				// Check if provider already exists (only one allowed)
				const existing = await app.prisma.oIDCProvider.findFirst();

				if (existing) {
					return reply.status(409).send({
						error:
							"An OIDC provider already exists. Please update or delete the existing provider first.",
					});
				}

				// Encrypt client secret
				const { value: encryptedClientSecret, iv: clientSecretIv } = app.encryptor.encrypt(
					data.clientSecret,
				);

				// Create provider
				const provider = await app.prisma.oIDCProvider.create({
					data: {
						displayName: data.displayName,
						clientId: data.clientId,
						encryptedClientSecret,
						clientSecretIv,
						issuer: normalizedIssuer,
						redirectUri,
						scopes: data.scopes,
						enabled: data.enabled,
					},
				});

				return reply.status(201).send(toPublicProvider(provider));
			} catch (error) {
				const prismaError = error as { code?: string };
				if (prismaError.code === "P2002") {
					return reply.status(409).send({ error: "OIDC provider already exists" });
				}
				request.log.error({ err: error }, "Failed to create OIDC provider");
				return reply.status(500).send({ error: "Failed to create OIDC provider" });
			}
		},
	);

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
				return reply
					.status(400)
					.send({ error: "Validation failed", details: validation.error.issues });
			}

			const data = validation.data;

			// Normalize issuer URL if provided
			let normalizedIssuer: string | undefined;
			if (data.issuer) {
				try {
					normalizedIssuer = normalizeIssuerUrl(data.issuer);
					if (normalizedIssuer !== data.issuer) {
						request.log.info(
							{ original: data.issuer, normalized: normalizedIssuer },
							"Normalized OIDC issuer URL",
						);
					}
				} catch (error) {
					return reply.status(400).send({
						error: "Invalid issuer URL",
						details: error instanceof Error ? error.message : "Could not parse issuer URL",
					});
				}
			}

			try {
				// Check if provider exists (singleton with id=1)
				const existing = await app.prisma.oIDCProvider.findUnique({
					where: { id: 1 },
				});

				if (!existing) {
					return reply.status(404).send({ error: "OIDC provider not found" });
				}

				// If disabling provider, check if users would be locked out
				if (data.enabled === false) {
					const usersWithOidcOnly = await app.prisma.user.findMany({
						where: {
							hashedPassword: null,
							oidcAccounts: {
								some: {},
							},
						},
						include: {
							webauthnCredentials: true,
						},
					});

					const lockedOutUsers = usersWithOidcOnly.filter(
						(user) => user.webauthnCredentials.length === 0,
					);

					if (lockedOutUsers.length > 0) {
						return reply.status(400).send({
							error: `Cannot disable OIDC provider. ${lockedOutUsers.length} user(s) would be locked out. Please use DELETE with a replacement password instead to switch to password-based authentication.`,
						});
					}
				}

				// Prepare update data
				const updateData: Prisma.OIDCProviderUpdateInput = {
					...(data.displayName && { displayName: data.displayName }),
					...(data.clientId && { clientId: data.clientId }),
					...(normalizedIssuer && { issuer: normalizedIssuer }),
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

				// If critical settings changed, invalidate all sessions to force re-authentication
				const enabledChanged = data.enabled !== undefined && data.enabled !== existing.enabled;
				if (data.clientSecret || data.issuer || enabledChanged) {
					if (request.sessionToken) {
						// Preserve current session while invalidating all others
						await app.sessionService.invalidateAllUserSessions(
							request.currentUser?.id,
							request.sessionToken,
						);
						// Also invalidate sessions for other users (single-admin architecture)
						await app.prisma.session.deleteMany({
							where: { userId: { not: request.currentUser?.id } },
						});
					} else {
						await app.prisma.session.deleteMany({});
					}
					request.log.info("Invalidated all sessions due to OIDC provider configuration change");
				}

				return toPublicProvider(provider);
			} catch (error) {
				const prismaError = error as { code?: string };
				if (prismaError.code === "P2025") {
					return reply.status(404).send({ error: "OIDC provider not found" });
				}
				request.log.error({ err: error }, "Failed to update OIDC provider");
				return reply.status(500).send({ error: "Failed to update OIDC provider" });
			}
		},
	);

	/**
	 * DELETE /api/oidc-providers
	 * Delete the OIDC provider (admin only, singleton)
	 * Requires replacement password to prevent lockout
	 */
	app.delete<{ Body: unknown; Reply: ErrorResponse | undefined }>(
		"/api/oidc-providers",
		async (request, reply) => {
			// Require authentication (single-admin architecture)
			if (!request.currentUser) {
				return reply.status(403).send({ error: "Authentication required" });
			}

			// Validate request body - must include replacement password
			const validation = deleteOidcProviderSchema.safeParse(request.body);
			if (!validation.success) {
				return reply.status(400).send({
					error:
						"Replacement password required. You must provide a password to switch to password-based authentication.",
					details: validation.error.issues,
				});
			}

			const { replacementPassword } = validation.data;

			try {
				// Check if provider exists (singleton with id=1)
				const existing = await app.prisma.oIDCProvider.findUnique({
					where: { id: 1 },
				});

				if (!existing) {
					return reply.status(404).send({ error: "OIDC provider not found" });
				}

				// Check if any users would be locked out (users with OIDC-only and no password/passkeys)
				const usersWithOidcOnly = await app.prisma.user.findMany({
					where: {
						hashedPassword: null, // No password
						oidcAccounts: {
							some: {}, // Has OIDC linked
						},
					},
					include: {
						webauthnCredentials: true,
					},
				});

				const lockedOutUsers = usersWithOidcOnly.filter(
					(user) => user.webauthnCredentials.length === 0,
				);

				if (lockedOutUsers.length > 0) {
					// Hash the replacement password
					const hashedPassword = await hashPassword(replacementPassword);

					// Set password for all OIDC-only users to prevent lockout
					await app.prisma.$transaction(
						lockedOutUsers.map((user) =>
							app.prisma.user.update({
								where: { id: user.id },
								data: {
									hashedPassword,
									mustChangePassword: user.id !== request.currentUser?.id, // Force password change for other users
								},
							}),
						),
					);

					request.log.info(
						{ userCount: lockedOutUsers.length },
						"Set replacement password for OIDC-only users",
					);
				}

				// Delete all OIDC account links (cascade will handle this, but explicit for clarity)
				await app.prisma.oIDCAccount.deleteMany({});

				// Delete provider (singleton with id=1)
				await app.prisma.oIDCProvider.delete({
					where: { id: 1 },
				});

				// Invalidate all sessions to force re-authentication with new method
				if (request.sessionToken) {
					// Preserve current session while invalidating all others
					await app.sessionService.invalidateAllUserSessions(
						request.currentUser?.id,
						request.sessionToken,
					);
					// Also invalidate sessions for other users (single-admin architecture)
					await app.prisma.session.deleteMany({
						where: { userId: { not: request.currentUser?.id } },
					});
				} else {
					await app.prisma.session.deleteMany({});
				}

				return reply.status(204).send(undefined);
			} catch (error) {
				const prismaError = error as { code?: string };
				if (prismaError.code === "P2025") {
					return reply.status(404).send({ error: "OIDC provider not found" });
				}
				request.log.error({ err: error }, "Failed to delete OIDC provider");
				return reply.status(500).send({ error: "Failed to delete OIDC provider" });
			}
		},
	);
}
