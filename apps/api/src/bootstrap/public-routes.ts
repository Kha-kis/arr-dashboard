import type { FastifyInstance } from "fastify";

import { PUBLIC_ROUTE_GROUPS } from "../routes/route-manifest.js";

/**
 * Public routes — no authentication required.
 *
 *  - /health  → liveness + readiness probes
 *  - /auth    → password login / logout / setup
 *  - /auth    → OIDC callback + passkey registration/assertion
 *
 * Auth-related endpoints are public because they are the entry points
 * that establish a session. Session-gated behavior is enforced by the
 * scoped preHandler in `protected-routes.ts`.
 *
 * The set of public route groups is defined in
 * `routes/route-manifest.ts`. See ADR-0004 (route surface governance).
 */
export function registerPublicRoutes(app: FastifyInstance): void {
	for (const group of PUBLIC_ROUTE_GROUPS) {
		if (group.prefix !== undefined) {
			app.register(group.register, { prefix: group.prefix });
		} else {
			app.register(group.register);
		}
	}
}
