import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

declare module "fastify" {
	interface FastifyInstance {
		/** Whether the hunting feature initialized successfully */
		huntingSchedulerEnabled: boolean;
		/** Error message if hunting scheduler failed to initialize (for user diagnostics) */
		huntingSchedulerInitError?: string;
	}
}

const huntingSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Pre-decorate with disabled state (will be updated on successful init)
		app.decorate("huntingSchedulerEnabled", false);

		app.addHook("onReady", async () => {
			try {
				app.log.info("Initializing hunting scheduler");

				const scheduler = getHuntingScheduler();
				scheduler.initialize(app);

				// Check if any instances have hunting enabled
				const enabledCount = await app.prisma.huntConfig.count({
					where: {
						OR: [{ huntMissingEnabled: true }, { huntUpgradesEnabled: true }],
					},
				});

				if (enabledCount > 0) {
					scheduler.start(app);
					app.log.info(
						`Hunting scheduler started (${enabledCount} instance(s) with hunting enabled)`,
					);
				} else {
					app.log.info(
						"Hunting scheduler initialized but not started (no instances with hunting enabled)",
					);
				}

				// Mark feature as enabled only after successful initialization
				app.huntingSchedulerEnabled = true;
			} catch (error) {
				const errorMsg = getErrorMessage(error, "Unknown initialization error");
				app.log.error({ err: error }, "Failed to initialize hunting scheduler - feature disabled");
				// Store error for user visibility in 503 responses
				app.decorate("huntingSchedulerInitError", errorMsg);
				// huntingSchedulerEnabled remains false - routes will return 503
			}
		});

		app.addHook("onClose", async () => {
			if (!app.huntingSchedulerEnabled) return;
			const scheduler = getHuntingScheduler();
			if (scheduler.isRunning()) {
				app.log.info("Stopping hunting scheduler");
				scheduler.stop();
			}
		});
	},
	{
		name: "hunting-scheduler",
		dependencies: ["prisma"],
	},
);

export default huntingSchedulerPlugin;
