/**
 * TRaSH Sync Scheduler Plugin
 *
 * Fastify plugin that initializes and manages the TRaSH scheduled sync system.
 * Executes syncs based on TrashSyncSchedule rows where nextRunAt <= now.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { TrashSyncScheduler } from "../lib/trash-guides/sync-scheduler.js";

declare module "fastify" {
	interface FastifyInstance {
		trashSyncScheduler: TrashSyncScheduler;
	}
}

const trashSyncSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			app.log.info("Initializing TRaSH sync scheduler");

			const scheduler = new TrashSyncScheduler(
				app.prisma,
				app.log,
				app.deploymentExecutor,
				app.arrClientFactory,
				(payload) => app.notificationService.notify(payload),
				{ trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.trashSync, fn) },
			);

			app.decorate("trashSyncScheduler", scheduler);
			scheduler.start();
			app.log.info("TRaSH sync scheduler started successfully");
		});

		app.addHook("onClose", async () => {
			if (app.trashSyncScheduler) {
				app.log.info("Stopping TRaSH sync scheduler");
				app.trashSyncScheduler.stop();
			}
		});
	},
	{
		name: "trash-sync-scheduler",
		dependencies: ["prisma", "deployment-executor", "scheduler-registry"],
	},
);

export default trashSyncSchedulerPlugin;
