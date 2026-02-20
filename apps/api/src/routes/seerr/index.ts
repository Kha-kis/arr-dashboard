/**
 * Seerr Routes Index
 *
 * Aggregates all Seerr route modules under /api/seerr.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerRequestRoutes } from "./request-routes.js";
import { registerUserRoutes } from "./user-routes.js";
import { registerIssueRoutes } from "./issue-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerStatusRoutes } from "./status-routes.js";
import { registerDiscoverRoutes } from "./discover-routes.js";

export async function registerSeerrRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerRequestRoutes, { prefix: "/requests" });
	app.register(registerUserRoutes, { prefix: "/users" });
	app.register(registerIssueRoutes, { prefix: "/issues" });
	app.register(registerNotificationRoutes, { prefix: "/notifications" });
	app.register(registerStatusRoutes, { prefix: "/status" });
	app.register(registerDiscoverRoutes, { prefix: "/discover" });
}
