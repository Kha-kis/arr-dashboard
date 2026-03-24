/**
 * Library Insights Digest Scheduler Plugin
 *
 * Periodically checks for cross-service insight signals and sends
 * notification summaries when actionable items are found.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { InsightsDigestScheduler } from "../lib/notifications/insights-digest.js";

declare module "fastify" {
	interface FastifyInstance {
		insightsDigestScheduler: InsightsDigestScheduler;
	}
}

const insightsDigestSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			app.log.info("Initializing insights digest scheduler");

			const scheduler = new InsightsDigestScheduler(
				app.prisma,
				app.log,
				app.arrClientFactory,
				(payload) => app.notificationService.notify(payload),
			);

			app.decorate("insightsDigestScheduler", scheduler);
			scheduler.start();
			app.log.info("Insights digest scheduler started successfully");
		});

		app.addHook("onClose", async () => {
			if (app.insightsDigestScheduler) {
				app.log.info("Stopping insights digest scheduler");
				app.insightsDigestScheduler.stop();
			}
		});
	},
	{
		name: "insights-digest-scheduler",
		dependencies: ["prisma"],
	},
);

export default insightsDigestSchedulerPlugin;
