import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const huntingSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
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
					app.log.info("Hunting scheduler initialized but not started (no instances with hunting enabled)");
				}
			} catch (error) {
				const errorMsg = getErrorMessage(error, "Unknown initialization error");
				app.log.error(
					{ err: error },
					`Failed to initialize hunting scheduler: ${errorMsg}`,
				);
			}
		});

		app.addHook("onClose", async () => {
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
