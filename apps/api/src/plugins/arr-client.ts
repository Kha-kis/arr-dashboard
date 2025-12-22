/**
 * ARR SDK Client Factory Plugin
 *
 * Registers the ArrClientFactory on the Fastify instance for creating
 * type-safe SDK clients for Sonarr, Radarr, and Prowlarr.
 */

import fp from "fastify-plugin";
import { ArrClientFactory } from "../lib/arr/client-factory.js";

export const arrClientPlugin = fp(async (app) => {
	// Create and decorate the factory (requires encryptor from security plugin)
	const factory = new ArrClientFactory(app.encryptor);
	app.decorate("arrClientFactory", factory);
}, {
	name: "arr-client",
	dependencies: ["prisma", "security"], // Ensure encryptor is available
});

export default arrClientPlugin;
