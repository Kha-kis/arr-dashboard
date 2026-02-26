import type { FastifyRequest } from "fastify";

export interface SessionMetadata {
	ipAddress: string | null;
	userAgent: string | null;
}

/**
 * Extract session metadata from an incoming request.
 *
 * `request.ip` already respects Fastify's `trustProxy` setting:
 *   - When trustProxy is enabled, Fastify reads X-Forwarded-For and returns the client IP.
 *   - When trustProxy is disabled, Fastify returns the direct socket address.
 * So we never need to manually inspect X-Forwarded-For.
 */
export function extractSessionMetadata(request: FastifyRequest): SessionMetadata {
	return {
		ipAddress: request.ip ?? null,
		userAgent: request.headers["user-agent"] ?? null,
	};
}
