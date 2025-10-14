import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import path from "node:path";
import { BackupScheduler } from "../lib/backup/backup-scheduler.js";

declare module "fastify" {
	interface FastifyInstance {
		backupScheduler: BackupScheduler;
	}
}

const backupSchedulerPlugin = fastifyPlugin(async (app: FastifyInstance) => {
	// Get database path to determine secrets path
	const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
	const dbPath = databaseUrl.replace("file:", "");
	const secretsPath = path.join(path.dirname(dbPath), "secrets.json");

	// Create and register backup scheduler
	const scheduler = new BackupScheduler(app.prisma, app.log, secretsPath);
	app.decorate("backupScheduler", scheduler);

	// Start scheduler
	scheduler.start();

	// Stop scheduler on server close
	app.addHook("onClose", async () => {
		scheduler.stop();
	});
});

export default backupSchedulerPlugin;
