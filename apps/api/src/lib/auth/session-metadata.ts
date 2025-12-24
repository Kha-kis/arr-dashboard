import type { FastifyRequest } from "fastify";
import type { SessionMetadata } from "./session.js";

/**
 * Extract client IP address from request
 * Respects X-Forwarded-For header for proxied requests (common in Docker/reverse proxy setups)
 *
 * Security note: X-Forwarded-For can be spoofed, but for our use case (session identification),
 * showing the user what IP was used at login time is sufficient. The first IP in the chain
 * is generally the most trustworthy as proxies append IPs rather than prepend.
 */
export function getClientIp(request: FastifyRequest): string {
	// Check X-Forwarded-For first (for reverse proxy setups)
	const forwardedFor = request.headers["x-forwarded-for"];
	if (forwardedFor) {
		// X-Forwarded-For can contain multiple IPs, take the first one (original client)
		const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
		const firstIp = ips?.split(",")[0]?.trim();
		if (firstIp) return firstIp;
	}

	// Check X-Real-IP (used by some proxies like nginx)
	const realIp = request.headers["x-real-ip"];
	if (realIp) {
		const ip = Array.isArray(realIp) ? realIp[0] : realIp;
		if (ip) return ip;
	}

	// Fallback to direct connection IP
	return request.ip;
}

/**
 * Extract session metadata from request for storing with the session
 * Captures user agent and IP address at login time
 */
export function getSessionMetadata(request: FastifyRequest): SessionMetadata {
	return {
		userAgent: request.headers["user-agent"],
		ipAddress: getClientIp(request),
	};
}
