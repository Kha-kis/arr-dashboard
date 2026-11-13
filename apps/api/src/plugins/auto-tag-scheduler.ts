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
		let closing = false;
		app.addHook("onReady", async () => {
			if (closing) return;
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

		app.addHook("preClose", async () => {
			closing = true;
			app.autoTagScheduler?.closeAdmission();
		});

		app.addHook("onClose", async () => {
			if (app.autoTagScheduler) {
				app.log.info("Stopping auto-tag scheduler");
				await app.autoTagScheduler.shutdown();
			}
		});
	},
	{
		name: "auto-tag-scheduler",
		dependencies: ["prisma", "arr-client", "scheduler-registry"],
	},
);

export default autoTagSchedulerPlugin;
