import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import fp from "fastify-plugin";
import {
	classifyRuntimeReadRoute,
	withRuntimeReadSource,
} from "../lib/backup/restore-runtime-read-diagnostics.js";
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
	app.addHook("onRoute", (routeOptions) => {
		const handler = routeOptions.handler;
		const source = classifyRuntimeReadRoute(routeOptions.url);
		routeOptions.handler = function trackedHttpHandler(request, reply) {
			return withRuntimeReadSource(source, () => {
				// Server-declared purposes remain HTTP-tracked without an implicit
				// database ticket. Restore admits preparation/auth explicitly, then
				// drains ordinary tickets before exclusive publication. Client input
				// cannot select this branch or grant ordinary native SQL authority.
				if (
					routeOptions.config?.runtimeLiveness === true ||
					routeOptions.config?.runtimeRestoreController === true
				) {
					return lifecycleService.runHttpHandler(async () => handler.call(this, request, reply));
				}
				return lifecycleService.runHttpHandler(() =>
					app.restoreRuntime.runOperation(async () => handler.call(this, request, reply)),
				);
			});
		} as RouteHandlerMethod;
	});
	app.addHook("preClose", async () => {
		lifecycleService.closeHttpHandlerAdmission();
	});
	app.addHook("onClose", async () => {
		await lifecycleService.drainHttpHandlers();
	});

	app.log.info("Lifecycle service initialized");
};

export default fp(lifecyclePlugin, {
	name: "lifecycle",
});

// Type augmentation for TypeScript
declare module "fastify" {
	interface FastifyContextConfig {
		/** Protected, lifecycle-tracked Restore entry point; not database/auth authority. */
		runtimeRestoreController?: boolean;
	}
	interface FastifyInstance {
		lifecycle: LifecycleService;
	}
}
