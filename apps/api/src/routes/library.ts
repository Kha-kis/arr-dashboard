import type { FastifyPluginCallback } from "fastify";
import { registerFetchRoutes } from "./library/fetch-routes";
import { registerMonitorRoutes } from "./library/monitor-routes";
import { registerSearchRoutes } from "./library/search-routes";

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
