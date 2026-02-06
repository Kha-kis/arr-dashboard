/**
 * TRaSH Guides Sync Routes
 *
 * API endpoints for template synchronization to Radarr/Sonarr instances
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import { createSyncEngine } from "../../lib/trash-guides/sync-engine.js";
import type { SyncProgress } from "../../lib/trash-guides/sync-engine.js";
import { getSyncMetrics } from "../../lib/trash-guides/sync-metrics.js";
import { createTemplateUpdater } from "../../lib/trash-guides/template-updater.js";
import { safeJsonParse } from "../../lib/utils/json.js";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";

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
	conflictResolutions: z.record(z.string(), z.enum(["REPLACE", "SKIP"])).optional(),
});

const syncHistoryQuerySchema = z.object({
	limit: z
		.string()
		.optional()
		.transform((val) => (val ? Number.parseInt(val, 10) : 20)),
	offset: z
		.string()
		.optional()
		.transform((val) => (val ? Number.parseInt(val, 10) : 0)),
});

// ============================================================================
// In-Memory Progress Tracking (temporary - will move to Redis/cache later)
// ============================================================================

const progressStore = new Map<string, SyncProgress>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

// TTL for progress entries (5 minutes - enough time for clients to poll/reconnect)
const PROGRESS_TTL_MS = 5 * 60 * 1000;

/**
 * Schedule cleanup of a progress entry after TTL expires.
 * Cancels any existing timer for the same syncId to avoid duplicate cleanups.
 */
function scheduleProgressCleanup(syncId: string, ttlMs: number = PROGRESS_TTL_MS): void {
	// Cancel existing timer if present
	const existingTimer = cleanupTimers.get(syncId);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	// Schedule new cleanup
	const timer = setTimeout(() => {
		progressStore.delete(syncId);
		cleanupTimers.delete(syncId);
	}, ttlMs);

	cleanupTimers.set(syncId, timer);
}

/**
 * Immediately remove a progress entry and cancel its cleanup timer.
 */
function _removeProgress(syncId: string): void {
	const timer = cleanupTimers.get(syncId);
	if (timer) {
		clearTimeout(timer);
		cleanupTimers.delete(syncId);
	}
	progressStore.delete(syncId);
}

// ============================================================================
// Routes
// ============================================================================

