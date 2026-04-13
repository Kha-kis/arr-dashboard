/**
 * Library Sync Scheduler Plugin
 *
 * Registers the library sync scheduler with Fastify.
 * Starts background polling to keep library cache synchronized.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getLibrarySyncScheduler } from "../lib/library-sync/index.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		librarySyncScheduler: ReturnType<typeof getLibrarySyncScheduler>;
	}
}

const librarySyncSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Use onReady hook to ensure Prisma and arrClientFactory are available
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.librarySync,
				"library sync",
				async () => {
					app.log.info("Initializing library sync scheduler");

					const scheduler = getLibrarySyncScheduler();
					scheduler.setTrackTick((fn) => app.schedulerRegistry.track(JOB_ID.librarySync, fn));
					app.decorate("librarySyncScheduler", scheduler);

					// Start the scheduler
					scheduler.start(app);
					app.log.info("Library sync scheduler started successfully");
				},
			);
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
		dependencies: ["prisma", "arr-client", "scheduler-registry"],
	},
);

export default librarySyncSchedulerPlugin;
