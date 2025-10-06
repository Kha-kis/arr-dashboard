import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiEnv } from "../../config/env.js";

const BASE_COOKIE_OPTIONS = (env: ApiEnv) => ({
	path: "/",
	httpOnly: true,
	sameSite: "lax" as const,
	secure: env.NODE_ENV === "production",
	maxAge: env.SESSION_TTL_HOURS * 60 * 60,
	domain: undefined as string | undefined,
});

const generateSessionToken = () => randomBytes(32).toString("base64url");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class SessionService {
	constructor(
		private readonly prisma: PrismaClient,
		private readonly env: ApiEnv,
	) {}

	async createSession(userId: string) {
		const token = generateSessionToken();
		const hashedToken = hashToken(token);
		const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 60 * 60 * 1000);

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

	attachCookie(reply: FastifyReply, token: string) {
		const options = BASE_COOKIE_OPTIONS(this.env);
		reply.setCookie(this.env.SESSION_COOKIE_NAME, token, {
			...options,
			signed: true,
		});
	}

	clearCookie(reply: FastifyReply) {
		reply.clearCookie(this.env.SESSION_COOKIE_NAME, BASE_COOKIE_OPTIONS(this.env));
	}
}
