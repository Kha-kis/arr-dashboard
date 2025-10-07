import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiEnv } from "../../config/env.js";

/**
 * Base cookie options for session management.
 * CSRF Protection Strategy:
 * - sameSite: "lax" provides CSRF protection for most scenarios when combined with CORS
 * - httpOnly: true prevents XSS attacks from stealing session tokens
 * - secure: true in production ensures cookies only sent over HTTPS
 * - CORS origin restrictions limit which domains can make credentialed requests
 *
 * Note: For complete CSRF protection on state-changing requests (POST/PUT/PATCH/DELETE),
 * consider implementing CSRF tokens with @fastify/csrf-protection in the future.
 */
const BASE_COOKIE_OPTIONS = (env: ApiEnv, maxAgeSeconds?: number) => ({
	path: "/",
	httpOnly: true,
	sameSite: "lax" as const,
	secure: env.NODE_ENV === "production",
	maxAge: maxAgeSeconds ?? env.SESSION_TTL_HOURS * 60 * 60,
	domain: undefined as string | undefined,
});

const REMEMBER_ME_TTL_DAYS = 30;

const generateSessionToken = () => randomBytes(32).toString("base64url");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class SessionService {
	constructor(
		private readonly prisma: PrismaClient,
		private readonly env: ApiEnv,
	) {}

	async createSession(userId: string, rememberMe: boolean = false) {
		const token = generateSessionToken();
		const hashedToken = hashToken(token);

		const ttlMs = rememberMe
			? REMEMBER_ME_TTL_DAYS * 24 * 60 * 60 * 1000
			: this.env.SESSION_TTL_HOURS * 60 * 60 * 1000;

		const expiresAt = new Date(Date.now() + ttlMs);

		await this.prisma.session.create({
			data: {
				id: hashedToken,
				userId,
				expiresAt,
			},
		});

		return { token, expiresAt };
	}

	async invalidateSession(token: string) {
		const hashedToken = hashToken(token);
		await this.prisma.session
			.delete({
				where: { id: hashedToken },
			})
			.catch(() => undefined);
	}

	async validateRequest(request: FastifyRequest) {
		const rawCookie = request.cookies?.[this.env.SESSION_COOKIE_NAME];
		if (!rawCookie) {
			return null;
		}

		const unsigned = request.unsignCookie(rawCookie);
		if (!unsigned.valid || !unsigned.value) {
			return null;
		}

		const hashedToken = hashToken(unsigned.value);
		const record = await this.prisma.session.findUnique({
			where: { id: hashedToken },
			include: {
				user: {
					select: {
						id: true,
						email: true,
						username: true,
						role: true,
						mustChangePassword: true,
						createdAt: true,
						updatedAt: true,
					},
				},
			},
		});

		if (!record) {
			return null;
		}

		if (record.expiresAt.getTime() <= Date.now()) {
			await this.prisma.session.delete({ where: { id: hashedToken } }).catch(() => undefined);
			return null;
		}

		return { session: record, token: unsigned.value };
	}

	attachCookie(reply: FastifyReply, token: string, rememberMe: boolean = false) {
		const maxAgeSeconds = rememberMe
			? REMEMBER_ME_TTL_DAYS * 24 * 60 * 60
			: this.env.SESSION_TTL_HOURS * 60 * 60;

		const options = BASE_COOKIE_OPTIONS(this.env, maxAgeSeconds);
		reply.setCookie(this.env.SESSION_COOKIE_NAME, token, {
			...options,
			signed: true,
		});
	}

	clearCookie(reply: FastifyReply) {
		reply.clearCookie(this.env.SESSION_COOKIE_NAME, BASE_COOKIE_OPTIONS(this.env));
	}
}
