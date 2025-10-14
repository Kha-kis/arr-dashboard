import type { FastifyPluginCallback } from "fastify";
import path from "node:path";
import {
	createBackupRequestSchema,
	restoreBackupRequestSchema,
	type CreateBackupResponse,
	type RestoreBackupResponse,
} from "@arr/shared";
import { BackupService } from "../lib/backup/backup-service.js";

const BACKUP_RATE_LIMIT = { max: 3, timeWindow: "5 minutes" };
const RESTORE_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };

const backupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /backup/create
	 * Create an encrypted backup and return it
	 */
	app.post(
		"/create",
		{ config: { rateLimit: BACKUP_RATE_LIMIT } },
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const parsed = createBackupRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
			}

			try {
				// Determine secrets path
				const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
				const dbPath = databaseUrl.replace("file:", "");
				const secretsPath = path.join(path.dirname(dbPath), "secrets.json");

				// Create backup service
				const backupService = new BackupService(app.prisma, secretsPath);

				// Get app version from package.json
				const appVersion = "2.2.0"; // TODO: Load from package.json

				// Create backup
				const result = await backupService.createBackup(parsed.data.password, appVersion);

				request.log.info(
					{
						userId: request.currentUser.id,
						backupSize: result.encryptedBackup.length,
						timestamp: result.metadata.timestamp,
					},
					"Backup created successfully",
				);

				const response: CreateBackupResponse = {
					encryptedBackup: result.encryptedBackup,
					metadata: result.metadata,
					filename: result.filename,
				};

				return reply.send(response);
			} catch (error: any) {
				request.log.error({ err: error }, "Failed to create backup");
				return reply.status(500).send({
					error: "Failed to create backup",
					details: error.message,
				});
			}
		},
	);

	/**
	 * POST /backup/restore
	 * Restore from an encrypted backup
	 */
	app.post(
		"/restore",
		{ config: { rateLimit: RESTORE_RATE_LIMIT } },
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const parsed = restoreBackupRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
			}

			try {
				// Determine secrets path
				const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
				const dbPath = databaseUrl.replace("file:", "");
				const secretsPath = path.join(path.dirname(dbPath), "secrets.json");

				// Create backup service
				const backupService = new BackupService(app.prisma, secretsPath);

				// Restore backup
				const metadata = await backupService.restoreBackup(
					parsed.data.encryptedBackup,
					parsed.data.password,
				);

				request.log.info(
					{
						userId: request.currentUser.id,
						backupTimestamp: metadata.timestamp,
						backupVersion: metadata.version,
						backupAppVersion: metadata.appVersion,
					},
					"Backup restored successfully",
				);

				// Check if we're in production (Docker, PM2, systemd will auto-restart)
				const isProduction = process.env.NODE_ENV === "production";

				const response: RestoreBackupResponse = {
					success: true,
					message: isProduction
						? "Backup restored successfully. The application will restart automatically in 2 seconds..."
						: "Backup restored successfully. Please manually restart the application (stop and run 'pnpm run dev' again) for changes to take effect.",
					restoredAt: new Date().toISOString(),
					metadata,
				};

				// Send response first
				await reply.send(response);

				// Only auto-restart in production environments
				if (isProduction) {
					// Schedule application restart after a short delay to ensure response is sent
					// This allows Docker, PM2, systemd, or other process managers to restart the app
					request.log.info("Triggering application restart after successful restore");
					setTimeout(() => {
						request.log.info("Restarting application now...");
						process.exit(0); // Clean exit - process manager will restart
					}, 2000);
				} else {
					request.log.warn(
						"Development mode detected - skipping automatic restart. Please manually restart the dev server.",
					);
				}
			} catch (error: any) {
				request.log.error({ err: error }, "Failed to restore backup");

				// Check for specific error types
				if (error.message.includes("invalid password") || error.message.includes("decrypt")) {
					return reply.status(400).send({
						error: "Failed to restore backup: invalid password or corrupted backup file",
					});
				}

				if (error.message.includes("Invalid backup format") || error.message.includes("version")) {
					return reply.status(400).send({
						error: `Failed to restore backup: ${error.message}`,
					});
				}

				return reply.status(500).send({
					error: "Failed to restore backup",
					details: error.message,
				});
			}
		},
	);

	done();
};

export const registerBackupRoutes = backupRoutes;
