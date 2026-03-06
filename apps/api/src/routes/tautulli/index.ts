/**
 * Tautulli Routes Index
 *
 * Aggregates all Tautulli route modules under /api/tautulli.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerActivityRoutes } from "./activity-routes.js";
import { registerHistoryRoutes } from "./history-routes.js";
import { registerStatsRoutes } from "./stats-routes.js";
import { registerCacheRoutes } from "./cache-routes.js";

export async function registerTautulliRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerActivityRoutes, { prefix: "/activity" });
	app.register(registerHistoryRoutes, { prefix: "/history" });
	app.register(registerStatsRoutes, { prefix: "/stats" });
	app.register(registerCacheRoutes);
}
