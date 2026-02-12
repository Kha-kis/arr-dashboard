/**
 * Library Sync Routes
 *
 * Provides endpoints for managing library cache synchronization:
 * - Get sync status for all instances
 * - Trigger manual sync for an instance
 * - Update polling settings
 */

import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { getLibrarySyncScheduler } from "../../lib/library-sync/index.js";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const instanceIdParamSchema = z.object({
	instanceId: z.string(),
});

const updateSyncSettingsSchema = z.object({
	pollingEnabled: z.boolean().optional(),
	pollingIntervalMins: z.number().int().min(5).max(1440).optional(), // 5 mins to 24 hours
});

// ============================================================================
// Routes
// ============================================================================

export const registerSyncRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /library/sync/status
	 * Get sync status for all user's instances
	 */
	app.get("/library/sync/status", async (request, _reply) => {
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
			},
			include: {
				librarySyncStatus: true,
			},
			orderBy: { label: "asc" },
		});

		const scheduler = getLibrarySyncScheduler();

		const statuses = instances.map((instance) => {
			const status = instance.librarySyncStatus;
			return {
				instanceId: instance.id,
				instanceName: instance.label,
				service: instance.service.toLowerCase(),
				syncStatus: status
					? {
							lastFullSync: status.lastFullSync?.toISOString() ?? null,
							lastSyncDurationMs: status.lastSyncDurationMs,
							syncInProgress: status.syncInProgress || scheduler.isInstanceSyncing(instance.id),
							lastError: status.lastError,
							itemCount: status.itemCount,
							pollingEnabled: status.pollingEnabled,
							pollingIntervalMins: status.pollingIntervalMins,
						}
					: {
							lastFullSync: null,
							lastSyncDurationMs: null,
							syncInProgress: scheduler.isInstanceSyncing(instance.id),
							lastError: null,
							itemCount: 0,
							pollingEnabled: true,
							pollingIntervalMins: 15,
						},
			};
		});

		return { instances: statuses };
	});

	/**
	 * POST /library/sync/:instanceId
	 * Trigger a manual sync for a specific instance
	 */
	app.post("/library/sync/:instanceId", async (request, reply) => {
		const params = validateRequest(instanceIdParamSchema, request.params);
		const userId = request.currentUser!.id;

		const instance = await requireInstance(app, userId, params.instanceId);

		if (!["SONARR", "RADARR", "LIDARR", "READARR"].includes(instance.service)) {
			return reply.status(400).send({ error: "Only Sonarr, Radarr, Lidarr, and Readarr instances can be synced" });
		}

		const scheduler = getLibrarySyncScheduler();

		// Check if already syncing
		if (scheduler.isInstanceSyncing(params.instanceId)) {
			return reply.status(409).send({ error: "Sync already in progress" });
		}

		// Trigger sync in background
		scheduler.triggerSync(params.instanceId).catch((err) => {
			request.log.error({ err, instanceId: params.instanceId }, "Manual sync failed");
		});

		return {
			success: true,
			message: "Sync started",
			instanceId: params.instanceId,
		};
	});

	/**
	 * PATCH /library/sync/:instanceId
	 * Update sync settings for an instance
	 */
	app.patch("/library/sync/:instanceId", async (request, _reply) => {
		const params = validateRequest(instanceIdParamSchema, request.params);
		const body = validateRequest(updateSyncSettingsSchema, request.body ?? {});
		const userId = request.currentUser!.id;

		await requireInstance(app, userId, params.instanceId);

		// Upsert sync status with updated settings
		const updated = await app.prisma.librarySyncStatus.upsert({
			where: { instanceId: params.instanceId },
			create: {
				instanceId: params.instanceId,
				pollingEnabled: body.pollingEnabled ?? true,
				pollingIntervalMins: body.pollingIntervalMins ?? 15,
			},
			update: {
				...(body.pollingEnabled !== undefined && { pollingEnabled: body.pollingEnabled }),
				...(body.pollingIntervalMins !== undefined && {
					pollingIntervalMins: body.pollingIntervalMins,
				}),
			},
		});

		return {
			success: true,
			settings: {
				pollingEnabled: updated.pollingEnabled,
				pollingIntervalMins: updated.pollingIntervalMins,
			},
		};
	});

	done();
};

export default registerSyncRoutes;
