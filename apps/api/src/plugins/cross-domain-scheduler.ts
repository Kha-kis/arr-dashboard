import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { CrossDomainScheduler } from "../lib/automation/cross-domain-scheduler.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		crossDomainScheduler: CrossDomainScheduler;
	}
}

export default fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.crossDomainAutomation,
				"cross-domain-automation",
				async () => {
					const scheduler = new CrossDomainScheduler(
						app.prisma,
						app.arrClientFactory,
						app.encryptor,
						app.notificationService,
						app.log,
						{ trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.crossDomainAutomation, fn) },
					);
					app.decorate("crossDomainScheduler", scheduler);
					scheduler.start();
				},
			);
		});
		app.addHook("onClose", async () => app.crossDomainScheduler?.stop());
	},
	{
		name: "cross-domain-scheduler",
		dependencies: ["prisma", "arr-client", "notification-service", "scheduler-registry"],
	},
);
