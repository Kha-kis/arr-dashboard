/**
 * Library Insights Digest Scheduler Plugin
 *
 * Periodically checks for cross-service insight signals and sends
 * notification summaries when actionable items are found.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { InsightsDigestScheduler } from "../lib/notifications/insights-digest.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		insightsDigestScheduler: InsightsDigestScheduler;
	}
}

const insightsDigestSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.insightsDigest,
				"insights digest",
				async () => {
					app.log.info("Initializing insights digest scheduler");

					const scheduler = new InsightsDigestScheduler(
						app.prisma,
						app.log,
						app.arrClientFactory,
						app.encryptor,
						(payload, userId) => app.notificationService.notify(payload, { userId }),
						{
							trackTick: (fn) =>
								app.schedulerRegistry.track(JOB_ID.insightsDigest, () =>
									app.notificationService.runProducer(fn),
								),
						},
					);

					app.decorate("insightsDigestScheduler", scheduler);
					scheduler.start();
					app.log.info("Insights digest scheduler started successfully");
				},
			);
		});

		app.addHook("preClose", async () => {
			app.insightsDigestScheduler?.closeAdmission();
		});

		app.addHook("onClose", async () => {
			if (app.insightsDigestScheduler) {
				app.log.info("Stopping insights digest scheduler");
				await app.insightsDigestScheduler.shutdown();
			}
		});
	},
	{
		name: "insights-digest-scheduler",
		dependencies: ["prisma", "scheduler-registry", "notification-service"],
	},
);

export default insightsDigestSchedulerPlugin;
