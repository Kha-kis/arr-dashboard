import type { FastifyPluginCallback } from "fastify";
import { registerGrabRoutes } from "./search/grab-routes";
import { registerIndexerRoutes } from "./search/indexer-routes";
import { registerQueryRoutes } from "./search/query-routes";

/**
 * Registers all search-related routes for Prowlarr functionality.
 *
 * This plugin delegates to specialized route modules:
 * - Indexer routes: CRUD operations for Prowlarr indexers
 * - Query routes: Manual search functionality
 * - Grab routes: Download/grab release functionality
 */
export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Register indexer management routes
	app.register(registerIndexerRoutes);

	// Register search query routes
	app.register(registerQueryRoutes);

	// Register grab/download routes
	app.register(registerGrabRoutes);

	done();
};
