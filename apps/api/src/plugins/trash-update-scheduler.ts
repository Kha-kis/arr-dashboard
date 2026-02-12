/**
 * TRaSH Guides Update Scheduler Plugin
 *
 * Fastify plugin that initializes and manages the TRaSH Guides update scheduler.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { createCacheManager } from "../lib/trash-guides/cache-manager.js";
import { createDeploymentExecutorService } from "../lib/trash-guides/deployment-executor.js";
import { createTrashFetcher } from "../lib/trash-guides/github-fetcher.js";
import { getGlobalRepoConfig } from "../lib/trash-guides/repo-config.js";
import { createTemplateUpdater } from "../lib/trash-guides/template-updater.js";
import {
	type UpdateScheduler,
	createUpdateScheduler,
} from "../lib/trash-guides/update-scheduler.js";
import { createVersionTracker } from "../lib/trash-guides/version-tracker.js";

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

			// Create services using the global repo config (scheduler runs outside user context).
			// TODO: The repo config is read once at startup. If the user changes their custom
			// repo via settings, the scheduler continues using the old config until server restart.
			// To fix, either re-read config each tick or add a refresh mechanism.
			const repoConfig = await getGlobalRepoConfig(app.prisma);
			app.log.info(
				{ repoOwner: repoConfig.owner, repoName: repoConfig.name, repoBranch: repoConfig.branch },
				"Scheduler using repository configuration",
			);
			const versionTracker = createVersionTracker(repoConfig);
			const cacheManager = createCacheManager(app.prisma);
			const githubFetcher = createTrashFetcher({ repoConfig, logger: app.log });
			const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.arrClientFactory);
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
