import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginCallback } from "fastify";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { warmConnectionsForUser } from "../lib/arr/connection-warmer.js";
import { OIDCProvider } from "../lib/auth/oidc-provider.js";
import { resolveCanonicalIssuer } from "../lib/auth/oidc-utils.js";
import { getSessionMetadata } from "../lib/auth/session-metadata.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { validateRequest } from "../lib/utils/validate.js";

/**
 * In-memory storage for OIDC states and nonces (production: use Redis)
 */
interface OIDCStateData {
	nonce: string;
	codeVerifier: string;
	expiresAt: number;
	intent: "login" | "link" | "test";
	/**
	 * The authenticated admin who explicitly initiated an account-link flow.
	 * The session digest binds the callback to the same still-active session.
	 */
	linkUserId?: string;
	linkSessionDigest?: string;
}

const oidcStateStore = new Map<string, OIDCStateData>();
const OIDC_STATE_MAX_ENTRIES = 1000;

// Clean up expired states every 5 minutes
setInterval(
	() => {
		const now = Date.now();
		for (const [state, data] of oidcStateStore.entries()) {
			if (data.expiresAt < now) {
				oidcStateStore.delete(state);
			}
		}
	},
	5 * 60 * 1000,
);

/** Sanitize OIDC error strings — truncate and strip non-printable characters */
function sanitizeOIDCError(value: unknown, maxLength = 200): string {
	if (typeof value !== "string") return "Unknown error";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars for sanitization
	return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, maxLength);
}

const oidcCallbackSchema = z.object({
	code: z.string(),
	state: z.string(),
});

const oidcLoginSchema = z.object({
	intent: z.enum(["login", "link", "test"]).default("login"),
});

const oidcSetupSchema = z.object({
	displayName: z.string().min(1).max(100),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	issuer: z.string().url(),
	redirectUri: z.string().url().optional(),
	scopes: z.string().default("openid,email,profile"),
});

const OIDC_SETUP_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const OIDC_LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const OIDC_PROVIDER_CHANGED = "OIDC_PROVIDER_CHANGED";

const authOidcRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /auth/oidc/providers
	 * Returns the configured OIDC provider (if any)
	 */
	app.get("/oidc/providers", async (_request, reply) => {
		// Load the OIDC provider from database
		const dbProvider = await app.prisma.oIDCProvider.findFirst({
			where: { enabled: true },
			select: {
				displayName: true,
			},
		});

		return reply.send({
			provider: dbProvider ? { displayName: dbProvider.displayName, enabled: true } : null,
		});
	});

	/**
	 * POST /auth/oidc/setup
	 * Configure OIDC provider during initial setup (only allowed when no users exist)
	 */
	app.post(
		"/oidc/setup",
		{ config: { rateLimit: OIDC_SETUP_RATE_LIMIT } },
		async (request, reply) => {
			const parsed = validateRequest(oidcSetupSchema, request.body);

			const { displayName, clientId, clientSecret, scopes } = parsed;

			// Resolve canonical issuer URL from the provider's discovery document
			// This ensures the stored value matches what oauth4webapi compares against (RFC 8414 §2)
			let normalizedIssuer: string;
			try {
				const result = await resolveCanonicalIssuer(parsed.issuer);
				normalizedIssuer = result.issuer;
				if (result.source === "discovery" && normalizedIssuer !== parsed.issuer) {
					request.log.info(
						{ original: parsed.issuer, resolved: normalizedIssuer },
						"Resolved canonical OIDC issuer URL from discovery document",
					);
				}
				if (result.warning) {
					request.log.warn(
						{ original: parsed.issuer, resolved: normalizedIssuer, warning: result.warning },
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
			let redirectUri = parsed.redirectUri;
			if (redirectUri) {
				// Validate redirect URI origin matches APP_URL to prevent open redirect
				const redirectOrigin = new URL(redirectUri).origin;
				const appOrigin = new URL(app.config.APP_URL).origin;
				if (redirectOrigin !== appOrigin) {
					return reply.status(400).send({
						error: "Redirect URI must match the application URL origin",
					});
				}
			} else {
				redirectUri = `${app.config.APP_URL}/auth/oidc/callback`;
				request.log.info({ redirectUri }, "Auto-generated redirect URI from APP_URL");
			}

			try {
				// Use transaction to atomically check user count and create provider
				// This prevents race condition where two concurrent requests both see userCount === 0
				const provider = await app.prisma.$transaction(async (tx) => {
					// Check if any users exist (must be inside transaction for atomicity)
					const userCount = await tx.user.count();
					if (userCount > 0) {
						throw new Error("SETUP_CLOSED");
					}

					// Encrypt client secret
					const { value: encryptedClientSecret, iv: clientSecretIv } =
						app.encryptor.encrypt(clientSecret);

					// Check if provider already exists
					const existing = await tx.oIDCProvider.findFirst();

					if (existing) {
						// Update existing provider instead of rejecting
						// This allows fixing misconfigured OIDC during setup
						request.log.info(
							{ existingId: existing.id },
							"Updating existing OIDC provider during setup",
						);
						return await tx.oIDCProvider.update({
							where: { id: existing.id },
							data: {
								displayName,
								clientId,
								encryptedClientSecret,
								clientSecretIv,
								issuer: normalizedIssuer,
								redirectUri,
								scopes,
								enabled: true,
							},
						});
					}

					// Create OIDC provider atomically
					return await tx.oIDCProvider.create({
						data: {
							displayName,
							clientId,
							encryptedClientSecret,
							clientSecretIv,
							issuer: normalizedIssuer,
							redirectUri,
							scopes,
							enabled: true,
						},
					});
				});

				return reply.status(201).send({
					success: true,
					message: "OIDC provider configured successfully",
					provider: { displayName: provider.displayName },
				});
			} catch (error: unknown) {
				const errorMessage = getErrorMessage(error);
				if (errorMessage === "SETUP_CLOSED") {
					return reply.status(403).send({
						error:
							"OIDC setup is only allowed during initial setup. Use the admin panel to configure OIDC providers.",
					});
				}
				throw error;
			}
		},
	);

	/**
	 * POST /auth/oidc/login
	 * Initiates OIDC login flow by generating authorization URL
	 */
	app.post(
		"/oidc/login",
		{ config: { rateLimit: OIDC_LOGIN_RATE_LIMIT } },
		async (request, reply) => {
			const { intent } = validateRequest(oidcLoginSchema, request.body ?? {});
			const isAccountAction = intent === "link" || intent === "test";

			if (isAccountAction && (!request.currentUser || !request.sessionToken)) {
				return reply.status(401).send({
					error: "Authentication is required to link or test an OIDC account.",
				});
			}

			// Get OIDC configuration from database
			const dbProvider = await app.prisma.oIDCProvider.findFirst({
				where: { enabled: true },
			});

			if (!dbProvider) {
				return reply.status(400).send({ error: "OIDC provider not configured or disabled" });
			}

			// Decrypt client secret
			const clientSecret = app.encryptor.decrypt({
				value: dbProvider.encryptedClientSecret,
				iv: dbProvider.clientSecretIv,
			});

			const oidcProvider = new OIDCProvider({
				clientId: dbProvider.clientId,
				clientSecret,
				issuer: dbProvider.issuer,
				redirectUri: dbProvider.redirectUri,
				scopes: dbProvider.scopes,
			});

			// Generate state and nonce for CSRF protection
			const state = randomBytes(32).toString("base64url");
			const nonce = randomBytes(32).toString("base64url");

			// Generate PKCE code verifier and challenge for authorization code flow protection
			const codeVerifier = oauth.generateRandomCodeVerifier();
			const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

			// Evict oldest entry if map exceeds cap (defense against state exhaustion)
			if (oidcStateStore.size >= OIDC_STATE_MAX_ENTRIES) {
				const oldestKey = oidcStateStore.keys().next().value;
				if (oldestKey) oidcStateStore.delete(oldestKey);
			}

			// Store state with 15 minute expiration
			oidcStateStore.set(state, {
				nonce,
				codeVerifier,
				expiresAt: Date.now() + 15 * 60 * 1000,
				intent,
				linkUserId: isAccountAction ? request.currentUser!.id : undefined,
				linkSessionDigest: isAccountAction
					? createHash("sha256").update(request.sessionToken!).digest("base64url")
					: undefined,
			});

			try {
				request.log.info({ ip: request.ip }, "OIDC login initiated");
				const authorizationUrl = await oidcProvider.getAuthorizationUrl(
					state,
					nonce,
					codeChallenge,
				);
				request.log.debug(
					{ redirectUri: dbProvider.redirectUri },
					"Generated OIDC authorization URL",
				);
				return reply.send({ authorizationUrl });
			} catch (error) {
				const errMsg = getErrorMessage(error);
				request.log.error(
					{ err: error, errorMessage: errMsg },
					"Failed to generate OIDC authorization URL",
				);
				return reply.status(500).send({
					error: "Failed to initiate OIDC login",
					details: errMsg,
					hint: "Check the OIDC provider configuration in Settings > Authentication. Common issues: incorrect issuer URL, provider not accessible from server.",
				});
			}
		},
	);

	/**
	 * GET /auth/oidc/callback
	 * Handles OIDC callback after user authorization
	 */
	app.get("/oidc/callback", async (request, reply) => {
		const queryParams = request.query as Record<string, unknown>;
		request.log.info({ hasCode: "code" in queryParams }, "OIDC callback received");

		// Check if OIDC provider returned an error
		if (queryParams.error) {
			const sanitizedError = sanitizeOIDCError(queryParams.error);
			const sanitizedDescription = sanitizeOIDCError(queryParams.error_description);
			request.log.error(
				{ error: sanitizedError, description: sanitizedDescription },
				"OIDC provider returned error",
			);
			return reply.status(400).send({
				error: `Authentication failed: ${sanitizedError}`,
				details: sanitizedDescription,
			});
		}

		const parsed = oidcCallbackSchema.safeParse(request.query);
		if (!parsed.success) {
			request.log.error(
				{ errors: parsed.error.flatten(), query: request.query },
				"Invalid callback parameters",
			);
			return reply.status(400).send({ error: "Invalid callback parameters" });
		}

		const { code, state } = parsed.data;

		// Verify state to prevent CSRF and check expiration
		const storedState = oidcStateStore.get(state);
		if (!storedState || storedState.expiresAt < Date.now()) {
			// Clean up expired state if it exists
			if (storedState) {
				oidcStateStore.delete(state);
			}
			request.log.error(
				{ state, expired: storedState ? storedState.expiresAt < Date.now() : false },
				"Invalid or expired OIDC state",
			);
			return reply
				.status(400)
				.send({ error: "Invalid or expired state. Please try logging in again." });
		}

		// Remove state to prevent replay attacks
		oidcStateStore.delete(state);

		if (storedState.intent === "link" || storedState.intent === "test") {
			const callbackSessionDigest = request.sessionToken
				? createHash("sha256").update(request.sessionToken).digest("base64url")
				: undefined;
			if (
				request.currentUser?.id !== storedState.linkUserId ||
				callbackSessionDigest !== storedState.linkSessionDigest
			) {
				return reply.status(401).send({
					error:
						"The OIDC account action expired because the initiating session is no longer active. Sign in and try again.",
				});
			}
		}

		request.log.info({ hasCode: !!code }, "Processing OIDC callback");

		// Get OIDC configuration from database
		const dbProvider = await app.prisma.oIDCProvider.findFirst({
			where: { enabled: true },
		});

		if (!dbProvider) {
			return reply.status(500).send({ error: "OIDC provider configuration error" });
		}

		const providerAuthVersion = {
			id: dbProvider.id,
			enabled: true,
			clientId: dbProvider.clientId,
			encryptedClientSecret: dbProvider.encryptedClientSecret,
			clientSecretIv: dbProvider.clientSecretIv,
			issuer: dbProvider.issuer,
			redirectUri: dbProvider.redirectUri,
			scopes: dbProvider.scopes,
		};

		// Decrypt client secret
		const clientSecret = app.encryptor.decrypt({
			value: dbProvider.encryptedClientSecret,
			iv: dbProvider.clientSecretIv,
		});

		const oidcProvider = new OIDCProvider({
			clientId: dbProvider.clientId,
			clientSecret,
			issuer: dbProvider.issuer,
			redirectUri: dbProvider.redirectUri,
			scopes: dbProvider.scopes,
		});

		try {
			const isAccountAction = storedState.intent === "link" || storedState.intent === "test";
			// Convert query object to URLSearchParams for oauth4webapi
			const queryParams = new URLSearchParams();
			for (const [key, value] of Object.entries(request.query as Record<string, string>)) {
				if (value !== undefined && value !== null) {
					queryParams.append(key, value);
				}
			}

			request.log.info(
				{ redirectUri: dbProvider.redirectUri, issuer: dbProvider.issuer },
				"Exchanging authorization code",
			);

			// Exchange code for tokens (with state, nonce validation and PKCE)
			// Note: OIDCProvider auto-detects the token_endpoint_auth_method from discovery
			// Supports both client_secret_basic and client_secret_post for provider compatibility
			const tokenResponse = await oidcProvider.exchangeCode(
				queryParams,
				dbProvider.redirectUri,
				state,
				storedState.nonce,
				storedState.codeVerifier,
			);

			if (!tokenResponse.access_token) {
				request.log.error("No access token in OIDC response");
				throw new Error("No access token received from OIDC provider");
			}

			request.log.info("Successfully exchanged code for tokens");

			// Extract subject from ID token for validation
			if (!tokenResponse.id_token) {
				throw new Error("No ID token received from OIDC provider");
			}
			const idTokenClaims = oidcProvider.extractIdTokenClaims(tokenResponse.id_token);
			const expectedSubject = idTokenClaims.sub as string;

			if (!expectedSubject) {
				throw new Error("ID token missing 'sub' claim");
			}

			// Get user info from provider (validates that userinfo sub matches ID token sub)
			const userInfo = await oidcProvider.getUserInfo(tokenResponse.access_token, expectedSubject);
			request.log.info({ sub: userInfo.sub }, "Retrieved user info from OIDC provider");

			// Find existing OIDC account
			const oidcAccount = await app.prisma.oIDCAccount.findUnique({
				where: {
					providerUserId: userInfo.sub,
				},
				include: { user: true },
			});

			let user: { id: string; username: string };
			let replaceOidcLink = false;
			let revalidateOidcLink = false;

			if (storedState.intent === "link") {
				if (oidcAccount && oidcAccount.user.id !== storedState.linkUserId) {
					return reply.status(409).send({
						error: "This OIDC identity is already linked to another account.",
					});
				}
				user = {
					id: storedState.linkUserId!,
					username: request.currentUser!.username,
				};
				replaceOidcLink = true;
			} else if (storedState.intent === "test") {
				if (!oidcAccount || oidcAccount.user.id !== storedState.linkUserId) {
					return reply.status(401).send({
						error:
							"This OIDC identity is not linked to the admin account. Use Link Account to add it explicitly.",
					});
				}
				user = oidcAccount.user;
			} else if (oidcAccount) {
				// Existing OIDC account - log them in
				user = oidcAccount.user;
				revalidateOidcLink = true;
			} else {
				// User is not authenticated - check if this is initial setup
				// Use transaction to atomically check user count and create user
				// This prevents race condition where two concurrent callbacks both create admin accounts
				try {
					const newUser = await app.prisma.$transaction(async (tx) => {
						// Check if any users exist (must be inside transaction for atomicity)
						const userCount = await tx.user.count();

						if (userCount > 0) {
							throw new Error("SETUP_COMPLETE");
						}

						// Initial setup - create admin account atomically
						const username = userInfo.preferred_username ?? `user_${userInfo.sub}`;

						return await tx.user.create({
							data: {
								username,
								hashedPassword: null, // OIDC-only user (no password)
								oidcAccounts: {
									create: {
										providerUserId: userInfo.sub,
									},
								},
							},
						});
					});

					user = newUser;
				} catch (error) {
					if (error instanceof Error && error.message === "SETUP_COMPLETE") {
						// Setup already completed by concurrent request
						return reply.status(401).send({
							error:
								"Cannot sign in with an unlinked OIDC account. Sign in with your password, then use Link Account in Settings > Authentication.",
						});
					}
					throw error;
				}
			}

			// Create session with metadata
			const metadata = getSessionMetadata(request);
			const session = isAccountAction
				? await app.sessionService.rotateActiveSession(
						request.sessionToken!,
						user.id,
						metadata,
						replaceOidcLink
							? {
									onRotate: async (tx) => {
										const providerStillCurrent = await tx.oIDCProvider.updateMany({
											where: providerAuthVersion,
											data: { updatedAt: new Date() },
										});
										if (providerStillCurrent.count !== 1) {
											throw new Error(OIDC_PROVIDER_CHANGED);
										}
										await tx.oIDCAccount.deleteMany({
											where: { userId: user.id },
										});
										await tx.oIDCAccount.create({
											data: {
												providerUserId: userInfo.sub,
												userId: user.id,
											},
										});
									},
									revokeOtherSessions: true,
								}
							: undefined,
					)
				: revalidateOidcLink
					? await app.sessionService.createSessionIfAuthorized(
							user.id,
							true,
							metadata,
							async (tx) => {
								const providerStillCurrent = await tx.oIDCProvider.updateMany({
									where: providerAuthVersion,
									data: { updatedAt: new Date() },
								});
								if (providerStillCurrent.count !== 1) {
									return false;
								}
								const linked = await tx.oIDCAccount.updateMany({
									where: {
										providerUserId: userInfo.sub,
										userId: user.id,
									},
									data: { updatedAt: new Date() },
								});
								return linked.count === 1;
							},
						)
					: await app.sessionService.createSession(user.id, true, metadata);

			if (!session) {
				return reply.status(401).send({
					error: isAccountAction
						? "The OIDC account action expired because the initiating session is no longer active. Sign in and try again."
						: "This OIDC identity is no longer linked. Sign in with another method and try again.",
				});
			}
			app.sessionService.attachCookie(
				reply,
				session.token,
				true,
				isAccountAction ? session.expiresAt : undefined,
			);

			// Pre-warm connections to ARR instances in background (don't await)
			warmConnectionsForUser(app, user.id).catch((err) => {
				request.log.debug({ err }, "Connection warm-up wrapper error (non-critical)");
			});

			const redirectPath = isAccountAction ? "/settings#authentication" : "/";
			request.log.info(
				{ userId: user.id, username: user.username, redirectPath },
				"OIDC authentication successful",
			);
			return reply.redirect(redirectPath, 302);
		} catch (error: unknown) {
			if (error instanceof Error && error.message === OIDC_PROVIDER_CHANGED) {
				request.log.warn(
					{ providerId: dbProvider.id },
					"OIDC provider changed while an account link was in progress",
				);
				return reply.status(409).send({
					error:
						"The OIDC provider changed while the account link was in progress. Start Link Account again with the current provider configuration.",
				});
			}

			const errMsg = getErrorMessage(error);
			const errStack = error instanceof Error ? error.stack : undefined;
			request.log.error(
				{ err: error, errorMessage: errMsg, errorStack: errStack },
				"OIDC callback failed",
			);

			// Return more specific error messages
			let errorMessage = "OIDC authentication failed";
			if (errMsg?.includes("OAuth error")) {
				errorMessage = `Authentication failed: ${errMsg}`;
			} else if (errMsg?.includes("state")) {
				errorMessage = "State validation failed. Please try logging in again.";
			} else if (errMsg?.includes("nonce")) {
				errorMessage = "Nonce validation failed. Please try logging in again.";
			} else if (errMsg?.includes("code")) {
				errorMessage = "Authorization code validation failed. Please try logging in again.";
			}

			return reply.status(500).send({
				error: errorMessage,
				details: errMsg,
			});
		}
	});

	done();
};

export const registerAuthOidcRoutes = authOidcRoutes;
