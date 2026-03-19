/**
 * TRaSH Backup Cleanup Plugin
 *
 * Fastify plugin that initializes and manages the TRaSH backup cleanup scheduler.
 * This plugin handles automated cleanup of expired and orphaned TRaSH backups.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import {
	createTrashBackupCleanupService,
	type TrashBackupCleanupService,
} from "../lib/trash-guides/trash-backup-cleanup.js";

declare module "fastify" {
	interface FastifyInstance {
		trashBackupCleanup: TrashBackupCleanupService;
	}
}

const trashBackupCleanupPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Use onReady hook to ensure Prisma is fully initialized
		app.addHook("onReady", async () => {
			app.log.info("Initializing TRaSH backup cleanup scheduler");

			// Create and register cleanup service
			const cleanupService = createTrashBackupCleanupService(app.prisma, app.log);
			app.decorate("trashBackupCleanup", cleanupService);

			// Start scheduler
			cleanupService.start();
			app.log.info("TRaSH backup cleanup scheduler started successfully");
		});

		// Stop scheduler on server close
		app.addHook("onClose", async () => {
			if (app.trashBackupCleanup) {
				app.log.info("Stopping TRaSH backup cleanup scheduler");
				app.trashBackupCleanup.stop();
			}
		});
	},
	{
		name: "trash-backup-cleanup",
		dependencies: ["prisma"],
	},
);

export default trashBackupCleanupPlugin;
