import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { KNOWN_JOBS } from "../lib/scheduler-registry/job-definitions.js";
import { SchedulerRegistry } from "../lib/scheduler-registry/scheduler-registry.js";

declare module "fastify" {
	interface FastifyInstance {
		/**
		 * Process-local catalog of background schedulers + their runtime status.
		 * Individual scheduler plugins call `app.schedulerRegistry.register(...)`
		 * in their `onReady` hook and may wrap ticks with `registry.track(...)`.
		 *
		 * See lib/scheduler-registry/scheduler-registry.ts for the full model.
		 */
		schedulerRegistry: SchedulerRegistry;
	}
}

/**
 * Registers the singleton SchedulerRegistry decoration.
 *
 * This plugin must be registered before any scheduler plugin so those plugins
 * can call `app.schedulerRegistry.register(...)` during their own `onReady`
 * hooks. The registry itself has no initialization — creation is synchronous.
 */
const schedulerRegistryPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		const registry = new SchedulerRegistry();
		// Pre-register every known job so the /api/system/jobs surface always
		// reflects the full catalog — even jobs whose plugin has not yet adopted
		// `registry.track()` show up as idle with no execution data.
		for (const definition of KNOWN_JOBS) {
			registry.register(definition);
		}
		app.decorate("schedulerRegistry", registry);
	},
	{
		name: "scheduler-registry",
	},
);

export default schedulerRegistryPlugin;
