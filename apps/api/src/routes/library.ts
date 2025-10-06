import type { FastifyPluginCallback } from "fastify";
import { registerFetchRoutes } from "./library/fetch-routes.js";
import { registerMonitorRoutes } from "./library/monitor-routes.js";
import { registerSearchRoutes } from "./library/search-routes.js";

/**
 * Library routes plugin
 * Registers all library-related routes including fetch, monitor, and search operations
 */
const libraryRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Register all route modules
	app.register(registerFetchRoutes);
	app.register(registerMonitorRoutes);
	app.register(registerSearchRoutes);

	done();
};

export const registerLibraryRoutes = libraryRoute;
