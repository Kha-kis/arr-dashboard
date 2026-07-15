import type { SetupDiscoveryResponse } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { discoverMediaServers } from "../lib/setup-discovery/udp-discovery.js";

let activeDiscovery: Promise<SetupDiscoveryResponse> | null = null;
const DISCOVERY_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };

export const registerSetupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.post("/setup/discovery", { config: { rateLimit: DISCOVERY_RATE_LIMIT } }, async (request) => {
		if (!activeDiscovery) {
			activeDiscovery = discoverMediaServers({ log: request.log }).finally(() => {
				activeDiscovery = null;
			});
		}
		return activeDiscovery;
	});

	done();
};
