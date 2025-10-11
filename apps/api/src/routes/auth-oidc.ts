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

const authOidcRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /auth/oidc/providers
	 * Returns list of configured OIDC providers
	 */
	app.get("/oidc/providers", async (_request, reply) => {
		const providers: Array<{ type: OIDCProviderType; enabled: boolean }> = [];

		// Check which providers are configured
		const autheliaEnabled = !!(
			process.env.OIDC_AUTHELIA_CLIENT_ID && process.env.OIDC_AUTHELIA_ISSUER
		);
		const authentikEnabled = !!(
			process.env.OIDC_AUTHENTIK_CLIENT_ID && process.env.OIDC_AUTHENTIK_ISSUER
		);
		const genericEnabled = !!(
			process.env.OIDC_GENERIC_CLIENT_ID && process.env.OIDC_GENERIC_ISSUER
		);

		if (autheliaEnabled) {
			providers.push({ type: "authelia", enabled: true });
		}
		if (authentikEnabled) {
			providers.push({ type: "authentik", enabled: true });
		}
		if (genericEnabled) {
			providers.push({ type: "generic", enabled: true });
		}

		return reply.send({ providers });
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

		// Get OIDC configuration
		const clientId = process.env[`OIDC_${provider.toUpperCase()}_CLIENT_ID`];
		const clientSecret = process.env[`OIDC_${provider.toUpperCase()}_CLIENT_SECRET`];
		const issuer = process.env[`OIDC_${provider.toUpperCase()}_ISSUER`];
		const redirectUri = process.env[`OIDC_${provider.toUpperCase()}_REDIRECT_URI`];

		if (!clientId || !clientSecret || !issuer || !redirectUri) {
			return reply.status(400).send({ error: "OIDC provider not configured" });
		}

		const oidcProvider = new OIDCProvider({
			type: provider,
			clientId,
			clientSecret,
			issuer,
			redirectUri,
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

		// Get OIDC configuration
		const clientId = process.env[`OIDC_${provider.toUpperCase()}_CLIENT_ID`];
		const clientSecret = process.env[`OIDC_${provider.toUpperCase()}_CLIENT_SECRET`];
		const issuer = process.env[`OIDC_${provider.toUpperCase()}_ISSUER`];
		const redirectUri = process.env[`OIDC_${provider.toUpperCase()}_REDIRECT_URI`];

		if (!clientId || !clientSecret || !issuer || !redirectUri) {
			return reply.status(500).send({ error: "OIDC provider configuration error" });
		}

		const oidcProvider = new OIDCProvider({
			type: provider,
			clientId,
			clientSecret,
			issuer,
			redirectUri,
		});

		try {
			// Exchange code for tokens
			const tokenResponse = await oidcProvider.exchangeCode(code);

			if (!tokenResponse.access_token) {
				throw new Error("No access token received from OIDC provider");
			}

			// Get user info from provider
			const userInfo = await oidcProvider.getUserInfo(tokenResponse.access_token);

			// Find or create OIDC account
			let oidcAccount = await app.prisma.oIDCAccount.findUnique({
				where: {
					provider_providerUserId: {
						provider,
						providerUserId: userInfo.sub,
					},
				},
				include: { user: true },
			});

			let user: { id: string; email: string; username: string; role: string };

			if (oidcAccount) {
				// Existing OIDC account - log them in
				user = oidcAccount.user;
			} else {
				// New OIDC account - check if we need to link or create user
				const email = userInfo.email?.toLowerCase();
				const username =
					userInfo.preferred_username ?? userInfo.email?.split("@")[0] ?? `user_${userInfo.sub}`;

				if (!email) {
					return reply
						.status(400)
						.send({ error: "OIDC provider did not provide email address" });
				}

				// Check if user exists with this email
				const existingUser = await app.prisma.user.findUnique({
					where: { email },
				});

				if (existingUser) {
					// Link OIDC account to existing user
					oidcAccount = await app.prisma.oIDCAccount.create({
						data: {
							provider,
							providerUserId: userInfo.sub,
							providerEmail: email,
							userId: existingUser.id,
						},
						include: { user: true },
					});
					user = existingUser;
				} else {
					// Create new user with OIDC account
					const userCount = await app.prisma.user.count();
					const isFirstUser = userCount === 0;

					const newUser = await app.prisma.user.create({
						data: {
							email,
							username,
							hashedPassword: null, // OIDC-only user (no password)
							role: isFirstUser ? "ADMIN" : "USER",
							oidcAccounts: {
								create: {
									provider,
									providerUserId: userInfo.sub,
									providerEmail: email,
								},
							},
						},
					});

					user = newUser;
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
