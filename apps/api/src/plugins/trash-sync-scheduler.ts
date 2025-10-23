import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { TrashSyncScheduler } from "../lib/arr-sync/trash/trash-sync-scheduler.js";

declare module "fastify" {
	interface FastifyInstance {
		trashSyncScheduler: TrashSyncScheduler;
	}
}

const trashSyncSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Use onReady hook to ensure config and Prisma are fully initialized before creating scheduler
		app.addHook("onReady", async () => {
			app.log.info("Initializing TRaSH sync scheduler");

			// Create and register TRaSH sync scheduler (Prisma is guaranteed to be ready)
			const scheduler = new TrashSyncScheduler(app.prisma, app.log, app);
			app.decorate("trashSyncScheduler", scheduler);

			// Start scheduler
			scheduler.start();
			app.log.info("TRaSH sync scheduler started successfully");
		});

		// Stop scheduler on server close
		app.addHook("onClose", async () => {
			if (app.trashSyncScheduler) {
				app.log.info("Stopping TRaSH sync scheduler");
				app.trashSyncScheduler.stop();
			}
		});
	},
	{
		name: "trash-sync-scheduler",
		dependencies: ["prisma"],
	}
);

export default trashSyncSchedulerPlugin;
