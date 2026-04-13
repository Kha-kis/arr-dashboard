import type { FastifyInstance } from "fastify";

import { PROTECTED_ROUTE_GROUPS } from "../routes/route-manifest.js";

/**
 * Protected API routes — gated by the session preHandler registered here.
 *
 * The preHandler rejects any request without a populated `request.currentUser`.
 * The set of protected route groups (and their stability/audience tier) is
 * defined in `routes/route-manifest.ts`. Iterating that manifest is the
 * only way a route reaches this scope, so registration and governance
 * cannot drift apart.
 *
 * See ADR-0003 (protected-route auth model) and
 * ADR-0004 (route surface governance).
 */
export function registerProtectedRoutes(app: FastifyInstance): void {
	app.register(async (api) => {
		api.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});

		for (const group of PROTECTED_ROUTE_GROUPS) {
			if (group.prefix !== undefined) {
				api.register(group.register, { prefix: group.prefix });
			} else {
				api.register(group.register);
			}
		}
	});
}
