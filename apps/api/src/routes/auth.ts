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
	email: z.string().email().max(255),
	username: z.string().min(3).max(50),
	password: passwordSchema,
	rememberMe: z.boolean().optional().default(false),
});

const loginSchema = z.object({
	identifier: z.string().min(3).max(255),
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

		const email = parsed.data.email.trim().toLowerCase();
		const username = parsed.data.username.trim();
		const password = parsed.data.password;

		if (!email || !username) {
			return reply.status(400).send({ error: "Invalid payload" });
		}

		const existingUser = await app.prisma.user.findFirst({
			where: {
				OR: [{ email }, { username }],
			},
		});

		if (existingUser) {
			return reply.status(409).send({ error: "User already exists" });
		}

		const hashedPassword = await hashPassword(password);

		// First user becomes admin
		const userCount = await app.prisma.user.count();
		const isFirstUser = userCount === 0;

		const user = await app.prisma.user.create({
			data: {
				email,
				username,
				hashedPassword,
				role: isFirstUser ? "ADMIN" : "USER",
				mustChangePassword: false,
			},
		});

		const session = await app.sessionService.createSession(user.id, parsed.data.rememberMe);
		app.sessionService.attachCookie(reply, session.token, parsed.data.rememberMe);

		return reply.status(201).send({
			user: {
				id: user.id,
				email: user.email,
				username: user.username,
				role: user.role,
				mustChangePassword: user.mustChangePassword,
				createdAt: user.createdAt,
			},
		});
	});

	app.post("/login", { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
		const parsed = loginSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const identifier = parsed.data.identifier.trim();
		const password = parsed.data.password;

		if (identifier.length === 0) {
			return reply.status(400).send({ error: "Invalid payload" });
		}

		const user = await app.prisma.user.findFirst({
			where: {
				OR: [{ email: identifier.toLowerCase() }, { username: identifier }],
			},
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
				email: user.email,
				username: user.username,
				role: user.role,
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
			select: { encryptedTmdbApiKey: true },
		});

		const hasTmdbApiKey = !!user?.encryptedTmdbApiKey;
		request.log.info(
			{ userId: request.currentUser.id, hasTmdbApiKey },
			"GET /auth/me - TMDB key status",
		);

		return reply.send({
			user: {
				id: request.currentUser.id,
				email: request.currentUser.email,
				username: request.currentUser.username,
				role: request.currentUser.role,
				mustChangePassword: request.currentUser.mustChangePassword,
				createdAt: request.currentUser.createdAt,
				hasTmdbApiKey,
			},
		});
	});

	const updateAccountSchema = z
		.object({
			email: z.string().email().max(255).optional(),
			username: z.string().min(3).max(50).optional(),
			currentPassword: z.string().min(8).max(128).optional(),
			newPassword: passwordSchema.optional(),
			tmdbApiKey: z.string().max(255).optional(),
		})
		.refine(
			(data) => {
				// If changing password, both currentPassword and newPassword are required
				if (data.newPassword && !data.currentPassword) {
					return false;
				}
				return true;
			},
			{ message: "Current password is required to set a new password" },
		);

	app.patch("/account", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = updateAccountSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const { email, username, currentPassword, newPassword, tmdbApiKey } = parsed.data;

		// Check if at least one field is being updated
		if (!email && !username && !newPassword && tmdbApiKey === undefined) {
			return reply.status(400).send({ error: "No updates provided" });
		}

		// If updating password, verify current password
		if (newPassword && currentPassword) {
			const user = await app.prisma.user.findUnique({
				where: { id: request.currentUser.id },
			});

			if (!user) {
				return reply.status(404).send({ error: "User not found" });
			}

			const valid = await verifyPassword(currentPassword, user.hashedPassword);
			if (!valid) {
				return reply.status(401).send({ error: "Current password is incorrect" });
			}
		}

		// Check for existing email/username conflicts
		if (email || username) {
			const conflicts = await app.prisma.user.findFirst({
				where: {
					AND: [
						{ id: { not: request.currentUser.id } },
						{
							OR: [
								email ? { email: email.trim().toLowerCase() } : {},
								username ? { username: username.trim() } : {},
							].filter((obj) => Object.keys(obj).length > 0),
						},
					],
				},
			});

			if (conflicts) {
				return reply.status(409).send({ error: "Email or username already in use" });
			}
		}

		// Build update data
		const updateData: {
			email?: string;
			username?: string;
			hashedPassword?: string;
			encryptedTmdbApiKey?: string;
			tmdbEncryptionIv?: string;
		} = {};
		if (email) {
			updateData.email = email.trim().toLowerCase();
		}
		if (username) {
			updateData.username = username.trim();
		}
		if (newPassword && currentPassword) {
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
				updateData.encryptedTmdbApiKey = null;
				updateData.tmdbEncryptionIv = null;
			}
		}

		// If changing password, clear the mustChangePassword flag
		if (newPassword && currentPassword) {
			updateData.mustChangePassword = false;
		}

		const updatedUser = await app.prisma.user.update({
			where: { id: request.currentUser.id },
			data: updateData,
		});

		return reply.send({
			user: {
				id: updatedUser.id,
				email: updatedUser.email,
				username: updatedUser.username,
				role: updatedUser.role,
				mustChangePassword: updatedUser.mustChangePassword,
				createdAt: updatedUser.createdAt,
			},
		});
	});

	done();
};

export const registerAuthRoutes = authRoutes;
