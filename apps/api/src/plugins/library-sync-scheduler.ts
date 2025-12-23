/**
 * Library Sync Scheduler Plugin
 *
 * Registers the library sync scheduler with Fastify.
 * Starts background polling to keep library cache synchronized.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getLibrarySyncScheduler } from "../lib/library-sync/index.js";

declare module "fastify" {
	interface FastifyInstance {
		librarySyncScheduler: ReturnType<typeof getLibrarySyncScheduler>;
	}
}

const librarySyncSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Use onReady hook to ensure Prisma and arrClientFactory are available
		app.addHook("onReady", async () => {
			app.log.info("Initializing library sync scheduler");

			const scheduler = getLibrarySyncScheduler();
			app.decorate("librarySyncScheduler", scheduler);

			// Start the scheduler
			scheduler.start(app);
			app.log.info("Library sync scheduler started successfully");
		});

		// Stop scheduler on server close
		app.addHook("onClose", async () => {
			if (app.librarySyncScheduler) {
				app.log.info("Stopping library sync scheduler");
				app.librarySyncScheduler.stop();
			}
		});
	},
	{
		name: "library-sync-scheduler",
		dependencies: ["prisma", "arr-client"],
	},
);

export default librarySyncSchedulerPlugin;
