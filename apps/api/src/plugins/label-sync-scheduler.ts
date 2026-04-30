import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { LabelSyncScheduler } from "../lib/label-sync/label-sync-scheduler.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		labelSyncScheduler: LabelSyncScheduler;
	}
}

const labelSyncSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.labelSync,
				"label sync",
				async () => {
					app.log.info("Initializing label sync scheduler");

					const scheduler = new LabelSyncScheduler(
						app.prisma,
						app.arrClientFactory,
						app.encryptor,
						app.log,
						{ trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.labelSync, fn) },
					);
					app.decorate("labelSyncScheduler", scheduler);

					scheduler.start();
					app.log.info("Label sync scheduler started successfully");
				},
			);
		});

		app.addHook("onClose", async () => {
			if (app.labelSyncScheduler) {
				app.log.info("Stopping label sync scheduler");
				app.labelSyncScheduler.stop();
			}
		});
	},
	{
		name: "label-sync-scheduler",
		dependencies: ["prisma", "arr-client", "scheduler-registry"],
	},
);

export default labelSyncSchedulerPlugin;
