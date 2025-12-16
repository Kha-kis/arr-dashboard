import type { FastifyPluginCallback } from "fastify";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createPasskeyService } from "../lib/auth/passkey-service.js";

/**
 * In-memory storage for passkey challenges (production: use Redis)
 * Format: Map<userId or sessionId, { challenge, expiresAt }>
 */
const challengeStore = new Map<string, { challenge: string; expiresAt: number }>();

// Clean up expired challenges every 5 minutes
setInterval(() => {
	const now = Date.now();
	for (const [key, data] of challengeStore.entries()) {
		if (data.expiresAt < now) {
			challengeStore.delete(key);
		}
	}
}, 5 * 60 * 1000);

const passkeyRegisterOptionsSchema = z.object({
	friendlyName: z.string().max(50).optional(),
});

const passkeyRegisterVerifySchema = z.object({
	response: z.any(), // RegistrationResponseJSON
	friendlyName: z.string().max(50).optional(),
});

const passkeyLoginVerifySchema = z.object({
	response: z.any(), // AuthenticationResponseJSON
});

const passkeyDeleteSchema = z.object({
	credentialId: z.string(),
});

const passkeyRenameSchema = z.object({
	credentialId: z.string(),
	friendlyName: z.string().min(1).max(50),
});

const authPasskeyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	const passkeyService = createPasskeyService(app);

	/**
	 * POST /auth/passkey/register/options
	 * Generate registration options for creating a new passkey
	 * User must be authenticated
	 */
	app.post("/passkey/register/options", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		// Check if OIDC provider is enabled - if so, passkey registration is disabled
		const oidcProvider = await app.prisma.oIDCProvider.findFirst({
			where: { enabled: true },
		});

		if (oidcProvider) {
			return reply.status(403).send({
				error: "Passkey authentication is disabled. Please use OIDC authentication.",
			});
		}

		// Check if user has a password - passkeys require password authentication
		const user = await app.prisma.user.findUnique({
			where: { id: request.currentUser.id },
			select: { hashedPassword: true },
		});

		if (!user?.hashedPassword) {
			return reply.status(403).send({
				error: "Passkeys require password authentication. Please set up a password first.",
			});
		}

		const parsed = passkeyRegisterOptionsSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request" });
		}

		try {
			const options = await passkeyService.generateRegistrationOptions(
				request.currentUser.id,
				request.currentUser.username,
				undefined, // email field removed from User model
			);

			// Store challenge for verification
			challengeStore.set(request.currentUser.id, {
				challenge: options.challenge,
				expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
			});

			return reply.send(options);
		} catch (error) {
			request.log.error({ err: error }, "Failed to generate passkey registration options");
			return reply.status(500).send({ error: "Failed to generate registration options" });
		}
	});

	/**
	 * POST /auth/passkey/register/verify
	 * Verify registration response and store new passkey
	 * User must be authenticated
	 */
	app.post("/passkey/register/verify", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = passkeyRegisterVerifySchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request" });
		}

		const storedChallenge = challengeStore.get(request.currentUser.id);
		if (!storedChallenge) {
			return reply.status(400).send({ error: "Challenge not found or expired" });
		}

		// Remove challenge to prevent replay
		challengeStore.delete(request.currentUser.id);

		try {
			const response = parsed.data.response as RegistrationResponseJSON;
			await passkeyService.verifyRegistration(
				request.currentUser.id,
				response,
				storedChallenge.challenge,
				parsed.data.friendlyName,
			);

			return reply.send({ success: true, message: "Passkey registered successfully" });
		} catch (error) {
			request.log.error({ err: error }, "Passkey registration verification failed");
			return reply.status(400).send({ error: "Registration verification failed" });
		}
	});

	/**
	 * POST /auth/passkey/login/options
	 * Generate authentication options for passkey login
	 * Public endpoint (no authentication required)
	 */
	app.post("/passkey/login/options", async (request, reply) => {
		// Check if OIDC provider is enabled - if so, passkey login is disabled
		const oidcProvider = await app.prisma.oIDCProvider.findFirst({
			where: { enabled: true },
		});

		if (oidcProvider) {
			return reply.status(403).send({
				error: "Passkey authentication is disabled. Please use OIDC authentication.",
			});
		}

		try {
			const options = await passkeyService.generateAuthenticationOptions();

			// Generate temporary session ID for challenge storage
			const tempSessionId = randomBytes(32).toString("base64url");

			// Store challenge for verification
			challengeStore.set(tempSessionId, {
				challenge: options.challenge,
				expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
			});

			return reply.send({
				options,
				sessionId: tempSessionId, // Client must send this back
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to generate passkey authentication options");
			return reply.status(500).send({ error: "Failed to generate authentication options" });
		}
	});

	/**
	 * POST /auth/passkey/login/verify
	 * Verify authentication response and create session
	 * Public endpoint (no authentication required)
	 */
	app.post("/passkey/login/verify", async (request, reply) => {
		const parsed = passkeyLoginVerifySchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request" });
		}

		const sessionId = (request.body as { sessionId?: string }).sessionId;
		if (!sessionId) {
			return reply.status(400).send({ error: "Session ID required" });
		}

		const storedChallenge = challengeStore.get(sessionId);
		if (!storedChallenge) {
			return reply.status(400).send({ error: "Challenge not found or expired" });
		}

		// Remove challenge to prevent replay
		challengeStore.delete(sessionId);

		try {
			const response = parsed.data.response as AuthenticationResponseJSON;
			const verification = await passkeyService.verifyAuthentication(
				response,
				storedChallenge.challenge,
			);

			if (!verification.verified) {
				return reply.status(401).send({ error: "Authentication failed" });
			}

			// Get user details
			const user = await app.prisma.user.findUnique({
				where: { id: verification.userId },
			});

			if (!user) {
				return reply.status(404).send({ error: "User not found" });
			}

			// Create session
			const session = await app.sessionService.createSession(user.id, true);
			app.sessionService.attachCookie(reply, session.token, true);

			return reply.send({
				user: {
					id: user.id,
					username: user.username,
					mustChangePassword: user.mustChangePassword,
					createdAt: user.createdAt,
				},
			});
		} catch (error) {
			request.log.error({ err: error }, "Passkey authentication verification failed");
			return reply.status(401).send({ error: "Authentication failed" });
		}
	});

	/**
	 * GET /auth/passkey/credentials
	 * List user's registered passkeys
	 * User must be authenticated
	 */
	app.get("/passkey/credentials", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		try {
			const credentials = await passkeyService.listUserCredentials(request.currentUser.id);
			return reply.send({ credentials });
		} catch (error) {
			request.log.error({ err: error }, "Failed to list passkey credentials");
			return reply.status(500).send({ error: "Failed to list credentials" });
		}
	});

	/**
	 * DELETE /auth/passkey/credentials
	 * Delete a passkey credential (requires alternative auth method)
	 * User must be authenticated
	 */
	app.delete("/passkey/credentials", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = passkeyDeleteSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request" });
		}

		try {
			// Check how many passkeys the user currently has
			const passkeyCount = await app.prisma.webAuthnCredential.count({
				where: { userId: request.currentUser.id },
			});

			// If deleting the last passkey, ensure user has alternative auth
			if (passkeyCount === 1) {
				const user = await app.prisma.user.findUnique({
					where: { id: request.currentUser.id },
				});

				const hasPassword = !!user?.hashedPassword;

				const oidcAccounts = await app.prisma.oIDCAccount.count({
					where: { userId: request.currentUser.id },
				});

				if (!hasPassword && oidcAccounts === 0) {
					return reply.status(400).send({
						error:
							"Cannot delete last passkey without alternative authentication method. Please add a password or OIDC provider first.",
					});
				}
			}

			const deleted = await passkeyService.deleteCredential(
				request.currentUser.id,
				parsed.data.credentialId,
			);

			if (!deleted) {
				return reply.status(404).send({ error: "Credential not found" });
			}

			// Invalidate all other sessions (keep current session)
			if (request.sessionToken) {
				await app.sessionService.invalidateAllUserSessions(
					request.currentUser.id,
					request.sessionToken
				);
			} else {
				// Fallback: invalidate all sessions if sessionToken is somehow unavailable
				await app.sessionService.invalidateAllUserSessions(request.currentUser.id);
			}

			return reply.send({ success: true, message: "Passkey deleted successfully" });
		} catch (error) {
			request.log.error({ err: error }, "Failed to delete passkey credential");
			return reply.status(500).send({ error: "Failed to delete credential" });
		}
	});

	/**
	 * PATCH /auth/passkey/credentials
	 * Rename a passkey credential
	 * User must be authenticated
	 */
	app.patch("/passkey/credentials", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = passkeyRenameSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request" });
		}

		try {
			const updated = await passkeyService.renameCredential(
				request.currentUser.id,
				parsed.data.credentialId,
				parsed.data.friendlyName,
			);

			if (!updated) {
				return reply.status(404).send({ error: "Credential not found" });
			}

			return reply.send({ success: true, message: "Passkey renamed successfully" });
		} catch (error) {
			request.log.error({ err: error }, "Failed to rename passkey credential");
			return reply.status(500).send({ error: "Failed to rename credential" });
		}
	});

	done();
};

export const registerAuthPasskeyRoutes = authPasskeyRoutes;
