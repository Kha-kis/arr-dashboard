import type { FastifyInstance } from "fastify";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerAuthOidcRoutes } from "../routes/auth-oidc.js";
import { registerAuthPasskeyRoutes } from "../routes/auth-passkey.js";
import { registerHealthRoutes } from "../routes/health.js";

/**
 * Public routes — no authentication required.
 *
 *  - /health  → liveness + readiness probes
 *  - /auth    → password login / logout / setup
 *  - /auth    → OIDC callback + passkey registration/assertion
 *
 * Auth-related endpoints are public because they are the entry points that
 * establish a session. Session-gated behavior is enforced by the scoped
 * preHandler registered with the protected routes.
 */
export function registerPublicRoutes(app: FastifyInstance): void {
	app.register(registerHealthRoutes, { prefix: "/health" });
	app.register(registerAuthRoutes, { prefix: "/auth" });
	app.register(registerAuthOidcRoutes, { prefix: "/auth" });
	app.register(registerAuthPasskeyRoutes, { prefix: "/auth" });
}
