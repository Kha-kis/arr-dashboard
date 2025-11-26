/**
 * TRaSH Guides Sync Routes
 *
 * API endpoints for template synchronization to Radarr/Sonarr instances
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { z } from "zod";
import { createSyncEngine } from "../../lib/trash-guides/sync-engine.js";
import type { SyncProgress } from "../../lib/trash-guides/sync-engine.js";
import { createArrApiClient } from "../../lib/trash-guides/arr-api-client.js";
import { createTemplateUpdater } from "../../lib/trash-guides/template-updater.js";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";

// ============================================================================
// Request Schemas
// ============================================================================

const validateSyncSchema = z.object({
	templateId: z.string().cuid(),
	instanceId: z.string().cuid(),
});

const executeSyncSchema = z.object({
	templateId: z.string().cuid(),
	instanceId: z.string().cuid(),
	syncType: z.enum(["MANUAL", "SCHEDULED"]),
	conflictResolutions: z.record(z.enum(["REPLACE", "SKIP"])).optional(),
});

const syncHistoryQuerySchema = z.object({
	limit: z.string().optional().transform((val) => (val ? Number.parseInt(val, 10) : 20)),
	offset: z.string().optional().transform((val) => (val ? Number.parseInt(val, 10) : 0)),
});

// ============================================================================
// In-Memory Progress Tracking (temporary - will move to Redis/cache later)
// ============================================================================

const progressStore = new Map<string, SyncProgress>();

// ============================================================================
// Routes
// ============================================================================

export async function registerSyncRoutes(
	app: FastifyInstance,
	opts: FastifyPluginOptions,
) {
		// Create template updater services
		const versionTracker = createVersionTracker();
		const cacheManager = createCacheManager(app.prisma);
		const githubFetcher = createTrashFetcher();
		const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.encryptor);
		const templateUpdater = createTemplateUpdater(
			app.prisma,
			versionTracker,
			cacheManager,
			githubFetcher,
			deploymentExecutor,
		);

		// Create sync engine with template updater and deployment executor
		const syncEngine = createSyncEngine(app.prisma, templateUpdater, deploymentExecutor);

		/**
		 * Validate sync before execution
		 * POST /api/trash-guides/sync/validate
		 */
		app.post("/validate", async (request: FastifyRequest, reply) => {
			const body = validateSyncSchema.parse(request.body);
			const userId = request.currentUser?.id || "";

			const validation = await syncEngine.validate({
				templateId: body.templateId,
				instanceId: body.instanceId,
				userId,
				syncType: "MANUAL",
			});

			return reply.send(validation);
		});

		/**
		 * Execute sync operation
		 * POST /api/trash-guides/sync/execute
		 */
	/**
	 * Execute sync operation
	 * POST /api/trash-guides/sync/execute
	 */
	app.post("/execute", async (request: FastifyRequest, reply) => {
		const body = executeSyncSchema.parse(request.body);
		const userId = request.currentUser?.id || "";

		// Convert conflictResolutions object to Map
		const resolutionsMap = body.conflictResolutions
			? new Map(Object.entries(body.conflictResolutions) as [string, "REPLACE" | "SKIP"][])
			: undefined;

		// Execute sync - this will complete synchronously
		const result = await syncEngine.execute(
			{
				templateId: body.templateId,
				instanceId: body.instanceId,
				userId,
				syncType: body.syncType,
			},
			resolutionsMap,
		);

		// By the time we get here, sync is complete. Store final state in progress store
		// so that polling endpoints can retrieve it
		const finalProgress: SyncProgress = {
			syncId: result.syncId,
			status: result.success ? "COMPLETED" : "FAILED",
			currentStep: result.success 
				? `Sync completed: ${result.configsApplied} applied, ${result.configsFailed} failed`
				: "Sync failed",
			progress: 100,
			totalConfigs: result.configsApplied + result.configsFailed + result.configsSkipped,
			appliedConfigs: result.configsApplied,
			failedConfigs: result.configsFailed,
			errors: result.errors,
		};
		
		progressStore.set(result.syncId, finalProgress);

		// Set up handler for any future progress updates (though sync is already done)
		syncEngine.onProgress(result.syncId, (progress: SyncProgress) => {
			progressStore.set(progress.syncId, progress);
		});

		return reply.send(result);
	});
		/**
		 * Stream sync progress (SSE endpoint)
		 * GET /api/trash-guides/sync/:syncId/stream
		 */
		app.get<{
			Params: { syncId: string };
		}>("/:syncId/stream", async (request, reply) => {
			const { syncId } = request.params;

			// Set SSE headers
			reply.raw.setHeader("Content-Type", "text/event-stream");
			reply.raw.setHeader("Cache-Control", "no-cache");
			reply.raw.setHeader("Connection", "keep-alive");
			reply.raw.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

			// Send initial connection message
			reply.raw.write("data: {\"type\":\"connected\"}\n\n");

			// Set up progress callback to stream updates
			const streamProgress = (progress: SyncProgress) => {
				if (!reply.raw.destroyed) {
					reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);

					// Close stream when completed or failed
					if (progress.status === "COMPLETED" || progress.status === "FAILED") {
						setTimeout(() => {
							reply.raw.end();
						}, 1000); // Give client time to process final message
					}
				}
			};

			// Register callback
			syncEngine.onProgress(syncId, streamProgress);

			// Send current progress if available
			const currentProgress = progressStore.get(syncId);
			if (currentProgress) {
				streamProgress(currentProgress);
			} else {
				// No progress found, send error and close
				reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Sync not found" })}\n\n`);
				reply.raw.end();
				return;
			}

			// Clean up on client disconnect
			request.raw.on("close", () => {
				// Note: progressCallbacks are cleaned up by sync engine after completion
				reply.raw.end();
			});
		});

		/**
		 * Get sync progress (polling fallback endpoint)
		 * GET /api/trash-guides/sync/:syncId/progress
		 */
		app.get<{
			Params: { syncId: string };
		}>("/:syncId/progress", async (request, reply) => {
			const { syncId } = request.params;

			const progress = progressStore.get(syncId);

			if (!progress) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Sync progress not found. It may have completed or expired.",
				});
			}

			return reply.send(progress);
		});

		/**
		 * Get sync history for an instance
		 * GET /api/trash-guides/sync/history/:instanceId
		 */
		app.get<{
			Params: { instanceId: string };
		}>("/history/:instanceId", async (request, reply) => {
			const { instanceId } = request.params;
			const query = syncHistoryQuerySchema.parse(request.query);
			const userId = request.currentUser?.id || "";

			// Verify instance exists
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
				},
			});

			if (!instance) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Instance not found or access denied",
				});
			}

			// Get sync history
			const [syncs, total] = await Promise.all([
				app.prisma.trashSyncHistory.findMany({
					where: { instanceId },
					include: {
						template: {
							select: {
								name: true,
							},
						},
					},
					orderBy: { startedAt: "desc" },
					take: query.limit,
					skip: query.offset,
				}),
				app.prisma.trashSyncHistory.count({
					where: { instanceId },
				}),
			]);

			return reply.send({
				syncs: syncs.map((sync) => ({
					id: sync.id,
					templateId: sync.templateId,
					templateName: sync.template?.name || "",
					status: sync.status,
					syncType: sync.syncType,
					startedAt: sync.startedAt.toISOString(),
					completedAt: sync.completedAt?.toISOString() || null,
					duration: sync.duration,
					configsApplied: sync.configsApplied,
					configsFailed: sync.configsFailed,
					configsSkipped: sync.configsSkipped,
					backupId: sync.backupId,
				})),
				total,
			});
		});

		/**
		 * Get sync details
		 * GET /api/trash-guides/sync/:syncId
		 */
		app.get<{
			Params: { syncId: string };
		}>("/:syncId", async (request, reply) => {
			const { syncId } = request.params;
			const userId = request.currentUser?.id || "";

			const sync = await app.prisma.trashSyncHistory.findFirst({
				where: {
					id: syncId,
				},
				include: {
					template: {
						select: {
							name: true,
						},
					},
					instance: {
						select: {
							label: true,
						},
					},
				},
			});

			if (!sync) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Sync not found or access denied",
				});
			}

			return reply.send({
				id: sync.id,
				templateId: sync.templateId,
				templateName: sync.template?.name || "",
				instanceId: sync.instanceId,
				instanceName: sync.instance.label,
				status: sync.status,
				syncType: sync.syncType,
				startedAt: sync.startedAt.toISOString(),
				completedAt: sync.completedAt?.toISOString() || null,
				duration: sync.duration,
				configsApplied: sync.configsApplied,
				configsFailed: sync.configsFailed,
				configsSkipped: sync.configsSkipped,
				appliedConfigs: sync.appliedConfigs ? JSON.parse(sync.appliedConfigs) : null,
				failedConfigs: sync.failedConfigs ? JSON.parse(sync.failedConfigs) : null,
				errorLog: sync.errorLog,
				backupId: sync.backupId,
			});
		});

		/**
		 * Rollback to backup
		 * POST /api/trash-guides/sync/:syncId/rollback
		 */
		app.post<{
			Params: { syncId: string };
		}>("/:syncId/rollback", async (request, reply) => {
			const { syncId } = request.params;
			const userId = request.currentUser?.id || "";

			// Get sync record with backup
			const sync = await app.prisma.trashSyncHistory.findFirst({
				where: {
					id: syncId,
				},
				include: {
					backup: true,
					instance: true,
					template: true,
				},
			});

			if (!sync) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Sync not found or access denied",
				});
			}

			if (!sync.backupId || !sync.backup) {
				return reply.status(400).send({
					error: "NO_BACKUP",
					message: "No backup available for this sync operation",
				});
			}

			if (sync.rolledBack) {
				return reply.status(400).send({
					error: "ALREADY_ROLLED_BACK",
					message: "This sync has already been rolled back",
				});
			}

			// TODO: Implement rollback using deployment executor
			return reply.status(501).send({
				error: "NOT_IMPLEMENTED",
				message: "Rollback functionality is not yet implemented with the new sync engine",
			});

			/* Rollback implementation (disabled until deployment executor supports it):
			try {
				// Create API client
				const apiClient = createArrApiClient(sync.instance, app.encryptor);

				// Get current Custom Formats to understand what changed
				const currentFormats = await apiClient.getCustomFormats();

				// Parse applied configs from sync history
				const appliedConfigs = sync.appliedConfigs ? JSON.parse(sync.appliedConfigs) : [];
				const appliedNames = new Set(appliedConfigs.map((c: any) => c.name));

				let restoredCount = 0;
				let failedCount = 0;
				const errors: string[] = [];

				// Step 1: Delete Custom Formats that were created/updated during sync
				for (const currentFormat of currentFormats) {
					if (appliedNames.has(currentFormat.name)) {
						try {
							if (currentFormat.id) {
								await apiClient.deleteCustomFormat(currentFormat.id);
							}
						} catch (deleteError) {
							errors.push(`Failed to delete ${currentFormat.name}: ${deleteError instanceof Error ? deleteError.message : "Unknown error"}`);
							failedCount++;
						}
					}
				}

				// Step 2: Restore Custom Formats from backup
				const backupData = JSON.parse(sync.backup.data);
				for (const backupFormat of backupData.customFormats) {
					try {
						await apiClient.createCustomFormat(backupFormat as any);
						restoredCount++;
					} catch (restoreError) {
						errors.push(`Failed to restore ${(backupFormat as any).name}: ${restoreError instanceof Error ? restoreError.message : "Unknown error"}`);
						failedCount++;
					}
				}

				// Update sync history to mark as rolled back
				await app.prisma.trashSyncHistory.update({
					where: { id: syncId },
					data: {
						rolledBack: true,
						rolledBackAt: new Date(),
					},
				});

				return reply.send({
					success: failedCount === 0,
					restoredCount,
					failedCount,
					errors,
				});
			} catch (error) {
				return reply.status(500).send({
					error: "ROLLBACK_FAILED",
					message: error instanceof Error ? error.message : "Rollback failed",
				});
			}
			*/
		});
}
