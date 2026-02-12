import fs from "node:fs/promises";
import {
	type BackupFileInfo,
	type BackupSettings,
	type ListBackupsResponse,
	type RestoreBackupResponse,
	createBackupRequestSchema,
	deleteBackupRequestSchema,
	restoreBackupFromFileRequestSchema,
	restoreBackupRequestSchema,
	updateBackupSettingsRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { BackupService } from "../lib/backup/backup-service.js";
import { validateRequest } from "../lib/utils/validate.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";
import { getAppVersion } from "../lib/utils/version.js";

const BACKUP_RATE_LIMIT = { max: 3, timeWindow: "5 minutes" };
const RESTORE_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };
const DELETE_RATE_LIMIT = { max: 5, timeWindow: "5 minutes" };

const backupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Helper to create backup service instance
	const getBackupService = () => {
		// Use app.config.DATABASE_URL (includes env schema defaults) not process.env
		const databaseUrl = app.config.DATABASE_URL || "file:./dev.db";
		const secretsPath = resolveSecretsPath(databaseUrl);
		return new BackupService(app.prisma, secretsPath, app.encryptor);
	};

	/**
	 * GET /backup
	 * List all backups from filesystem
	 */
	app.get("/", async (_request, reply) => {
		const backupService = getBackupService();
		const backups = await backupService.listBackups();

		const response: ListBackupsResponse = { backups };
		return reply.send(response);
	});

	/**
	 * POST /backup/create
	 * Create a backup and save it to filesystem
	 */
	app.post("/create", { config: { rateLimit: BACKUP_RATE_LIMIT } }, async (request, reply) => {
		validateRequest(createBackupRequestSchema, request.body);

		try {
			const backupService = getBackupService();

			// Get app version from root package.json
			const appVersion = getAppVersion();

			// Get backup settings to check if TRaSH backups should be included
			const settings = await app.prisma.backupSettings.findFirst({
				where: { id: 1 },
			});

			// Create backup and save to filesystem
			const backupInfo = await backupService.createBackup(appVersion, "manual", {
				includeTrashBackups: settings?.includeTrashBackups ?? false,
			});

			request.log.info(
				{
					userId: request.currentUser!.id,
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

			const errorMessage = error instanceof Error ? error.message : String(error);

			// Check for specific configuration errors that the user can fix
			if (errorMessage.includes("BACKUP_PASSWORD")) {
				return reply.status(400).send({
					error: "Backup password not configured",
					details:
						"Set the BACKUP_PASSWORD environment variable to enable encrypted backups in production.",
				});
			}

			if (errorMessage.includes("Failed to read secrets file")) {
				return reply.status(500).send({
					error: "Secrets file not found",
					details:
						"The application secrets file is missing. This may indicate a configuration issue.",
				});
			}

			return reply.status(500).send({ error: "Failed to create backup" });
		}
	});

	/**
	 * POST /backup/restore
	 * Restore from a backup (uploaded file)
	 */
	app.post("/restore", { config: { rateLimit: RESTORE_RATE_LIMIT } }, async (request, reply) => {
		const { backupData } = validateRequest(restoreBackupRequestSchema, request.body);

		try {
			const backupService = getBackupService();

			// Decode base64-encoded backup data from client
			const backupJson = Buffer.from(backupData, "base64").toString("utf-8");

			const metadata = await backupService.restoreBackup(backupJson);

			request.log.info(
				{
					userId: request.currentUser!.id,
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
	});

	/**
	 * POST /backup/restore-from-file
	 * Restore from a backup stored on filesystem
	 */
	app.post(
		"/restore-from-file",
		{ config: { rateLimit: RESTORE_RATE_LIMIT } },
		async (request, reply) => {
			const { id: backupId } = validateRequest(restoreBackupFromFileRequestSchema, request.body);

			try {
				const backupService = getBackupService();

				// Restore backup from filesystem
				const metadata = await backupService.restoreBackupFromFile(backupId);

				request.log.info(
					{
						userId: request.currentUser!.id,
						backupId,
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
		const params = request.params as { id: string };

		const backupService = getBackupService();
		const backup = await backupService.getBackupByIdInternal(params.id);

		if (!backup) {
			return reply.status(404).send({ error: "Backup not found" });
		}

		request.log.info(
			{
				userId: request.currentUser!.id,
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
	});

	/**
	 * DELETE /backup/:id
	 * Delete a backup by ID
	 */
	app.delete("/:id", { config: { rateLimit: DELETE_RATE_LIMIT } }, async (request, reply) => {
		const params = request.params as { id: string };
		const { id } = validateRequest(deleteBackupRequestSchema, { id: params.id });

		try {
			const backupService = getBackupService();

			// Delete backup
			await backupService.deleteBackup(id);

			request.log.info(
				{
					userId: request.currentUser!.id,
					backupId: id,
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
	});

	/**
	 * GET /backup/settings
	 * Get backup settings
	 */
	app.get("/settings", async (_request, reply) => {
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
			includeTrashBackups: settings.includeTrashBackups,
			lastRunAt: settings.lastRunAt?.toISOString() || null,
			nextRunAt: settings.nextRunAt?.toISOString() || null,
			createdAt: settings.createdAt.toISOString(),
			updatedAt: settings.updatedAt.toISOString(),
		};

		return reply.send(response);
	});

	/**
	 * PUT /backup/settings
	 * Update backup settings
	 */
	app.put("/settings", async (request, reply) => {
		const parsed = validateRequest(updateBackupSettingsRequestSchema, request.body);

		// Get or create settings atomically
		const settings = await app.prisma.backupSettings.upsert({
			where: { id: 1 },
			create: { id: 1 },
			update: {},
		});

		// Calculate next run time if interval settings changed
		let nextRunAt = settings.nextRunAt;
		if (parsed.intervalType || parsed.intervalValue) {
			const intervalType = parsed.intervalType || settings.intervalType;
			const intervalValue = parsed.intervalValue || settings.intervalValue;

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
				...parsed,
				nextRunAt,
			},
		});

		request.log.info(
			{
				userId: request.currentUser!.id,
				settings: parsed,
			},
			"Backup settings updated",
		);

		const response: BackupSettings = {
			id: updated.id,
			enabled: updated.enabled,
			intervalType: updated.intervalType,
			intervalValue: updated.intervalValue,
			retentionCount: updated.retentionCount,
			includeTrashBackups: updated.includeTrashBackups,
			lastRunAt: updated.lastRunAt?.toISOString() || null,
			nextRunAt: updated.nextRunAt?.toISOString() || null,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
		};

		return reply.send(response);
	});

	/**
	 * GET /backup/password/status
	 * Get backup password configuration status
	 */
	app.get("/password/status", async (_request, reply) => {
		const backupService = getBackupService();
		const status = await backupService.getPasswordStatus();

		return reply.send(status);
	});

	/**
	 * PUT /backup/password
	 * Set or update the backup password
	 */
	app.put<{
		Body: { password: string };
	}>("/password", async (request, reply) => {
		const { password } = request.body;

		if (!password || typeof password !== "string") {
			return reply.status(400).send({ error: "Password is required" });
		}

		if (password.length < 8) {
			return reply.status(400).send({ error: "Password must be at least 8 characters" });
		}

		try {
			const backupService = getBackupService();
			await backupService.setPassword(password);

			request.log.info({ userId: request.currentUser!.id }, "Backup password updated");

			return reply.send({ success: true, message: "Backup password updated successfully" });
		} catch (error) {
			request.log.error({ err: error }, "Failed to set backup password");

			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes("Encryptor not available")) {
				return reply.status(500).send({ error: "Encryption service not available" });
			}

			return reply.status(500).send({ error: "Failed to set backup password" });
		}
	});

	/**
	 * DELETE /backup/password
	 * Remove the backup password from database (will fall back to env var if set)
	 */
	app.delete("/password", async (request, reply) => {
		const backupService = getBackupService();
		await backupService.removePassword();

		request.log.info(
			{ userId: request.currentUser!.id },
			"Backup password removed from database",
		);

		return reply.send({ success: true, message: "Backup password removed from database" });
	});

	done();
};

export const registerBackupRoutes = backupRoutes;
