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
	// Determine secrets path based on DATABASE_URL (same logic as security plugin)
	const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
	let secretsPath: string;

	if (databaseUrl.startsWith("file:")) {
		// Extract directory from SQLite database path
		const dbPath = databaseUrl.replace("file:", "");
		secretsPath = path.join(path.dirname(dbPath), "secrets.json");
	} else {
		// For non-SQLite databases (PostgreSQL, MySQL), use default path
		secretsPath = "./data/secrets.json";
	}

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
