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
import registerInstanceQualityProfileRoutes from "./instance-quality-profile-routes.js";
import { registerUpdateRoutes } from "./update-routes.js";
import { deploymentRoutes } from "./deployment-routes.js";
import { deploymentHistoryRoutes } from "./deployment-history-routes.js";
import bulkScoreRoutes from "./bulk-score-routes.js";
import profileCloneRoutes from "./profile-clone-routes.js";
import templateSharingRoutes from "./template-sharing-routes.js";
import { registerCustomFormatRoutes } from "./custom-format-routes.js";

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

	// Register update routes under /updates
	app.register(registerUpdateRoutes, { prefix: "/updates" });

	// Register deployment routes under /deployment
	app.register(deploymentRoutes, { prefix: "/deployment" });

	// Register deployment history routes under /deployment
	app.register(deploymentHistoryRoutes, { prefix: "/deployment" });

	// Register bulk score management routes under /bulk-scores
	app.register(bulkScoreRoutes, { prefix: "/bulk-scores" });

	// Register instance quality profile routes under /instances
	app.register(registerInstanceQualityProfileRoutes, { prefix: "/instances" });

	// Register profile clone routes under /profile-clone
	app.register(profileCloneRoutes, { prefix: "/profile-clone" });

	// Register template sharing routes under /sharing
	app.register(templateSharingRoutes, { prefix: "/sharing" });

	// Register custom format routes under /custom-formats
	app.register(registerCustomFormatRoutes, { prefix: "/custom-formats" });

	// Future routes will be added here:
	// app.register(registerTrashBackupRoutes, { prefix: "/backups" });
}
