import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { registerCacheRoutes } from "./cache-routes.js";

/** Tautulli remains an optional watch-history provider alongside primary Tracearr support. */
export async function registerTautulliRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.register(registerCacheRoutes);
}
