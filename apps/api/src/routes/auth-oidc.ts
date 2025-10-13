import type { FastifyPluginCallback } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { OIDCProvider, type OIDCProviderType } from "../lib/auth/oidc-provider.js";

/**
 * In-memory storage for OIDC states and nonces (production: use Redis)
 * Format: Map<state, { nonce, provider, expiresAt }>
 */
const oidcStateStore = new Map<
	string,
	{ nonce: string; provider: OIDCProviderType; expiresAt: number }
>();

// Clean up expired states every 5 minutes
setInterval(() => {
	const now = Date.now();
	for (const [state, data] of oidcStateStore.entries()) {
		if (data.expiresAt < now) {
			oidcStateStore.delete(state);
		}
	}
}, 5 * 60 * 1000);

const oidcLoginSchema = z.object({
	provider: z.enum(["authelia", "authentik", "generic"]),
});

const oidcCallbackSchema = z.object({
	code: z.string(),
	state: z.string(),
});

const oidcSetupSchema = z.object({
	type: z.enum(["authelia", "authentik", "generic"]),
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
	 * Returns list of configured OIDC providers (from database)
	 */
	app.get("/oidc/providers", async (_request, reply) => {
		// Load enabled providers from database
		const dbProviders = await app.prisma.oIDCProvider.findMany({
			where: { enabled: true },
			select: {
				type: true,
				displayName: true,
			},
		});

		const providers = dbProviders.map((p) => ({
			type: p.type as OIDCProviderType,
			displayName: p.displayName,
			enabled: true,
		}));

		return reply.send({ providers });
	});

	/**
	 * POST /auth/oidc/setup
	 * Configure OIDC provider during initial setup (only allowed when no users exist)
	 */
	app.post("/oidc/setup", async (request, reply) => {
		// Only allow during setup (no users exist)
		const userCount = await app.prisma.user.count();
		if (userCount > 0) {
			return reply.status(403).send({
				error: "OIDC setup is only allowed during initial setup. Use the admin panel to configure OIDC providers.",
			});
		}

		const parsed = oidcSetupSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid OIDC configuration", details: parsed.error.flatten() });
		}

		const { type, displayName, clientId, clientSecret, issuer, scopes } = parsed.data;

		// Auto-generate redirect URI if not provided
		const redirectUri = parsed.data.redirectUri ?? `${app.env.APP_URL}/auth/oidc/callback`;

		// Check if provider already exists
		const existing = await app.prisma.oIDCProvider.findUnique({
			where: { type },
		});

		if (existing) {
			return reply.status(409).send({ error: `OIDC provider '${type}' already configured` });
		}

		// Encrypt client secret
		const { value: encryptedClientSecret, iv: clientSecretIv } = app.encryptor.encrypt(clientSecret);

		// Create OIDC provider
		await app.prisma.oIDCProvider.create({
			data: {
				type,
				displayName,
				clientId,
				encryptedClientSecret,
				clientSecretIv,
				issuer,
				redirectUri,
				scopes,
				enabled: true,
			},
		});

		return reply.status(201).send({
			success: true,
			message: "OIDC provider configured successfully",
			provider: { type, displayName },
		});
	});

	/**
	 * POST /auth/oidc/login
	 * Initiates OIDC login flow by generating authorization URL
	 */
	app.post("/oidc/login", async (request, reply) => {
		const parsed = oidcLoginSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid provider" });
		}

		const { provider } = parsed.data;

		// Get OIDC configuration from database
		const dbProvider = await app.prisma.oIDCProvider.findUnique({
			where: { type: provider },
		});

		if (!dbProvider || !dbProvider.enabled) {
			return reply.status(400).send({ error: "OIDC provider not configured or disabled" });
		}

		// Decrypt client secret
		const clientSecret = app.encryptor.decrypt({
			value: dbProvider.encryptedClientSecret,
			iv: dbProvider.clientSecretIv,
		});

		const oidcProvider = new OIDCProvider({
			type: provider,
			clientId: dbProvider.clientId,
			clientSecret,
			issuer: dbProvider.issuer,
			redirectUri: dbProvider.redirectUri,
		});

		// Generate state and nonce for CSRF protection
		const state = randomBytes(32).toString("base64url");
		const nonce = randomBytes(32).toString("base64url");

		// Store state with 15 minute expiration
		oidcStateStore.set(state, {
			nonce,
			provider,
			expiresAt: Date.now() + 15 * 60 * 1000,
		});

		try {
			const authorizationUrl = await oidcProvider.getAuthorizationUrl(state, nonce);
			return reply.send({ authorizationUrl });
		} catch (error) {
			request.log.error({ err: error, provider }, "Failed to generate OIDC authorization URL");
			return reply.status(500).send({ error: "Failed to initiate OIDC login" });
		}
	});

	/**
	 * GET /auth/oidc/callback
	 * Handles OIDC callback after user authorization
	 */
	app.get("/oidc/callback", async (request, reply) => {
		const parsed = oidcCallbackSchema.safeParse(request.query);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid callback parameters" });
		}

		const { code, state } = parsed.data;

		// Verify state to prevent CSRF
		const storedState = oidcStateStore.get(state);
		if (!storedState) {
			return reply.status(400).send({ error: "Invalid or expired state" });
		}

		// Remove state to prevent replay attacks
		oidcStateStore.delete(state);

		const { provider } = storedState;

		// Get OIDC configuration from database
		const dbProvider = await app.prisma.oIDCProvider.findUnique({
			where: { type: provider },
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
			type: provider,
			clientId: dbProvider.clientId,
			clientSecret,
			issuer: dbProvider.issuer,
			redirectUri: dbProvider.redirectUri,
		});

		try {
			// Exchange code for tokens (with nonce validation)
			const tokenResponse = await oidcProvider.exchangeCode(code, storedState.nonce);

			if (!tokenResponse.access_token) {
				throw new Error("No access token received from OIDC provider");
			}

			// Get user info from provider
			const userInfo = await oidcProvider.getUserInfo(tokenResponse.access_token);

			// Find existing OIDC account
			let oidcAccount = await app.prisma.oIDCAccount.findUnique({
				where: {
					provider_providerUserId: {
						provider,
						providerUserId: userInfo.sub,
					},
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
				const isAuthenticated = Boolean(request.currentUser);

				if (isAuthenticated) {
					// User is logged in - link OIDC to their account
					oidcAccount = await app.prisma.oIDCAccount.create({
						data: {
							provider,
							providerUserId: userInfo.sub,
							userId: request.currentUser.id,
						},
						include: { user: true },
					});
					user = oidcAccount.user;
				} else {
					// User is not authenticated - check if this is initial setup
					const userCount = await app.prisma.user.count();

					if (userCount === 0) {
						// Initial setup - create admin account
						const username = userInfo.preferred_username ?? `user_${userInfo.sub}`;

						const newUser = await app.prisma.user.create({
							data: {
								username,
								hashedPassword: null, // OIDC-only user (no password)
								oidcAccounts: {
									create: {
										provider,
										providerUserId: userInfo.sub,
									},
								},
							},
						});

						user = newUser;
					} else {
						// Users exist but not authenticated - security violation
						return reply.status(401).send({
							error: "Cannot link OIDC account without authentication. Please log in first and add OIDC from settings.",
						});
					}
				}
			}

			// Create session
			const session = await app.sessionService.createSession(user.id, true);
			app.sessionService.attachCookie(reply, session.token, true);

			// Redirect to dashboard
			return reply.redirect(302, "/dashboard");
		} catch (error) {
			request.log.error({ err: error, provider }, "OIDC callback failed");
			return reply.status(500).send({ error: "OIDC authentication failed" });
		}
	});

	done();
};

export const registerAuthOidcRoutes = authOidcRoutes;
