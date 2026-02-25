import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiEnv } from "../../config/env.js";
import type { PrismaClient } from "../../lib/prisma.js";

/**
 * Base cookie options for session management.
 * CSRF Protection Strategy:
 * - sameSite: "lax" provides CSRF protection for most scenarios when combined with CORS
 * - httpOnly: true prevents XSS attacks from stealing session tokens
 * - secure: auto-enabled when TRUST_PROXY is set (behind HTTPS-terminating reverse proxy)
 * - CORS origin restrictions limit which domains can make credentialed requests
 *
 * Cookie `secure` flag behavior:
 * - COOKIE_SECURE=true  → always send cookies over HTTPS only
 * - COOKIE_SECURE=false → always allow HTTP (explicit opt-out)
 * - (not set) + TRUST_PROXY=true → secure=true (proxy implies HTTPS termination)
 * - (not set) + TRUST_PROXY=false → secure=false (direct access, likely LAN/dev)
 */
const BASE_COOKIE_OPTIONS = (env: ApiEnv, maxAgeSeconds?: number) => ({
	path: "/",
	httpOnly: true,
	sameSite: "lax" as const,
	secure: env.COOKIE_SECURE ?? env.TRUST_PROXY,
	maxAge: maxAgeSeconds ?? env.SESSION_TTL_HOURS * 60 * 60,
	domain: undefined as string | undefined,
});

const REMEMBER_ME_TTL_DAYS = 30;

const generateSessionToken = () => randomBytes(32).toString("base64url");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Options for session creation including device/location metadata
 */
export interface SessionMetadata {
	userAgent?: string;
	ipAddress?: string;
}

export class SessionService {
	constructor(
		private readonly prisma: PrismaClient,
		private readonly env: ApiEnv,
	) {}

	/**
	 * Create a new session with optional metadata
	 */
	async createSession(userId: string, rememberMe = false, metadata?: SessionMetadata) {
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
				userAgent: metadata?.userAgent,
				ipAddress: metadata?.ipAddress,
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
			.catch(() => {
				// Best-effort: session may already be deleted or DB temporarily unavailable.
				// The cookie is still cleared client-side, and the session expires via TTL.
			});
	}

	async invalidateAllUserSessions(userId: string, exceptToken?: string) {
		if (exceptToken) {
			// Invalidate all sessions except the current one
			const hashedExceptToken = hashToken(exceptToken);
			await this.prisma.session.deleteMany({
				where: {
					userId,
					id: { not: hashedExceptToken },
				},
			});
		} else {
			// Invalidate ALL sessions for this user
			await this.prisma.session.deleteMany({
				where: { userId },
			});
		}
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
						username: true,
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
			// Best-effort cleanup — expired session is already rejected regardless
			await this.prisma.session.delete({ where: { id: hashedToken } }).catch(() => {});
			return null;
		}

		// Update lastAccessedAt in the background (non-blocking, non-critical metadata)
		this.prisma.session
			.update({
				where: { id: hashedToken },
				data: { lastAccessedAt: new Date() },
			})
			.catch(() => {});

		return { session: record, token: unsigned.value };
	}

	/**
	 * Revoke a specific session by its hashed ID
	 * Used when user wants to sign out a specific device
	 */
	async revokeSessionById(sessionId: string, userId: string): Promise<boolean> {
		// Verify the session belongs to the user before deleting
		const session = await this.prisma.session.findFirst({
			where: { id: sessionId, userId },
		});

		if (!session) {
			return false;
		}

		await this.prisma.session.delete({ where: { id: sessionId } });
		return true;
	}

	attachCookie(reply: FastifyReply, token: string, rememberMe = false) {
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

	/**
	 * Clean up all expired sessions from the database
	 * Returns the number of sessions deleted
	 */
	async cleanupExpiredSessions(): Promise<number> {
		const result = await this.prisma.session.deleteMany({
			where: {
				expiresAt: {
					lt: new Date(),
				},
			},
		});
		return result.count;
	}

	/**
	 * Get count of active and expired sessions (for diagnostics)
	 */
	async getSessionStats(): Promise<{ total: number; expired: number; active: number }> {
		const now = new Date();
		const [total, expired] = await Promise.all([
			this.prisma.session.count(),
			this.prisma.session.count({
				where: { expiresAt: { lt: now } },
			}),
		]);
		return {
			total,
			expired,
			active: total - expired,
		};
	}
}
