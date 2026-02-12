import { randomBytes } from "node:crypto";
import type { FastifyPluginCallback } from "fastify";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { warmConnectionsForUser } from "../lib/arr/connection-warmer.js";
import { OIDCProvider } from "../lib/auth/oidc-provider.js";
import { getSessionMetadata } from "../lib/auth/session-metadata.js";
import { normalizeIssuerUrl } from "../lib/auth/oidc-utils.js";
import { validateRequest } from "../lib/utils/validate.js";

/**
 * In-memory storage for OIDC states and nonces (production: use Redis)
 */
interface OIDCStateData {
	nonce: string;
	codeVerifier: string;
	expiresAt: number;
}

const oidcStateStore = new Map<string, OIDCStateData>();

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

const oidcCallbackSchema = z.object({
	code: z.string(),
	state: z.string(),
});

const oidcSetupSchema = z.object({
	displayName: z.string().min(1).max(100),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	issuer: z.string().url(),
	redirectUri: z.string().url().optional(),
	scopes: z.string().default("openid,email,profile"),
});

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
	app.post("/oidc/setup", async (request, reply) => {
		const parsed = validateRequest(oidcSetupSchema, request.body);

		const { displayName, clientId, clientSecret, scopes } = parsed;

		// Normalize issuer URL to prevent discovery failures
		let normalizedIssuer: string;
		try {
			normalizedIssuer = normalizeIssuerUrl(parsed.issuer);
			if (normalizedIssuer !== parsed.issuer) {
				request.log.info(
					{ original: parsed.issuer, normalized: normalizedIssuer },
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
		let redirectUri = parsed.redirectUri;
		if (!redirectUri) {
			const protocol = request.headers["x-forwarded-proto"] || request.protocol;
			const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost:3000";
			redirectUri = `${protocol}://${host}/auth/oidc/callback`;
			request.log.info({ redirectUri, protocol, host }, "Auto-generated redirect URI from request");
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
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage === "SETUP_CLOSED") {
				return reply.status(403).send({
					error:
						"OIDC setup is only allowed during initial setup. Use the admin panel to configure OIDC providers.",
				});
			}
			throw error;
		}
	});

	/**
	 * POST /auth/oidc/login
	 * Initiates OIDC login flow by generating authorization URL
	 */
	app.post("/oidc/login", async (request, reply) => {
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

		// Store state with 15 minute expiration
		oidcStateStore.set(state, {
			nonce,
			codeVerifier,
			expiresAt: Date.now() + 15 * 60 * 1000,
		});

		try {
			const authorizationUrl = await oidcProvider.getAuthorizationUrl(state, nonce, codeChallenge);
			request.log.info(
				{ authorizationUrl, redirectUri: dbProvider.redirectUri },
				"Generated OIDC authorization URL",
			);
			return reply.send({ authorizationUrl });
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
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
	});

	/**
	 * GET /auth/oidc/callback
	 * Handles OIDC callback after user authorization
	 */
	app.get("/oidc/callback", async (request, reply) => {
		const queryParams = request.query as Record<string, unknown>;
		request.log.info(
			{ hasCode: "code" in queryParams, url: request.url },
			"OIDC callback received",
		);

		// Check if OIDC provider returned an error
		if (queryParams.error) {
			const errorDescription = queryParams.error_description || "Unknown error";
			request.log.error(
				{ error: queryParams.error, description: errorDescription },
				"OIDC provider returned error",
			);
			return reply.status(400).send({
				error: `Authentication failed: ${queryParams.error}`,
				details: errorDescription,
			});
		}

		const parsed = oidcCallbackSchema.safeParse(request.query);
		if (!parsed.success) {
			request.log.error(
				{ errors: parsed.error.flatten(), query: request.query },
				"Invalid callback parameters",
			);
			return reply
				.status(400)
				.send({ error: "Invalid callback parameters", details: parsed.error.flatten() });
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

		request.log.info({ hasCode: !!code }, "Processing OIDC callback");

		// Get OIDC configuration from database
		const dbProvider = await app.prisma.oIDCProvider.findFirst({
			where: { enabled: true },
		});

		if (!dbProvider) {
			return reply.status(500).send({ error: "OIDC provider configuration error" });
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

		try {
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
				request.log.error({ tokenResponse }, "No access token in OIDC response");
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
			let oidcAccount = await app.prisma.oIDCAccount.findUnique({
				where: {
					providerUserId: userInfo.sub,
				},
				include: { user: true },
			});

			let user: { id: string; username: string };

			if (oidcAccount) {
				// Existing OIDC account - log them in
				user = oidcAccount.user;
			} else {
				// New OIDC account - check if user is authenticated or if this is setup

				// Check if user is currently authenticated (has active session)
				const currentUser = request.currentUser;

				if (currentUser) {
					// User is logged in - link OIDC to their account
					oidcAccount = await app.prisma.oIDCAccount.create({
						data: {
							providerUserId: userInfo.sub,
							userId: currentUser.id,
						},
						include: { user: true },
					});
					user = oidcAccount.user;
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
									"Cannot link OIDC account without authentication. Please log in first and add OIDC from settings.",
							});
						}
						throw error;
					}
				}
			}

			// Create session with metadata
			const metadata = getSessionMetadata(request);
			const session = await app.sessionService.createSession(user.id, true, metadata);
			app.sessionService.attachCookie(reply, session.token, true);

			// Pre-warm connections to ARR instances in background (don't await)
			warmConnectionsForUser(app, user.id).catch((err) => {
				request.log.debug({ err }, "Connection warm-up wrapper error (non-critical)");
			});

			// Redirect to root - Next.js middleware will redirect to dashboard if authenticated
			request.log.info(
				{ userId: user.id, username: user.username },
				"OIDC authentication successful, redirecting to root",
			);
			return reply.redirect("/", 302);
		} catch (error: unknown) {
			const errMsg = error instanceof Error ? error.message : String(error);
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
