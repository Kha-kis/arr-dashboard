/**
 * Jellyfin Routes Index
 *
 * Aggregates all Jellyfin route modules under /api/jellyfin.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerSectionRoutes } from "./section-routes.js";
import { registerWatchEnrichmentRoutes } from "./watch-enrichment-routes.js";
import { registerOnDeckRoutes } from "./on-deck-routes.js";
import { registerRecentlyAddedRoutes } from "./recently-added-routes.js";
import { registerEpisodeRoutes } from "./episode-routes.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerCacheRoutes } from "./cache-routes.js";
import { registerScanRoutes } from "./scan-routes.js";
import { registerImageProxyRoutes } from "./image-proxy-routes.js";
import { registerNowPlayingRoutes } from "./now-playing-routes.js";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { registerSeriesProgressRoutes } from "./series-progress-routes.js";

export async function registerJellyfinRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerIdentityRoutes, { prefix: "/identity" });
	app.register(registerSectionRoutes, { prefix: "/sections" });
	app.register(registerWatchEnrichmentRoutes, { prefix: "/watch-enrichment" });
	app.register(registerOnDeckRoutes, { prefix: "/on-deck" });
	app.register(registerRecentlyAddedRoutes, { prefix: "/recently-added" });
	app.register(registerEpisodeRoutes, { prefix: "/episodes" });
	app.register(registerAccountRoutes, { prefix: "/accounts" });
	app.register(registerCacheRoutes);
	app.register(registerScanRoutes);
	app.register(registerNowPlayingRoutes, { prefix: "/now-playing" });
	app.register(registerImageProxyRoutes, { prefix: "/thumb" });
	app.register(registerAnalyticsRoutes, { prefix: "/analytics" });
	app.register(registerSeriesProgressRoutes, { prefix: "/series-progress" });
}
