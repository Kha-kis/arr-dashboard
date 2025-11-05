/**
 * TRaSH Guides Routes Index
 *
 * Aggregates all TRaSH Guides route modules.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";
import { registerTrashCacheRoutes } from "./cache-routes.js";
import { registerTemplateRoutes } from "./template-routes.js";
import { registerSyncRoutes } from "./sync-routes.js";

export const registerTrashGuidesRoutes = fp(
	async (app: FastifyInstance, opts: FastifyPluginOptions) => {
		// Register cache routes under /cache
		app.register(registerTrashCacheRoutes, { prefix: "/cache" });

		// Register template routes under /templates
		app.register(registerTemplateRoutes, { prefix: "/templates" });

		// Register sync routes under /sync
		app.register(registerSyncRoutes, { prefix: "/sync" });

		// Future routes will be added here:
		// app.register(registerTrashHistoryRoutes, { prefix: "/history" });
		// app.register(registerTrashBackupRoutes, { prefix: "/backups" });
	},
	{
		name: "trash-guides-routes",
	},
);
