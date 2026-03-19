/**
 * Seerr Cache Plugin
 *
 * Registers an in-memory TTL cache for slowly-changing Seerr data (genres, issue counts).
 */

import fp from "fastify-plugin";
import { SeerrCache } from "../lib/seerr/seerr-cache.js";

declare module "fastify" {
	interface FastifyInstance {
		seerrCache: SeerrCache;
	}
}

const seerrCachePlugin = fp(
	async (app) => {
		const cache = new SeerrCache();
		app.decorate("seerrCache", cache);

		app.addHook("onClose", async () => {
			cache.destroy();
			app.log.info("Seerr cache destroyed");
		});
	},
	{
		name: "seerr-cache",
	},
);

export default seerrCachePlugin;
