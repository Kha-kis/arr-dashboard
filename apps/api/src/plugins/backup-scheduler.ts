import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { BackupScheduler } from "../lib/backup/backup-scheduler.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";

declare module "fastify" {
	interface FastifyInstance {
		backupScheduler: BackupScheduler;
	}
}

const backupSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		// Determine secrets path based on DATABASE_URL using shared helper
		const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
		const secretsPath = resolveSecretsPath(databaseUrl);

		// Use onReady hook to ensure Prisma is fully initialized before creating scheduler
		app.addHook("onReady", async () => {
			app.log.info("Initializing backup scheduler");

			// Create and register backup scheduler (Prisma is guaranteed to be ready)
			const scheduler = new BackupScheduler(app.prisma, app.log, secretsPath);
			app.decorate("backupScheduler", scheduler);

			// Start scheduler
			scheduler.start();
			app.log.info("Backup scheduler started successfully");
		});

		// Stop scheduler on server close
		app.addHook("onClose", async () => {
			if (app.backupScheduler) {
				app.log.info("Stopping backup scheduler");
				app.backupScheduler.stop();
			}
		});
	},
	{
		name: "backup-scheduler",
		dependencies: ["prisma"],
	}
);

export default backupSchedulerPlugin;
