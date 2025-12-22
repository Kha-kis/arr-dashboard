/**
 * TRaSH Guides Settings Routes
 *
 * API routes for managing TRaSH Guides user settings including backup retention policy.
 *
 * BACKUP RETENTION POLICY:
 * ------------------------
 * - `backupRetentionDays`: Number of days before a backup automatically expires (default: 30)
 *   - Set to 0 to disable automatic expiration (backups will never auto-delete)
 *   - Backups are created before each deployment operation
 *   - Expired backups are automatically cleaned up by the trash-backup-cleanup scheduler
 *
 * - `backupRetention`: Maximum number of backups to keep per instance (default: 10)
 *   - This is a count-based retention policy
 *   - Enforced by the BackupManager.enforceRetentionLimit() method
 *
 * CLEANUP PROCESS:
 * ----------------
 * The trash-backup-cleanup scheduler runs every hour and performs:
 * 1. Deletes backups where expiresAt < now()
 * 2. Deletes orphaned backups (no referencing SyncHistory or DeploymentHistory) older than 7 days
 *
 * The scheduler is registered as a Fastify plugin and starts automatically when the server starts.
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// Schema for settings response
const trashSettingsSchema = z.object({
	id: z.string(),
	userId: z.string(),
	checkFrequency: z.number(),
	autoRefreshCache: z.boolean(),
	notifyOnUpdates: z.boolean(),
	notifyOnSyncFail: z.boolean(),
	backupRetention: z.number(),
	backupRetentionDays: z.number(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

// Schema for update request
const updateSettingsSchema = z.object({
	checkFrequency: z.number().min(1).max(168).optional(), // 1 hour to 1 week
	autoRefreshCache: z.boolean().optional(),
	notifyOnUpdates: z.boolean().optional(),
	notifyOnSyncFail: z.boolean().optional(),
	backupRetention: z.number().min(1).max(100).optional(), // 1-100 backups per instance
	backupRetentionDays: z.number().min(0).max(365).optional(), // 0 = never expire, max 1 year
});

export async function registerSettingsRoutes(app: FastifyInstance, opts: FastifyPluginOptions) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /api/trash-guides/settings
	 *
	 * Get the current user's TRaSH Guides settings.
	 * Creates default settings if they don't exist.
	 */
	app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser?.id;

		// Get or create settings
		let settings = await app.prisma.trashSettings.findUnique({
			where: { userId },
		});

		if (!settings) {
			settings = await app.prisma.trashSettings.create({
				data: { userId },
			});
		}

		return reply.send({
			settings,
			// Include documentation about the settings
			documentation: {
				backupRetentionDays: {
					description: "Number of days before backups automatically expire",
					default: 30,
					range: "0-365 (0 = never expire)",
				},
				backupRetention: {
					description: "Maximum number of backups to keep per instance",
					default: 10,
					range: "1-100",
				},
				checkFrequency: {
					description: "How often to check for TRaSH Guides updates (hours)",
					default: 12,
					range: "1-168",
				},
			},
		});
	});

	/**
	 * PATCH /api/trash-guides/settings
	 *
	 * Update the current user's TRaSH Guides settings.
	 */
	app.patch("/", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser?.id;

		// Validate request body
		const parseResult = updateSettingsSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				error: "Invalid request body",
				details: parseResult.error.errors,
			});
		}

		const updates = parseResult.data;

		// Upsert settings
		const settings = await app.prisma.trashSettings.upsert({
			where: { userId },
			create: {
				userId,
				...updates,
			},
			update: updates,
		});

		return reply.send({
			settings,
			message: "Settings updated successfully",
		});
	});

	/**
	 * GET /api/trash-guides/settings/backup-stats
	 *
	 * Get backup statistics for the current user.
	 * Useful for monitoring backup retention and cleanup effectiveness.
	 */
	app.get("/backup-stats", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser?.id;

		// Get user's settings
		const settings = await app.prisma.trashSettings.findUnique({
			where: { userId },
			select: { backupRetention: true, backupRetentionDays: true },
		});

		// Count backups
		const totalBackups = await app.prisma.trashBackup.count({
			where: { userId },
		});

		// Count expired backups
		const expiredBackups = await app.prisma.trashBackup.count({
			where: {
				userId,
				expiresAt: {
					not: null,
					lte: new Date(),
				},
			},
		});

		// Count backups per instance
		const backupsPerInstance = await app.prisma.trashBackup.groupBy({
			by: ["instanceId"],
			where: { userId },
			_count: { id: true },
		});

		// Get oldest and newest backup dates
		const oldestBackup = await app.prisma.trashBackup.findFirst({
			where: { userId },
			orderBy: { createdAt: "asc" },
			select: { createdAt: true },
		});

		const newestBackup = await app.prisma.trashBackup.findFirst({
			where: { userId },
			orderBy: { createdAt: "desc" },
			select: { createdAt: true },
		});

		return reply.send({
			stats: {
				totalBackups,
				expiredBackups,
				backupsPerInstance: backupsPerInstance.map((b) => ({
					instanceId: b.instanceId,
					count: b._count.id,
				})),
				oldestBackup: oldestBackup?.createdAt ?? null,
				newestBackup: newestBackup?.createdAt ?? null,
			},
			settings: {
				backupRetention: settings?.backupRetention ?? 10,
				backupRetentionDays: settings?.backupRetentionDays ?? 30,
			},
			retentionPolicy: {
				description: "Backups are automatically cleaned up based on two policies",
				timeBased: {
					enabled: (settings?.backupRetentionDays ?? 30) > 0,
					days: settings?.backupRetentionDays ?? 30,
					description: "Backups older than this are automatically deleted",
				},
				countBased: {
					enabled: true,
					maxPerInstance: settings?.backupRetention ?? 10,
					description: "Only the most recent N backups per instance are kept",
				},
				orphanCleanup: {
					enabled: true,
					gracePeriodDays: 7,
					description: "Backups with no referencing history records are deleted after 7 days",
				},
			},
		});
	});
}
