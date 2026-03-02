/**
 * Plex Routes Index
 *
 * Aggregates all Plex route modules under /api/plex.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerWatchEnrichmentRoutes } from "./watch-enrichment-routes.js";
import { registerSectionRoutes } from "./section-routes.js";
import { registerScanRoutes } from "./scan-routes.js";
import { registerNowPlayingRoutes } from "./now-playing-routes.js";
import { registerEpisodeRoutes } from "./episode-routes.js";
import { registerCollectionRoutes } from "./collection-routes.js";

export async function registerPlexRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerWatchEnrichmentRoutes, { prefix: "/watch-enrichment" });
	app.register(registerSectionRoutes, { prefix: "/sections" });
	app.register(registerScanRoutes);
	app.register(registerNowPlayingRoutes, { prefix: "/now-playing" });
	app.register(registerEpisodeRoutes, { prefix: "/episodes" });
	app.register(registerCollectionRoutes);
}
