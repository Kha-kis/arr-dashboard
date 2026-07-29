import { createHash } from "node:crypto";
import {
	createOidcProviderSchema,
	deleteOidcProviderSchema,
	type ErrorResponse,
	type OIDCProvider,
	type OIDCProviderResponse,
	updateOidcProviderSchema,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { buildOidcRedirectUriFromAppUrl } from "../lib/auth/oidc-redirect-uri.js";
import { resolveCanonicalIssuer } from "../lib/auth/oidc-utils.js";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import type { Prisma, OIDCProvider as PrismaOIDCProvider } from "../lib/prisma.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { validateRequest } from "../lib/utils/validate.js";

const OIDC_PROVIDER_CHANGED = "OIDC_PROVIDER_CHANGED";
const OIDC_SESSION_INACTIVE = "OIDC_SESSION_INACTIVE";
const OIDC_ADMIN_AUTH_CHANGED = "OIDC_ADMIN_AUTH_CHANGED";

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
			const provider = await app.prisma.oIDCProvider.findFirst();

			if (!provider) {
				return reply.send({ provider: null, linked: false });
			}

			const linkedAccount = await app.prisma.oIDCAccount.findFirst({
				where: { userId: request.currentUser!.id },
				select: { id: true },
			});

			// Return provider without exposing client secret
			return reply.send({
				provider: toPublicProvider(provider),
				linked: linkedAccount !== null,
			});
		},
	);

	/**
	 * POST /api/oidc-providers
	 * Create the OIDC provider (admin only - only one allowed)
	 */
	app.post<{ Body: unknown; Reply: OIDCProvider | ErrorResponse }>(
		"/api/oidc-providers",
		async (request, reply) => {
			const data = validateRequest(createOidcProviderSchema, request.body);

			// Resolve canonical issuer URL from the provider's discovery document
			let normalizedIssuer: string;
			try {
				const result = await resolveCanonicalIssuer(data.issuer);
				normalizedIssuer = result.issuer;
				if (result.source === "discovery" && normalizedIssuer !== data.issuer) {
					request.log.info(
						{ original: data.issuer, resolved: normalizedIssuer },
						"Resolved canonical OIDC issuer URL from discovery document",
					);
				}
				if (result.warning) {
					request.log.warn(
						{ original: data.issuer, resolved: normalizedIssuer, warning: result.warning },
						"OIDC discovery warning — using fallback issuer URL",
					);
				}
			} catch (error) {
				return reply.status(400).send({
					error: "Invalid issuer URL",
					details: getErrorMessage(error, "Could not parse issuer URL"),
				});
			}

			// Auto-generate redirect URI if not provided
			// Use APP_URL (configured env var) as the trusted base URL.
			// Only fall back to request headers when TRUST_PROXY is enabled (headers are validated by Fastify).
			let redirectUri = data.redirectUri;
			if (!redirectUri) {
				const generatedRedirectUri = buildOidcRedirectUriFromAppUrl(app.config.APP_URL);
				if (!generatedRedirectUri) {
					return reply.status(400).send({
						error:
							"APP_URL must be a credential-free HTTP(S) URL that can generate a valid OIDC redirect URI.",
					});
				}
				redirectUri = generatedRedirectUri;
				request.log.info({ redirectUri }, "Auto-generated redirect URI from APP_URL");
			}

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

			request.log.info(
				{ displayName: data.displayName, issuer: normalizedIssuer },
				"OIDC provider created",
			);

			return reply.status(201).send(toPublicProvider(provider));
		},
	);

	/**
	 * PUT /api/oidc-providers
	 * Update the OIDC provider (admin only, singleton)
	 */
	app.put<{ Body: unknown; Reply: OIDCProvider | ErrorResponse }>(
		"/api/oidc-providers",
		async (request, reply) => {
			const data = validateRequest(updateOidcProviderSchema, request.body);

			// Resolve canonical issuer URL if provided
			let normalizedIssuer: string | undefined;
			if (data.issuer) {
				try {
					const result = await resolveCanonicalIssuer(data.issuer);
					normalizedIssuer = result.issuer;
					if (result.source === "discovery" && normalizedIssuer !== data.issuer) {
						request.log.info(
							{ original: data.issuer, resolved: normalizedIssuer },
							"Resolved canonical OIDC issuer URL from discovery document",
						);
					}
					if (result.warning) {
						request.log.warn(
							{ original: data.issuer, resolved: normalizedIssuer, warning: result.warning },
							"OIDC discovery warning — using fallback issuer URL",
						);
					}
				} catch (error) {
					return reply.status(400).send({
						error: "Invalid issuer URL",
						details: getErrorMessage(error, "Could not parse issuer URL"),
					});
				}
			}

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

			request.log.info({ changedFields: Object.keys(updateData) }, "OIDC provider updated");

			// If critical settings changed, invalidate all sessions to force re-authentication
			const enabledChanged = data.enabled !== undefined && data.enabled !== existing.enabled;
			if (data.clientSecret || data.issuer || enabledChanged) {
				if (request.sessionToken) {
					// Preserve current session while invalidating all others
					await app.sessionService.invalidateAllUserSessions(
						request.currentUser!.id,
						request.sessionToken,
					);
					// Also invalidate sessions for other users (single-admin architecture)
					await app.prisma.session.deleteMany({
						where: { userId: { not: request.currentUser!.id } },
					});
				} else {
					await app.prisma.session.deleteMany({});
				}
				request.log.info("Invalidated all sessions due to OIDC provider configuration change");
			}

			return toPublicProvider(provider);
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
			// Validate request body - must include replacement password
			const validation = deleteOidcProviderSchema.safeParse(request.body);
			if (!validation.success) {
				return reply.status(400).send({
					error:
						"Replacement password required. You must provide a password to switch to password-based authentication.",
					details: validation.error.issues,
				});
			}

			const { replacementPassword, currentPassword } = validation.data;

			// Check if provider exists (singleton with id=1)
			const existing = await app.prisma.oIDCProvider.findUnique({
				where: { id: 1 },
			});

			if (!existing) {
				return reply.status(404).send({ error: "OIDC provider not found" });
			}

			const currentAdmin = await app.prisma.user.findUnique({
				where: { id: request.currentUser!.id },
				select: { hashedPassword: true },
			});
			if (!currentAdmin) {
				return reply.status(404).send({ error: "User not found" });
			}
			if (currentAdmin.hashedPassword) {
				if (!currentPassword) {
					return reply
						.status(400)
						.send({ error: "Current password is required to replace your password" });
				}
				const valid = await verifyPassword(currentPassword, currentAdmin.hashedPassword);
				if (!valid) {
					request.log.warn("OIDC provider deletion failed: invalid current password");
					return reply.status(401).send({ error: "Current password is incorrect" });
				}
			}

			// Deleting OIDC is an explicit switch to password authentication. Always
			// prepare the supplied replacement so a concurrent passkey/password change
			// cannot leave a linked account without a sign-in method.
			const hashedPassword = await hashPassword(replacementPassword);
			if (!request.sessionToken) {
				return reply.status(401).send({
					error: "The initiating session is no longer active. Sign in and try again.",
				});
			}
			const initiatingSessionId = createHash("sha256").update(request.sessionToken).digest("hex");
			const providerAuthVersion = {
				id: existing.id,
				enabled: existing.enabled,
				clientId: existing.clientId,
				encryptedClientSecret: existing.encryptedClientSecret,
				clientSecretIv: existing.clientSecretIv,
				issuer: existing.issuer,
				redirectUri: existing.redirectUri,
				scopes: existing.scopes,
			};

			try {
				const replacedUsers = await app.prisma.$transaction(async (tx) => {
					const now = new Date();
					const consumedSession = await tx.session.deleteMany({
						where: {
							id: initiatingSessionId,
							userId: request.currentUser!.id,
							expiresAt: { gt: now },
						},
					});
					if (consumedSession.count !== 1) {
						throw new Error(OIDC_SESSION_INACTIVE);
					}

					// Delete the exact provider version first. This serializes deletion with an
					// in-flight Link Account callback before either side changes OIDC links.
					const deletedProvider = await tx.oIDCProvider.deleteMany({
						where: providerAuthVersion,
					});
					if (deletedProvider.count !== 1) {
						throw new Error(OIDC_PROVIDER_CHANGED);
					}

					// Install the initiating admin's replacement only if the credential
					// verified above is still current. A concurrent password change aborts
					// and rolls back the provider deletion.
					const updatedAdmin = await tx.user.updateMany({
						where: {
							id: request.currentUser!.id,
							hashedPassword: currentAdmin.hashedPassword,
						},
						data: {
							hashedPassword,
							mustChangePassword: false,
							failedLoginAttempts: 0,
							lockedUntil: null,
						},
					});
					if (updatedAdmin.count !== 1) {
						throw new Error(OIDC_ADMIN_AUTH_CHANGED);
					}

					// The provider lock prevents new links from being created while this
					// snapshot is installed with a replacement password.
					const affectedUsers = await tx.user.findMany({
						where: {
							OR: [
								{ id: request.currentUser!.id },
								{ oidcAccounts: { some: {} } },
							],
						},
						select: { id: true, hashedPassword: true },
					});
					let replacedUsers = 1;
					for (const user of affectedUsers) {
						const isCurrentAdmin = user.id === request.currentUser!.id;
						if (!isCurrentAdmin && !user.hashedPassword) {
							await tx.user.update({
								where: { id: user.id },
								data: {
									hashedPassword,
									mustChangePassword: true,
									failedLoginAttempts: 0,
									lockedUntil: null,
								},
							});
							replacedUsers += 1;
						}
					}

					// OIDCAccount has no provider relation, so remove links explicitly.
					await tx.oIDCAccount.deleteMany({});

					// Credential removal and session revocation must commit or roll back
					// together; otherwise a cleanup failure can preserve authenticated sessions.
					await tx.session.deleteMany({});
					return replacedUsers;
				});

				request.log.info(
					{ replacedUsers },
					"Installed replacement passwords for OIDC-linked users",
				);
			} catch (error) {
				if (error instanceof Error && error.message === OIDC_SESSION_INACTIVE) {
					return reply.status(401).send({
						error: "The initiating session is no longer active. Sign in and try again.",
					});
				}
				if (error instanceof Error && error.message === OIDC_PROVIDER_CHANGED) {
					return reply.status(409).send({
						error:
							"The OIDC provider changed while deletion was in progress. Review the current configuration and try again.",
					});
				}
				if (error instanceof Error && error.message === OIDC_ADMIN_AUTH_CHANGED) {
					return reply.status(409).send({
						error:
							"Your password changed while deletion was in progress. Sign in and try again.",
					});
				}
				throw error;
			}

			request.log.info("OIDC provider deleted");
			app.sessionService.clearCookie(reply);
			return reply.status(204).send(undefined);
		},
	);
}
