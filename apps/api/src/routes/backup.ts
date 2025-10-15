import type { FastifyPluginCallback } from "fastify";
import fs from "node:fs/promises";
import {
	createBackupRequestSchema,
	deleteBackupRequestSchema,
	restoreBackupFromFileRequestSchema,
	restoreBackupRequestSchema,
	updateBackupSettingsRequestSchema,
	type BackupFileInfo,
	type BackupSettings,
	type ListBackupsResponse,
	type RestoreBackupResponse,
} from "@arr/shared";
import { BackupService } from "../lib/backup/backup-service.js";
import { getAppVersion } from "../lib/utils/version.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";

const BACKUP_RATE_LIMIT = { max: 3, timeWindow: "5 minutes" };
const RESTORE_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };
const DELETE_RATE_LIMIT = { max: 5, timeWindow: "5 minutes" };

const backupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Helper to create backup service instance
	const getBackupService = () => {
		// Use app.config.DATABASE_URL (includes env schema defaults) not process.env
		const databaseUrl = app.config.DATABASE_URL || "file:./dev.db";
		const secretsPath = resolveSecretsPath(databaseUrl);
		return new BackupService(app.prisma, secretsPath);
	};

	/**
	 * GET /backup
	 * List all backups from filesystem
	 */
	app.get("/", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		try {
			const backupService = getBackupService();
			const backups = await backupService.listBackups();

			const response: ListBackupsResponse = { backups };
			return reply.send(response);
		} catch (error) {
			request.log.error({ err: error }, "Failed to list backups");
			return reply.status(500).send({ error: "Failed to list backups" });
		}
	});

	/**
	 * POST /backup/create
	 * Create a backup and save it to filesystem
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
				const backupService = getBackupService();

				// Get app version from root package.json
				const appVersion = getAppVersion();

				// Create backup and save to filesystem
				const backupInfo = await backupService.createBackup(appVersion, "manual");

				request.log.info(
					{
						userId: request.currentUser.id,
						backupId: backupInfo.id,
						backupSize: backupInfo.size,
						timestamp: backupInfo.timestamp,
					},
					"Backup created successfully",
				);

				const response: BackupFileInfo = backupInfo;

				return reply.send(response);
			} catch (error) {
				request.log.error({ err: error }, "Failed to create backup");
				return reply.status(500).send({ error: "Failed to create backup" });
			}
		},
	);

	/**
	 * POST /backup/restore
	 * Restore from a backup (uploaded file)
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
				const backupService = getBackupService();

				// Decode base64-encoded backup data from client
				const backupJson = Buffer.from(parsed.data.backupData, "base64").toString("utf-8");

				const metadata = await backupService.restoreBackup(backupJson);

				request.log.info(
					{
						userId: request.currentUser.id,
						backupTimestamp: metadata.timestamp,
						backupVersion: metadata.version,
						backupAppVersion: metadata.appVersion,
					},
					"Backup restored successfully (from upload)",
				);

				const response: RestoreBackupResponse = {
					success: true,
					message: `Backup restored successfully. ${app.lifecycle?.getRestartMessage?.() || "Please restart the application manually for changes to take effect."}`,
					restoredAt: new Date().toISOString(),
					metadata,
				};

				// Send response
				await reply.send(response);

				// Initiate restart if lifecycle service is available and configured
				if (app.lifecycle?.isRestartRequired?.()) {
					await app.lifecycle.restart("backup-restore");
				}
			} catch (error) {
				request.log.error({ err: error }, "Failed to restore backup");

				const errorMessage = error instanceof Error ? error.message : String(error);

				// Check for specific error types
				if (errorMessage.includes("Invalid backup format") || errorMessage.includes("version")) {
					return reply.status(400).send({ error: "Invalid backup format or version mismatch" });
				}

				return reply.status(500).send({ error: "Failed to restore backup" });
			}
		},
	);

	/**
	 * POST /backup/restore-from-file
	 * Restore from a backup stored on filesystem
	 */
	app.post(
		"/restore-from-file",
		{ config: { rateLimit: RESTORE_RATE_LIMIT } },
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const parsed = restoreBackupFromFileRequestSchema.safeParse(request.body);
			if (!parsed.success) {
				return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
			}

			try {
				const backupService = getBackupService();

				// Restore backup from filesystem
				const metadata = await backupService.restoreBackupFromFile(parsed.data.id);

				request.log.info(
					{
						userId: request.currentUser.id,
						backupId: parsed.data.id,
						backupTimestamp: metadata.timestamp,
						backupVersion: metadata.version,
						backupAppVersion: metadata.appVersion,
					},
					"Backup restored successfully (from filesystem)",
				);

				const response: RestoreBackupResponse = {
					success: true,
					message: `Backup restored successfully. ${app.lifecycle?.getRestartMessage?.() || "Please restart the application manually for changes to take effect."}`,
					restoredAt: new Date().toISOString(),
					metadata,
				};

				// Send response
				await reply.send(response);

				// Initiate restart if lifecycle service is available and configured
				if (app.lifecycle?.isRestartRequired?.()) {
					await app.lifecycle.restart("backup-restore");
				}
			} catch (error) {
				request.log.error({ err: error }, "Failed to restore backup from file");

				const errorMessage = error instanceof Error ? error.message : String(error);

				// Check for specific error types
				if (errorMessage.includes("not found")) {
					return reply.status(404).send({ error: "Backup not found" });
				}

				if (errorMessage.includes("Invalid backup format") || errorMessage.includes("version")) {
					return reply.status(400).send({ error: "Invalid backup format or version mismatch" });
				}

				return reply.status(500).send({ error: "Failed to restore backup" });
			}
		},
	);

	/**
	 * GET /backup/:id/download
	 * Download a backup file by ID
	 */
	app.get("/:id/download", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const params = request.params as { id: string };

		try {
			const backupService = getBackupService();
			const backup = await backupService.getBackupByIdInternal(params.id);

			if (!backup) {
				return reply.status(404).send({ error: "Backup not found" });
			}

			request.log.info(
				{
					userId: request.currentUser.id,
					backupId: params.id,
					filename: backup.filename,
				},
				"Backup downloaded",
			);

			// Read the file and send it
			const fileBuffer = await fs.readFile(backup.path);
			return reply
				.header("Content-Type", "application/octet-stream")
				.header("Content-Disposition", `attachment; filename="${backup.filename}"`)
				.send(fileBuffer);
		} catch (error) {
			request.log.error({ err: error }, "Failed to download backup");
			return reply.status(500).send({ error: "Failed to download backup" });
		}
	});

	/**
	 * DELETE /backup/:id
	 * Delete a backup by ID
	 */
	app.delete(
		"/:id",
		{ config: { rateLimit: DELETE_RATE_LIMIT } },
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const params = request.params as { id: string };
			const parsed = deleteBackupRequestSchema.safeParse({ id: params.id });
			if (!parsed.success) {
				return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
			}

			try {
				const backupService = getBackupService();

				// Delete backup
				await backupService.deleteBackup(parsed.data.id);

				request.log.info(
					{
						userId: request.currentUser.id,
						backupId: parsed.data.id,
					},
					"Backup deleted successfully",
				);

				return reply.send({ success: true, message: "Backup deleted successfully" });
			} catch (error) {
				request.log.error({ err: error }, "Failed to delete backup");

				const errorMessage = error instanceof Error ? error.message : String(error);

				if (errorMessage.includes("not found")) {
					return reply.status(404).send({ error: "Backup not found" });
				}

				return reply.status(500).send({ error: "Failed to delete backup" });
			}
		},
	);

	/**
	 * GET /backup/settings
	 * Get backup settings
	 */
	app.get("/settings", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		try {
			// Get or create settings atomically
			const settings = await app.prisma.backupSettings.upsert({
				where: { id: 1 },
				create: { id: 1 },
				update: {},
			});

			const response: BackupSettings = {
				id: settings.id,
				enabled: settings.enabled,
				intervalType: settings.intervalType,
				intervalValue: settings.intervalValue,
				retentionCount: settings.retentionCount,
				lastRunAt: settings.lastRunAt?.toISOString() || null,
				nextRunAt: settings.nextRunAt?.toISOString() || null,
				createdAt: settings.createdAt.toISOString(),
				updatedAt: settings.updatedAt.toISOString(),
			};

			return reply.send(response);
		} catch (error) {
			request.log.error({ err: error }, "Failed to get backup settings");
			return reply.status(500).send({ error: "Failed to get backup settings" });
		}
	});

	/**
	 * PUT /backup/settings
	 * Update backup settings
	 */
	app.put("/settings", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const parsed = updateBackupSettingsRequestSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
		}

		try {
			// Get or create settings atomically
			const settings = await app.prisma.backupSettings.upsert({
				where: { id: 1 },
				create: { id: 1 },
				update: {},
			});

			// Calculate next run time if interval settings changed
			let nextRunAt = settings.nextRunAt;
			if (parsed.data.intervalType || parsed.data.intervalValue) {
				const intervalType = parsed.data.intervalType || settings.intervalType;
				const intervalValue = parsed.data.intervalValue || settings.intervalValue;

				if (intervalType !== "DISABLED") {
					const now = new Date();
					switch (intervalType) {
						case "HOURLY":
							nextRunAt = new Date(now.getTime() + intervalValue * 60 * 60 * 1000);
							break;
						case "DAILY":
							nextRunAt = new Date(now.getTime() + intervalValue * 24 * 60 * 60 * 1000);
							break;
						case "WEEKLY":
							nextRunAt = new Date(now.getTime() + intervalValue * 7 * 24 * 60 * 60 * 1000);
							break;
					}
				} else {
					// When DISABLED, clear any scheduled run
					nextRunAt = null;
				}
			}

			// Update settings
			const updated = await app.prisma.backupSettings.update({
				where: { id: 1 },
				data: {
					...parsed.data,
					nextRunAt,
				},
			});

			request.log.info(
				{
					userId: request.currentUser.id,
					settings: parsed.data,
				},
				"Backup settings updated",
			);

			const response: BackupSettings = {
				id: updated.id,
				enabled: updated.enabled,
				intervalType: updated.intervalType,
				intervalValue: updated.intervalValue,
				retentionCount: updated.retentionCount,
				lastRunAt: updated.lastRunAt?.toISOString() || null,
				nextRunAt: updated.nextRunAt?.toISOString() || null,
				createdAt: updated.createdAt.toISOString(),
				updatedAt: updated.updatedAt.toISOString(),
			};

			return reply.send(response);
		} catch (error) {
			request.log.error({ err: error }, "Failed to update backup settings");
			return reply.status(500).send({ error: "Failed to update backup settings" });
		}
	});

	done();
};

export const registerBackupRoutes = backupRoutes;
