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
import { registerCacheRoutes } from "./cache-routes.js";
import { registerRecentlyAddedRoutes } from "./recently-added-routes.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerOnDeckRoutes } from "./on-deck-routes.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerSeriesProgressRoutes } from "./series-progress-routes.js";
import { registerTranscodeAnalyticsRoutes } from "./transcode-analytics-routes.js";
import { registerBandwidthAnalyticsRoutes } from "./bandwidth-analytics-routes.js";
import { registerUserAnalyticsRoutes } from "./user-analytics-routes.js";
import { registerWatchHistoryRoutes } from "./watch-history-routes.js";
import { registerCodecAnalyticsRoutes } from "./codec-analytics-routes.js";
import { registerDeviceAnalyticsRoutes } from "./device-analytics-routes.js";
import { registerCollectionStatsRoutes } from "./collection-stats-routes.js";
import { registerUserEpisodeCompletionRoutes } from "./user-episode-completion-routes.js";
import { registerQualityScoreRoutes } from "./quality-score-routes.js";
import { registerForecastRoutes } from "./forecast-routes.js";

export async function registerPlexRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerWatchEnrichmentRoutes, { prefix: "/watch-enrichment" });
	app.register(registerSectionRoutes, { prefix: "/sections" });
	app.register(registerScanRoutes);
	app.register(registerNowPlayingRoutes, { prefix: "/now-playing" });
	app.register(registerEpisodeRoutes, { prefix: "/episodes" });
	app.register(registerCollectionRoutes);
	app.register(registerCacheRoutes);
	app.register(registerRecentlyAddedRoutes, { prefix: "/recently-added" });
	app.register(registerIdentityRoutes, { prefix: "/identity" });
	app.register(registerOnDeckRoutes, { prefix: "/on-deck" });
	app.register(registerAccountRoutes, { prefix: "/accounts" });
	app.register(registerSeriesProgressRoutes, { prefix: "/series-progress" });
	app.register(registerTranscodeAnalyticsRoutes, { prefix: "/analytics/transcode" });
	app.register(registerBandwidthAnalyticsRoutes, { prefix: "/analytics/bandwidth" });
	app.register(registerUserAnalyticsRoutes, { prefix: "/analytics/users" });
	app.register(registerWatchHistoryRoutes, { prefix: "/analytics/history" });
	app.register(registerCodecAnalyticsRoutes, { prefix: "/analytics/codec" });
	app.register(registerDeviceAnalyticsRoutes, { prefix: "/analytics/devices" });
	app.register(registerCollectionStatsRoutes, { prefix: "/analytics/collections" });
	app.register(registerUserEpisodeCompletionRoutes, { prefix: "/analytics/episode-completion" });
	app.register(registerQualityScoreRoutes, { prefix: "/analytics/quality-score" });
	app.register(registerForecastRoutes, { prefix: "/analytics/forecast" });
}
