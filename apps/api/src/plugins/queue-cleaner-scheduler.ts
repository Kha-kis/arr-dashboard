import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { getQueueCleanerScheduler } from "../lib/queue-cleaner/scheduler.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
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
		let initializedScheduler: ReturnType<typeof getQueueCleanerScheduler> | null = null;

		app.addHook("onReady", async () => {
			try {
				app.log.info("Initializing queue cleaner scheduler");

				// Initialize the manual import logger for auto-import operations
				setManualImportLogger({
					warn: (msg, ...args) => app.log.warn({ ...(args[0] as object) }, msg),
					debug: (msg, ...args) => app.log.debug({ ...(args[0] as object) }, msg),
				});

				const scheduler = getQueueCleanerScheduler();
				const initialization = scheduler.initialize(app);
				initializedScheduler = scheduler;
				// Join required local recovery before bootstrap opens ordinary admission.
				await initialization;
				scheduler.setTrackTick((fn) => app.schedulerRegistry.track(JOB_ID.queueCleaner, fn));
				// Retain result handoff before lookup, for timer and manual entry points.
				scheduler.setTrackClean((fn) => app.notificationService.runProducer(fn));

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
				app.log.error(
					{ err: error },
					"Failed to initialize queue cleaner scheduler - feature disabled",
				);
				// Store error for user visibility in 503 responses
				app.decorate("queueCleanerInitError", errorMsg);
				// Reflect the disabled state on the operator surface.
				app.schedulerRegistry.markDisabled(JOB_ID.queueCleaner, errorMsg);
				// queueCleanerEnabled remains false - routes will return 503
			}
		});

		app.addHook("preClose", async () => {
			// Begin draining now; do not serialize admission closure behind a sibling drain.
			void initializedScheduler?.shutdown();
		});

		app.addHook("onClose", async () => {
			if (!initializedScheduler) return;
			app.log.info("Draining queue cleaner scheduler");
			await initializedScheduler.shutdown();
		});
	},
	{
		name: "queue-cleaner-scheduler",
		dependencies: ["prisma", "scheduler-registry", "notification-service"],
	},
);

export default queueCleanerSchedulerPlugin;
