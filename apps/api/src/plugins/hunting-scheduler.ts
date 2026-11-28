import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
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
		let initializedScheduler: ReturnType<typeof getHuntingScheduler> | null = null;

		app.addHook("onReady", async () => {
			try {
				app.log.info("Initializing hunting scheduler");

				const scheduler = getHuntingScheduler();
				await scheduler.initialize(app);
				initializedScheduler = scheduler;
				scheduler.setTrackTick((fn) => app.schedulerRegistry.track(JOB_ID.hunting, fn));
				// Retain result handoff before the first lookup, for timer and manual entry points.
				scheduler.setTrackHunt((fn) => app.notificationService.runProducer(fn));

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
				// Reflect the disabled state on the operator surface.
				app.schedulerRegistry.markDisabled(JOB_ID.hunting, errorMsg);
				// huntingSchedulerEnabled remains false - routes will return 503
			}
		});

		app.addHook("preClose", async () => {
			// Close admission without delaying sibling schedulers' preClose hooks.
			// The onClose hook awaits settlement before dependent resources close.
			void initializedScheduler?.shutdown();
		});

		app.addHook("onClose", async () => {
			if (!initializedScheduler) return;
			app.log.info("Draining hunting scheduler");
			await initializedScheduler.shutdown();
		});
	},
	{
		name: "hunting-scheduler",
		dependencies: ["prisma", "scheduler-registry", "notification-service"],
	},
);

export default huntingSchedulerPlugin;
