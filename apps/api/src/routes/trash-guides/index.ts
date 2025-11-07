/**
 * TRaSH Guides Routes Index
 *
 * Aggregates all TRaSH Guides route modules.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerTrashCacheRoutes } from "./cache-routes.js";
import { registerTemplateRoutes } from "./template-routes.js";
import { registerSyncRoutes } from "./sync-routes.js";
import { registerQualityProfileRoutes } from "./quality-profile-routes.js";

export async function registerTrashGuidesRoutes(
	app: FastifyInstance,
	opts: FastifyPluginOptions,
) {
	// Register cache routes under /cache
	app.register(registerTrashCacheRoutes, { prefix: "/cache" });

	// Register template routes under /templates
	app.register(registerTemplateRoutes, { prefix: "/templates" });

	// Register sync routes under /sync
	app.register(registerSyncRoutes, { prefix: "/sync" });

	// Register quality profile routes under /quality-profiles
	app.register(registerQualityProfileRoutes, { prefix: "/quality-profiles" });

	// Future routes will be added here:
	// app.register(registerTrashHistoryRoutes, { prefix: "/history" });
	// app.register(registerTrashBackupRoutes, { prefix: "/backups" });
}
