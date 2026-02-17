import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getQueueCleanerScheduler } from "../lib/queue-cleaner/scheduler.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { setManualImportLogger } from "../routes/manual-import-utils.js";

declare module "fastify" {
	interface FastifyInstance {
		queueCleanerScheduler: ReturnType<typeof getQueueCleanerScheduler>;
		/** Whether the queue cleaner feature initialized successfully */
		queueCleanerEnabled: boolean;
		/** Error message if queue cleaner failed to initialize (for user diagnostics) */
		queueCleanerInitError?: string;
	}
}

const queueCleanerSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Pre-decorate with disabled state (will be updated on successful init)
		app.decorate("queueCleanerEnabled", false);

		app.addHook("onReady", async () => {
			try {
				app.log.info("Initializing queue cleaner scheduler");

				// Initialize the manual import logger for auto-import operations
				setManualImportLogger({
					warn: (msg, ...args) => app.log.warn({ ...(args[0] as object) }, msg),
					debug: (msg, ...args) => app.log.debug({ ...(args[0] as object) }, msg),
				});

				const scheduler = getQueueCleanerScheduler();
				scheduler.initialize(app);

				// Use hasDecorator check to prevent potential double-decoration errors
				if (!app.hasDecorator("queueCleanerScheduler")) {
					app.decorate("queueCleanerScheduler", scheduler);
				}

				scheduler.start(app);

				// Mark feature as enabled only after successful initialization
				app.queueCleanerEnabled = true;
				app.log.info("Queue cleaner scheduler started successfully");
			} catch (error) {
				const errorMsg = getErrorMessage(error, "Unknown initialization error");
				app.log.error({ err: error }, "Failed to initialize queue cleaner scheduler - feature disabled");
				// Store error for user visibility in 503 responses
				app.decorate("queueCleanerInitError", errorMsg);
				// queueCleanerEnabled remains false - routes will return 503
			}
		});

		app.addHook("onClose", async () => {
			if (app.queueCleanerScheduler) {
				app.log.info("Stopping queue cleaner scheduler");
				app.queueCleanerScheduler.stop();
			}
		});
	},
	{
		name: "queue-cleaner-scheduler",
		dependencies: ["prisma"],
	},
);

export default queueCleanerSchedulerPlugin;
