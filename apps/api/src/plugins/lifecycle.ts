import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { LifecycleService } from "../lib/lifecycle/lifecycle-service.js";

/**
 * Lifecycle Plugin
 *
 * Registers the LifecycleService as a Fastify decorator
 * for use throughout the application.
 */
const lifecyclePlugin: FastifyPluginAsync = async (app) => {
	const lifecycleService = new LifecycleService(app);

	app.decorate("lifecycle", lifecycleService);

	app.log.info("Lifecycle service initialized");
};

export default fp(lifecyclePlugin, {
	name: "lifecycle",
});

// Type augmentation for TypeScript
declare module "fastify" {
	interface FastifyInstance {
		lifecycle: LifecycleService;
	}
}
