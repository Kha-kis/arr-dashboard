import type { FastifyPluginCallback } from "fastify";
import { registerAddRoutes } from "./discover/add-routes.js";
import { registerOptionsRoutes } from "./discover/options-routes.js";
import { registerSearchRoutes } from "./discover/search-routes.js";

/**
 * Discover routes - search and add movies/series
 * Registers all discover-related route handlers
 */
const discoverRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.register(registerSearchRoutes);
	app.register(registerOptionsRoutes);
	app.register(registerAddRoutes);

	done();
};

export const registerDiscoverRoutes = discoverRoute;
