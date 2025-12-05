/**
 * TRaSH Guides Update Scheduler Plugin
 *
 * Fastify plugin that initializes and manages the TRaSH Guides update scheduler.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createUpdateScheduler, type UpdateScheduler } from "../lib/trash-guides/update-scheduler.js";
import { createVersionTracker } from "../lib/trash-guides/version-tracker.js";
import { createCacheManager } from "../lib/trash-guides/cache-manager.js";
import { createTemplateUpdater } from "../lib/trash-guides/template-updater.js";
import { createTrashFetcher } from "../lib/trash-guides/github-fetcher.js";
import { createDeploymentExecutorService } from "../lib/trash-guides/deployment-executor.js";

declare module "fastify" {
	interface FastifyInstance {
		trashUpdateScheduler: UpdateScheduler;
	}
}

const trashUpdateSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Use onReady hook to ensure config and Prisma are fully initialized
		app.addHook("onReady", async () => {
			app.log.info("Initializing TRaSH Guides update scheduler");

			// Get configuration from environment or use defaults
			const DEFAULT_INTERVAL_HOURS = 12;
			const parsedInterval = Number.parseInt(
				process.env.TRASH_UPDATE_CHECK_INTERVAL_HOURS || "",
				10,
			);
			const intervalHours =
				Number.isFinite(parsedInterval) && parsedInterval > 0
					? Math.floor(parsedInterval)
					: DEFAULT_INTERVAL_HOURS;

			const config = {
				enabled: process.env.TRASH_UPDATE_SCHEDULER_ENABLED !== "false", // Enabled by default
				intervalHours,
			};

			// Create services
			const versionTracker = createVersionTracker();
			const cacheManager = createCacheManager(app.prisma);
			const githubFetcher = createTrashFetcher();
			const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.encryptor);
			const templateUpdater = createTemplateUpdater(
				app.prisma,
				versionTracker,
				cacheManager,
				githubFetcher,
				deploymentExecutor,
			);

			// Create and register scheduler
			const scheduler = createUpdateScheduler(
				config,
				templateUpdater,
				versionTracker,
				app.prisma,
				app.log,
			);

			app.decorate("trashUpdateScheduler", scheduler);

			// Start scheduler
			scheduler.start();
			app.log.info("TRaSH Guides update scheduler started successfully");
		});

		// Stop scheduler on server close
		app.addHook("onClose", async () => {
			if (app.trashUpdateScheduler) {
				app.log.info("Stopping TRaSH Guides update scheduler");
				app.trashUpdateScheduler.stop();
			}
		});
	},
	{
		name: "trash-update-scheduler",
		dependencies: ["prisma"],
	},
);

export default trashUpdateSchedulerPlugin;
