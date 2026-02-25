import type { FastifyRequest } from "fastify";
import type { SessionMetadata } from "./session.js";

/**
 * Extract client IP address from request.
 *
 * When TRUST_PROXY is enabled, Fastify's `request.ip` already resolves the
 * real client IP from X-Forwarded-For using its built-in trustProxy logic,
 * which only trusts headers from the configured proxy hop(s).
 *
 * When TRUST_PROXY is disabled, we fall back to the direct connection IP.
 * We intentionally do NOT manually read X-Forwarded-For in this case because
 * any client can forge that header — trusting it without proxy validation
 * allows IP spoofing in session metadata and logs.
 */
export function getClientIp(request: FastifyRequest): string {
	return request.ip;
}

/**
 * Extract session metadata from request for storing with the session.
 * Captures user agent and IP address at login time.
 */
export function getSessionMetadata(request: FastifyRequest): SessionMetadata {
	return {
		userAgent: request.headers["user-agent"],
		ipAddress: getClientIp(request),
	};
}
