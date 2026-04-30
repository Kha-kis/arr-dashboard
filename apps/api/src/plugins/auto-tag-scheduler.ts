import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { AutoTagScheduler } from "../lib/auto-tag/auto-tag-scheduler.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		autoTagScheduler: AutoTagScheduler;
	}
}

const autoTagSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.autoTag,
				"auto-tag",
				async () => {
					app.log.info("Initializing auto-tag scheduler");

					const scheduler = new AutoTagScheduler(
						app.prisma,
						app.arrClientFactory,
						app.encryptor,
						app.log,
						{ trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.autoTag, fn) },
					);
					app.decorate("autoTagScheduler", scheduler);

					scheduler.start();
					app.log.info("Auto-tag scheduler started successfully");
				},
			);
		});

		app.addHook("onClose", async () => {
			if (app.autoTagScheduler) {
				app.log.info("Stopping auto-tag scheduler");
				app.autoTagScheduler.stop();
			}
		});
	},
	{
		name: "auto-tag-scheduler",
		dependencies: ["prisma", "arr-client", "scheduler-registry"],
	},
);

export default autoTagSchedulerPlugin;