export async function registerSyncRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	// Shared services (repo-independent)
	const cacheManager = createCacheManager(app.prisma);
	const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.encryptor);

	/** Create repo-aware services configured for the current user's repo settings */
	async function getServices(userId: string) {
		const repoConfig = await getRepoConfig(app.prisma, userId);
		const versionTracker = createVersionTracker(repoConfig);
		const githubFetcher = createTrashFetcher({ repoConfig, logger: app.log });
		const templateUpdater = createTemplateUpdater(
			app.prisma,
			versionTracker,
			cacheManager,
			githubFetcher,
			deploymentExecutor,
		);
		const syncEngine = createSyncEngine(
			app.prisma,
			templateUpdater,
			deploymentExecutor,
			app.arrClientFactory,
		);
		return { versionTracker, githubFetcher, templateUpdater, syncEngine };
	}

	/**
	 * Validate sync before execution
	 * POST /api/trash-guides/sync/validate
	 */
	app.post("/validate", async (request: FastifyRequest, reply) => {
		const body = validateSyncSchema.parse(request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		const { syncEngine } = await getServices(userId);
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
	app.post("/execute", async (request: FastifyRequest, reply) => {
		const body = executeSyncSchema.parse(request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Convert conflictResolutions object to Map
		const resolutionsMap = body.conflictResolutions
			? new Map(Object.entries(body.conflictResolutions) as [string, "REPLACE" | "SKIP"][])
			: undefined;

		// Execute sync - this will complete synchronously
		const { syncEngine } = await getServices(userId);
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
		// Schedule cleanup to prevent memory leak
		scheduleProgressCleanup(result.syncId);

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

		// Hijack the response to prevent Fastify from sending its own response
		reply.hijack();

		// Set SSE headers
		reply.raw.setHeader("Content-Type", "text/event-stream");
		reply.raw.setHeader("Cache-Control", "no-cache");
		reply.raw.setHeader("Connection", "keep-alive");
		reply.raw.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

		// Send initial connection message
		reply.raw.write('data: {"type":"connected"}\n\n');

		// Set up progress callback to stream updates
		const streamProgress = (progress: SyncProgress) => {
			if (!reply.raw.destroyed) {
				reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);

				// Close stream when completed or failed
				if (progress.status === "COMPLETED" || progress.status === "FAILED") {
					setTimeout(() => {
						if (!reply.raw.destroyed) {
							reply.raw.end();
						}
					}, 1000); // Give client time to process final message
				}
			}
		};

		// Register callback FIRST to avoid race condition where sync completes
		// between registration and currentProgress check
		const { syncEngine } = await getServices(request.currentUser!.id);
		syncEngine.onProgress(syncId, streamProgress);

		// Set up cleanup handler immediately after registration to ensure
		// listener is always removed on client disconnect (even on early return)
		request.raw.on("close", () => {
			// Remove the progress listener to prevent memory leaks
			syncEngine.removeProgressListener(syncId, streamProgress);
			if (!reply.raw.destroyed) {
				reply.raw.end();
			}
		});

		// Now check current progress - callback is already registered so we won't miss updates
		const currentProgress = progressStore.get(syncId);
		if (currentProgress) {
			streamProgress(currentProgress);
		} else {
			// No progress found, remove listener and send error
			syncEngine.removeProgressListener(syncId, streamProgress);
			reply.raw.write(`data: ${JSON.stringify({ type: "error", message: "Sync not found" })}\n\n`);
			reply.raw.end();
			return;
		}
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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Verify instance exists and is owned by the current user.
		// Including userId in the where clause ensures non-owned instances return null,
		// preventing instance enumeration attacks (all non-owned instances return 404).
		// Sync history is filtered by userId (line 279) to ensure user-specific access.
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: instanceId,
				userId,
			},
		});

		if (!instance) {
			return reply.status(404).send({
				error: "NOT_FOUND",
				message: "Instance not found",
			});
		}

		// Get sync history for this user and instance
		const [syncs, total] = await Promise.all([
			app.prisma.trashSyncHistory.findMany({
				where: { instanceId, userId },
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
				where: { instanceId, userId },
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
		const userId = request.currentUser!.id;

		const sync = await app.prisma.trashSyncHistory.findFirst({
			where: {
				id: syncId,
				userId,
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
				message: "Sync not found",
			});
		}

		return reply.send({
			id: sync.id,
			templateId: sync.templateId,
			templateName: sync.template?.name || "",
			instanceId: sync.instanceId,
			instanceName: sync.instance?.label || "",
			status: sync.status,
			syncType: sync.syncType,
			startedAt: sync.startedAt.toISOString(),
			completedAt: sync.completedAt?.toISOString() || null,
			duration: sync.duration,
			configsApplied: sync.configsApplied,
			configsFailed: sync.configsFailed,
			configsSkipped: sync.configsSkipped,
			appliedConfigs: safeJsonParse(sync.appliedConfigs),
			failedConfigs: safeJsonParse(sync.failedConfigs),
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
		const userId = request.currentUser!.id;

		// Get sync record with backup (narrowed to current user for ownership check)
		const sync = await app.prisma.trashSyncHistory.findFirst({
			where: {
				id: syncId,
				userId,
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
				message: "Sync not found",
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

		// Start metrics tracking
		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("rollback");

		try {
			// Create SDK client using factory
			const client = app.arrClientFactory.create(sync.instance) as SonarrClient | RadarrClient;

			// Parse backup data (contains the pre-sync state)
			// Note: deployment-executor stores backupData as a raw array of CFs, not an object
			interface BackupCustomFormat {
				id?: number;
				name: string;
				specifications?: unknown[];
				includeCustomFormatWhenRenaming?: boolean;
				trash_id?: string;
			}

			let backupCFs: BackupCustomFormat[];
			try {
				const parsed = JSON.parse(sync.backup.backupData);
				// Handle both formats: raw array (deployment-executor) or object with customFormats (backup-manager)
				backupCFs = Array.isArray(parsed) ? parsed : (parsed.customFormats ?? []);
			} catch {
				return reply.status(400).send({
					error: "INVALID_BACKUP",
					message: "Backup data is corrupted or invalid",
				});
			}

			// Parse appliedConfigs to know which CFs were CREATED by the sync (not just updated)
			// We only delete CFs that were created, not ones that existed before
			interface AppliedConfig {
				name: string;
				action?: "created" | "updated";
			}
			let appliedConfigs: AppliedConfig[] = [];
			try {
				if (sync.appliedConfigs) {
					appliedConfigs = JSON.parse(sync.appliedConfigs) as AppliedConfig[];
				}
			} catch {
				// If we can't parse appliedConfigs, we'll skip the deletion step for safety
				request.log.warn({ syncId }, "Could not parse appliedConfigs, skipping CF deletion");
			}

			// Build set of CF names that were CREATED (not updated) by the sync
			const createdBySyncNames = new Set<string>();
			for (const config of appliedConfigs) {
				// Only add if explicitly marked as created, or if no action field (legacy: assume created)
				if (config.action === "created" || !config.action) {
					createdBySyncNames.add(config.name);
				}
			}
			// Also check backup - if a CF was "created" but exists in backup, it was actually updated
			const backupNames = new Set(backupCFs.map((cf) => cf.name));
			for (const name of createdBySyncNames) {
				if (backupNames.has(name)) {
					createdBySyncNames.delete(name); // Was in backup, so it was updated not created
				}
			}

			// Get current Custom Formats from instance
			const currentFormats = await client.customFormat.getAll();

			// Build lookup maps by name
			const backupByName = new Map<string, BackupCustomFormat>();
			for (const cf of backupCFs) {
				backupByName.set(cf.name, cf);
			}

			const currentByName = new Map<string, (typeof currentFormats)[0]>();
			for (const cf of currentFormats) {
				if (cf.name) {
					currentByName.set(cf.name, cf);
				}
			}

			let restoredCount = 0;
			let deletedCount = 0;
			let failedCount = 0;
			const errors: string[] = [];

			// Step 1: Update or restore Custom Formats that existed in backup
			for (const [name, backupFormat] of backupByName) {
				const currentFormat = currentByName.get(name);
				// Remove trash_id for ARR API compatibility
				const { trash_id: _trashId, ...formatWithoutTrashId } = backupFormat;

				try {
					if (currentFormat?.id) {
						// CF exists in instance - update it to match backup
						// Use current instance ID, not backup ID
						const { id: _backupId, ...formatData } = formatWithoutTrashId;
						await client.customFormat.update(currentFormat.id, {
							...formatData,
							id: currentFormat.id,
						} as Parameters<typeof client.customFormat.update>[1]);
						restoredCount++;
					} else {
						// CF was deleted during sync - recreate it
						// Remove id for creation (ARR assigns new ID)
						const { id: _id, ...formatData } = formatWithoutTrashId;
						await client.customFormat.create(
							formatData as Parameters<typeof client.customFormat.create>[0],
						);
						restoredCount++;
					}
				} catch (error) {
					errors.push(
						`Failed to restore "${name}": ${error instanceof Error ? error.message : "Unknown error"}`,
					);
					failedCount++;
				}
			}

			// Step 2: Delete ONLY Custom Formats that were CREATED by the sync (not user-created ones)
			for (const [name, currentFormat] of currentByName) {
				// Only delete if: not in backup AND was created by sync AND has valid ID
				if (!backupByName.has(name) && createdBySyncNames.has(name) && currentFormat.id) {
					try {
						await client.customFormat.delete(currentFormat.id);
						deletedCount++;
					} catch (error) {
						errors.push(
							`Failed to delete "${name}": ${error instanceof Error ? error.message : "Unknown error"}`,
						);
						failedCount++;
					}
				}
			}

			// Mark sync as rolled back
			await app.prisma.trashSyncHistory.update({
				where: { id: syncId },
				data: {
					rolledBack: true,
					rolledBackAt: new Date(),
				},
			});

			request.log.info(
				{
					syncId,
					restoredCount,
					deletedCount,
					failedCount,
					userId,
				},
				"Sync rollback completed",
			);

			// Record metrics
			const metricsResult = completeMetrics();
			if (failedCount === 0) {
				metricsResult.recordSuccess();
			} else {
				metricsResult.recordFailure(errors[0]);
			}

			return reply.send({
				success: failedCount === 0,
				restoredCount,
				deletedCount,
				failedCount,
				errors: errors.length > 0 ? errors : undefined,
				message:
					failedCount === 0
						? `Successfully rolled back: ${restoredCount} restored, ${deletedCount} deleted`
						: `Rollback completed with errors: ${restoredCount} restored, ${deletedCount} deleted, ${failedCount} failed`,
			});
		} catch (error) {
			// Record failure metrics
			const errorMessage = error instanceof Error ? error.message : "Rollback failed";
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);

			request.log.error({ error, syncId }, "Sync rollback failed");
			return reply.status(500).send({
				error: "ROLLBACK_FAILED",
				message: errorMessage,
			});
		}
	});

	/**
	 * Get sync operation metrics
	 * GET /api/trash-guides/sync/metrics
	 */
	app.get("/metrics", async (_request, reply) => {
		const metrics = getSyncMetrics();
		const snapshot = metrics.getSnapshot();

		return reply.send(snapshot);
	});
}
