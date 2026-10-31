/**
 * TRaSH Sync Scheduler Plugin
 *
 * Fastify plugin that initializes and manages the TRaSH scheduled sync system.
 * Executes syncs based on TrashSyncSchedule rows where nextRunAt <= now.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
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
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.trashSync,
				"TRaSH sync",
				async () => {
					app.log.info("Initializing TRaSH sync scheduler");

					const scheduler = new TrashSyncScheduler(
						app.prisma,
						app.log,
						app.deploymentExecutor,
						app.arrClientFactory,
						(payload, options) => app.notificationService.notify(payload, options),
						{
							trackTick: (fn) =>
								app.notificationService.runProducer(() =>
									app.schedulerRegistry.track(JOB_ID.trashSync, fn),
								),
						},
					);

					app.decorate("trashSyncScheduler", scheduler);
					scheduler.start();
					app.log.info("TRaSH sync scheduler started successfully");
				},
			);
		});

		app.addHook("preClose", async () => {
			app.trashSyncScheduler?.closeAdmission();
		});

		app.addHook("onClose", async () => {
			if (app.trashSyncScheduler) {
				app.log.info("Stopping TRaSH sync scheduler");
				await app.trashSyncScheduler.shutdown();
			}
		});
	},
	{
		name: "trash-sync-scheduler",
		dependencies: ["prisma", "deployment-executor", "scheduler-registry"],
		decorators: { fastify: ["notificationService"] },
	},
);

export default trashSyncSchedulerPlugin;
