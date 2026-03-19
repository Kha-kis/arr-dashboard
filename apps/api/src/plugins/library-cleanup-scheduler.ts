import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { CleanupScheduler } from "../lib/library-cleanup/cleanup-scheduler.js";

declare module "fastify" {
	interface FastifyInstance {
		cleanupScheduler: CleanupScheduler;
	}
}

const libraryCleanupSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			app.log.info("Initializing library cleanup scheduler");

			const scheduler = new CleanupScheduler(app.prisma, app.arrClientFactory, app.log, (payload) =>
				app.notificationService.notify(payload),
			);
			app.decorate("cleanupScheduler", scheduler);

			scheduler.start();
			app.log.info("Library cleanup scheduler started successfully");
		});

		app.addHook("onClose", async () => {
			if (app.cleanupScheduler) {
				app.log.info("Stopping library cleanup scheduler");
				app.cleanupScheduler.stop();
			}
		});
	},
	{
		name: "library-cleanup-scheduler",
		dependencies: ["prisma", "arr-client"],
	},
);

export default libraryCleanupSchedulerPlugin;
