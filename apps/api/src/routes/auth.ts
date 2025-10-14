import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";

const passwordSchema = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.max(128, "Password must not exceed 128 characters")
	.regex(/[a-z]/, "Password must contain at least one lowercase letter")
	.regex(/[A-Z]/, "Password must contain at least one uppercase letter")
	.regex(/[0-9]/, "Password must contain at least one number")
	.regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character");

const registerSchema = z.object({
	username: z.string().min(3).max(50),
	password: passwordSchema.optional(), // Optional for passkey-only accounts
	rememberMe: z.boolean().optional().default(false),
});

const loginSchema = z.object({
	username: z.string().min(3).max(50),
	password: z.string().min(8).max(128),
	rememberMe: z.boolean().optional().default(false),
});

const REGISTER_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

const authRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/setup-required", async (request, reply) => {
		const userCount = await app.prisma.user.count();
		return reply.send({ required: userCount === 0 });
	});

	app.post("/register", { config: { rateLimit: REGISTER_RATE_LIMIT } }, async (request, reply) => {
		const parsed = registerSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const username = parsed.data.username.trim();
		const password = parsed.data.password;

		if (!username) {
			return reply.status(400).send({ error: "Invalid payload" });
		}

		// Hash password if provided (null for passkey-only accounts)
		const hashedPassword = password ? await hashPassword(password) : null;

		try {
			// Use transaction to atomically check user count and create user
			// This prevents race condition where two concurrent requests both see userCount === 0
			const user = await app.prisma.$transaction(async (tx) => {
				// Check if any users exist (must be inside transaction for atomicity)
				const userCount = await tx.user.count();
				if (userCount > 0) {
					throw new Error("REGISTRATION_CLOSED");
				}

				// Check for username conflicts
				const existingUser = await tx.user.findFirst({
					where: { username },
				});

				if (existingUser) {
					throw new Error("USERNAME_EXISTS");
				}

				// Create the first user
				return await tx.user.create({
					data: {
						username,
						hashedPassword,
						mustChangePassword: false,
					},
				});
			});

			const session = await app.sessionService.createSession(user.id, parsed.data.rememberMe);
			app.sessionService.attachCookie(reply, session.token, parsed.data.rememberMe);

			return reply.status(201).send({
				user: {
					id: user.id,
					username: user.username,
					mustChangePassword: user.mustChangePassword,
					createdAt: user.createdAt,
				},
			});
		} catch (error: any) {
			if (error.message === "REGISTRATION_CLOSED") {
				return reply.status(403).send({
					error: "Registration is only allowed during initial setup. Please use login, OIDC, or passkey authentication.",
				});
			}
			if (error.message === "USERNAME_EXISTS") {
				return reply.status(409).send({ error: "User already exists" });
			}
			throw error;
		}
	});

	app.post("/login", { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
		const parsed = loginSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const username = parsed.data.username.trim();
		const password = parsed.data.password;

		if (username.length === 0) {
			return reply.status(400).send({ error: "Invalid payload" });
		}

		const user = await app.prisma.user.findFirst({
			where: { username },
		});

		if (!user) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return reply.status(401).send({ error: "Invalid credentials" });
		}

		// Check if account is locked
		if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
			const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
			return reply.status(423).send({
				error: `Account locked. Try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}.`,
			});
		}

		// Check if user has a password set
		if (!user.hashedPassword) {
			return reply.status(401).send({
				error: "This account uses passwordless authentication. Please sign in with OIDC or passkey.",
			});
		}

		const valid = await verifyPassword(password, user.hashedPassword);
		if (!valid) {
			// Increment failed attempts
			const failedAttempts = user.failedLoginAttempts + 1;
			const MAX_FAILED_ATTEMPTS = 5;
			const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

			await app.prisma.user.update({
				where: { id: user.id },
				data: {
					failedLoginAttempts: failedAttempts,
					lockedUntil:
						failedAttempts >= MAX_FAILED_ATTEMPTS
							? new Date(Date.now() + LOCKOUT_DURATION_MS)
							: null,
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 200));

			if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
				return reply.status(423).send({
					error: "Too many failed attempts. Account locked for 15 minutes.",
				});
			}

			return reply.status(401).send({ error: "Invalid credentials" });
		}

		// Reset failed attempts on successful login
		if (user.failedLoginAttempts > 0 || user.lockedUntil) {
			await app.prisma.user.update({
				where: { id: user.id },
				data: {
					failedLoginAttempts: 0,
					lockedUntil: null,
				},
			});
		}

		const session = await app.sessionService.createSession(user.id, parsed.data.rememberMe);
		app.sessionService.attachCookie(reply, session.token, parsed.data.rememberMe);

		return reply.send({
			user: {
				id: user.id,
				username: user.username,
				mustChangePassword: user.mustChangePassword,
				createdAt: user.createdAt,
			},
		});
	});

	app.post("/logout", async (request, reply) => {
		if (!request.sessionToken) {
			return reply.status(204).send();
		}

		await app.sessionService.invalidateSession(request.sessionToken);
		app.sessionService.clearCookie(reply);
		return reply.status(204).send();
	});

	app.get("/me", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const user = await app.prisma.user.findUnique({
			where: { id: request.currentUser.id },
			select: { encryptedTmdbApiKey: true, hashedPassword: true },
		});

		const hasTmdbApiKey = !!user?.encryptedTmdbApiKey;
		const hasPassword = !!user?.hashedPassword;
		request.log.info(
			{ userId: request.currentUser.id, hasTmdbApiKey, hasPassword },
			"GET /auth/me - User status",
		);

		return reply.send({
			user: {
				id: request.currentUser.id,
				username: request.currentUser.username,
				mustChangePassword: request.currentUser.mustChangePassword,
				createdAt: request.currentUser.createdAt,
				hasTmdbApiKey,
				hasPassword,
			},
		});
	});

	const updateAccountSchema = z.object({
		username: z.string().min(3).max(50).optional(),
		currentPassword: z.string().min(8).max(128).optional(),
		newPassword: passwordSchema.optional(),
		tmdbApiKey: z.string().max(255).optional(),
	});

	app.patch("/account", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = updateAccountSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const { username, currentPassword, newPassword, tmdbApiKey } = parsed.data;

		// Check if at least one field is being updated
		if (!username && !newPassword && tmdbApiKey === undefined) {
			return reply.status(400).send({ error: "No updates provided" });
		}

		// If updating password, handle based on whether user has existing password
		if (newPassword) {
			const user = await app.prisma.user.findUnique({
				where: { id: request.currentUser.id },
			});

			if (!user) {
				return reply.status(404).send({ error: "User not found" });
			}

			// If user has existing password, require currentPassword to change it
			if (user.hashedPassword) {
				if (!currentPassword) {
					return reply.status(400).send({ error: "Current password is required to change password" });
				}
				const valid = await verifyPassword(currentPassword, user.hashedPassword);
				if (!valid) {
					return reply.status(401).send({ error: "Current password is incorrect" });
				}
			}
			// If user doesn't have password, allow adding one without currentPassword
		}

		// Check for existing username conflicts
		if (username) {
			const conflicts = await app.prisma.user.findFirst({
				where: {
					AND: [
						{ id: { not: request.currentUser.id } },
						{ username: username.trim() },
					],
				},
			});

			if (conflicts) {
				return reply.status(409).send({ error: "Username already in use" });
			}
		}

		// Build update data
		const updateData: {
			username?: string;
			hashedPassword?: string;
			encryptedTmdbApiKey?: string;
			tmdbEncryptionIv?: string;
		} = {};
		if (username) {
			updateData.username = username.trim();
		}
		if (newPassword) {
			updateData.hashedPassword = await hashPassword(newPassword);
		}
		if (tmdbApiKey !== undefined) {
			request.log.info(
				{ hasTmdbApiKey: !!tmdbApiKey, length: tmdbApiKey?.length },
				"Processing TMDB API key",
			);
			if (tmdbApiKey) {
				// Encrypt the TMDB API key
				const { value, iv } = app.encryptor.encrypt(tmdbApiKey);
				updateData.encryptedTmdbApiKey = value;
				updateData.tmdbEncryptionIv = iv;
				request.log.info({ hasEncrypted: !!value, hasIv: !!iv }, "Encrypted TMDB API key");
			} else {
				// Clear the TMDB API key if empty string provided
				updateData.encryptedTmdbApiKey = undefined;
				updateData.tmdbEncryptionIv = undefined;
			}
		}

		// If setting/changing password, clear the mustChangePassword flag
		if (newPassword) {
			(updateData as { mustChangePassword?: boolean }).mustChangePassword = false;
		}

		const updatedUser = await app.prisma.user.update({
			where: { id: request.currentUser.id },
			data: updateData,
		});

		return reply.send({
			user: {
				id: updatedUser.id,
				username: updatedUser.username,
				mustChangePassword: updatedUser.mustChangePassword,
				createdAt: updatedUser.createdAt,
			},
		});
	});

	/**
	 * DELETE /auth/password
	 * Remove password from account (requires alternative auth method)
	 */
	const removePasswordSchema = z.object({
		currentPassword: z.string().min(8).max(128),
	});

	app.delete("/password", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = removePasswordSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const { currentPassword } = parsed.data;

		// Get user with current password
		const user = await app.prisma.user.findUnique({
			where: { id: request.currentUser.id },
		});

		if (!user || !user.hashedPassword) {
			return reply.status(400).send({ error: "User does not have a password set" });
		}

		// Verify current password
		const valid = await verifyPassword(currentPassword, user.hashedPassword);
		if (!valid) {
			return reply.status(401).send({ error: "Current password is incorrect" });
		}

		// Check for alternative authentication methods
		const oidcAccounts = await app.prisma.oIDCAccount.count({
			where: { userId: request.currentUser.id },
		});

		const passkeys = await app.prisma.webAuthnCredential.count({
			where: { userId: request.currentUser.id },
		});

		if (oidcAccounts === 0 && passkeys === 0) {
			return reply.status(400).send({
				error:
					"Cannot remove password without alternative authentication method. Please add an OIDC provider or passkey first.",
			});
		}

		// Remove password
		await app.prisma.user.update({
			where: { id: request.currentUser.id },
			data: { hashedPassword: null },
		});

		return reply.send({
			success: true,
			message: "Password removed successfully. You can now only sign in using OIDC or passkeys.",
		});
	});

	/**
	 * DELETE /auth/account
	 * Delete current user's account if they have no authentication methods
	 * Used for cleanup after failed passkey setup
	 */
	app.delete("/account", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const userId = request.currentUser.id;

		// Check for any authentication methods
		const user = await app.prisma.user.findUnique({
			where: { id: userId },
		});

		if (!user) {
			return reply.status(404).send({ error: "User not found" });
		}

		const oidcAccounts = await app.prisma.oIDCAccount.count({
			where: { userId },
		});

		const passkeys = await app.prisma.webAuthnCredential.count({
			where: { userId },
		});

		const hasPassword = !!user.hashedPassword;

		// Only allow deletion if user has NO authentication methods
		if (hasPassword || oidcAccounts > 0 || passkeys > 0) {
			return reply.status(400).send({
				error:
					"Cannot delete account with existing authentication methods. Please remove password, OIDC accounts, and passkeys first.",
			});
		}

		// Delete all user data (cascade will handle related records)
		await app.prisma.user.delete({
			where: { id: userId },
		});

		// Invalidate session and clear cookie
		if (request.sessionToken) {
			await app.sessionService.invalidateSession(request.sessionToken);
		}
		app.sessionService.clearCookie(reply);

		return reply.send({
			success: true,
			message: "Account deleted successfully.",
		});
	});

	done();
};

export const registerAuthRoutes = authRoutes;
