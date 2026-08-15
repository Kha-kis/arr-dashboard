/**
 * TRaSH Guides Sync Routes
 *
 * API endpoints for template synchronization to Radarr/Sonarr instances
 */

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-executor.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import {
	assertSharedDeploymentRestorationAllowed,
	assertSharedDeploymentState,
	getExpectedSharedDeploymentStateToken,
	resolveActiveDeploymentOwnership,
} from "../../lib/trash-guides/deployment-active-ownership.js";
import { parseDeploymentBackupState } from "../../lib/trash-guides/deployment-backup-state.js";
import {
	type CustomFormatRollbackState,
	rollbackCustomFormatDeployment,
} from "../../lib/trash-guides/deployment-custom-format-state.js";
import { restoreNamingDeployment } from "../../lib/trash-guides/deployment-naming-state.js";
import { createDeploymentPreviewService } from "../../lib/trash-guides/deployment-preview.js";
import {
	type QualityProfileRollbackState,
	rollbackQualityProfileDeployment,
} from "../../lib/trash-guides/deployment-profile-state.js";
import {
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
	getEquivalentServiceInstanceIds,
	isDeploymentBackupEndpointIdentityCurrent,
} from "../../lib/trash-guides/deployment-target.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import type { SyncProgress } from "../../lib/trash-guides/sync-engine.js";
import { createSyncEngine } from "../../lib/trash-guides/sync-engine.js";
import { getSyncMetrics } from "../../lib/trash-guides/sync-metrics.js";
import { createTemplateUpdater } from "../../lib/trash-guides/template-updater.js";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { safeJsonParse } from "../../lib/utils/json.js";
import { validateRequest } from "../../lib/utils/validate.js";

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
	syncType: z.literal("MANUAL").optional(),
	conflictResolutions: z.record(z.string(), z.enum(["REPLACE", "SKIP"])).optional(),
	executionToken: z.string().length(64),
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

const rollbackAppliedConfigsSchema = z.array(
	z
		.object({
			name: z.string().trim().min(1),
			action: z.enum(["created", "updated"]).optional(),
			type: z.enum(["custom_format", "quality_profile", "naming"]).optional(),
			id: z.number().int().optional(),
			fields: z.number().int().nonnegative().optional(),
		})
		.passthrough(),
);

type AppliedConfig = z.infer<typeof rollbackAppliedConfigsSchema>[number];

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

interface AppliedRollbackConfig {
	name?: unknown;
	action?: unknown;
	type?: unknown;
}

/**
 * Return only Custom Formats that a sync positively identified as created.
 * Untyped entries remain supported for legacy histories; typed non-CF entries
 * fail closed so a quality profile or naming record can never authorize a CF delete.
 */
export function getCreatedCustomFormatNamesForRollback(value: unknown): Set<string> {
	if (!Array.isArray(value)) return new Set();
	const names = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const config = entry as AppliedRollbackConfig;
		if (Object.hasOwn(config, "type") && config.type !== "custom_format") continue;
		if (typeof config.name !== "string") continue;
		if (config.action === "created" || config.action === undefined) names.add(config.name);
	}
	return names;
}

interface RollbackStep {
	key: string;
	kind: "quality_profile" | "custom_format" | "naming" | "legacy";
	name: string;
	outcome: "restored" | "deleted" | "already_reversed" | "skipped_shared" | "failed";
	error?: string;
}

function parseRollbackProgress(value: string | null): RollbackStep[] {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("Rollback progress is not an array.");
	return parsed.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof Reflect.get(item, "kind") !== "string" ||
			typeof Reflect.get(item, "name") !== "string" ||
			typeof Reflect.get(item, "outcome") !== "string"
		) {
			throw new Error("Rollback progress contains an invalid step.");
		}
		const step = item as Omit<RollbackStep, "key"> & { key?: unknown };
		return {
			...step,
			key:
				typeof step.key === "string" && step.key.length > 0
					? step.key
					: `legacy:${step.kind}:${step.name}`,
		};
	});
}

// ============================================================================
// Routes
// ============================================================================

export async function registerSyncRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// Shared services (repo-independent)
	const cacheManager = createCacheManager(app.prisma);
	const { deploymentExecutor } = app;
	async function ownsSyncTarget(userId: string, templateId: string, instanceId: string) {
		const [template, instance] = await Promise.all([
			app.prisma.trashTemplate.findFirst({
				where: { id: templateId, userId, deletedAt: null },
				select: { id: true },
			}),
			app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				select: { id: true },
			}),
		]);
		return Boolean(template && instance);
	}

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
		const body = validateRequest(validateSyncSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth
		if (!(await ownsSyncTarget(userId, body.templateId, body.instanceId))) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Sync target not found",
			});
		}

		const { syncEngine, templateUpdater } = await getServices(userId);
		const templateSync = await templateUpdater.syncTemplate(body.templateId, undefined, userId);
		if (!templateSync.success) {
			return reply.send({
				valid: false,
				conflicts: [],
				errors: [`Template sync failed: ${templateSync.errors?.join(", ") || "Unknown error"}`],
				warnings: [],
			});
		}
		const validation = await syncEngine.validate({
			templateId: body.templateId,
			instanceId: body.instanceId,
			userId,
			syncType: "MANUAL",
		});

		if (!validation.valid) return reply.send(validation);
		const preview = await createDeploymentPreviewService(
			app.prisma,
			app.arrClientFactory,
			app.log,
		).generatePreview(body.templateId, body.instanceId, userId);
		return reply.send({
			...validation,
			executionToken: preview.executionToken,
			preview,
		});
	});

	/**
	 * Execute sync operation
	 * POST /api/trash-guides/sync/execute
	 */
	app.post("/execute", async (request: FastifyRequest, reply) => {
		const body = validateRequest(executeSyncSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth
		if (!(await ownsSyncTarget(userId, body.templateId, body.instanceId))) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Sync target not found",
			});
		}

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
				syncType: "MANUAL",
			},
			resolutionsMap,
			body.executionToken,
		);

		// By the time we get here, sync is complete. Store final state in progress store
		// so that polling endpoints can retrieve it
		const finalProgress: SyncProgress = {
			syncId: result.syncId,
			status:
				result.status === "SUCCESS"
					? "COMPLETED"
					: result.status === "UNCERTAIN"
						? "UNCERTAIN"
						: "FAILED",
			currentStep:
				result.status === "UNCERTAIN"
					? "Sync result is uncertain; resolve or roll back before retrying"
					: result.status === "SUCCESS"
						? result.warnings?.length
							? `Sync completed with warnings: ${result.warnings.join("; ")}`
							: `Sync completed: ${result.configsApplied} applied, ${result.configsFailed} failed`
						: result.status === "PARTIAL_SUCCESS"
							? `Sync completed with errors: ${result.configsApplied} applied, ${result.configsFailed} failed`
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

		request.log.info({ templateId: body.templateId, instanceId: body.instanceId }, "Sync executed");

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
				if (
					progress.status === "COMPLETED" ||
					progress.status === "FAILED" ||
					progress.status === "UNCERTAIN"
				) {
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
		const query = validateRequest(syncHistoryQuerySchema, request.query);
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Verify instance exists and is owned by the current user.
		// Including userId in the where clause ensures non-owned instances return null,
		await requireInstance(app, userId, instanceId);

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
	 * List backup-less uncertain syncs that require explicit administrator review.
	 * These rows survive restarts and continue to block ARR writes until reviewed.
	 */
	app.get("/review-needed", async (request, reply) => {
		const userId = request.currentUser!.id;
		const syncs = await app.prisma.trashSyncHistory.findMany({
			where: { userId, status: "UNCERTAIN", backupId: null },
			select: {
				id: true,
				templateId: true,
				instanceId: true,
				startedAt: true,
				errorLog: true,
				template: { select: { name: true } },
				instance: { select: { label: true } },
			},
			orderBy: { startedAt: "asc" },
		});

		return reply.send({
			syncs: syncs.map((sync) => ({
				id: sync.id,
				templateId: sync.templateId,
				templateName: sync.template?.name || "",
				instanceId: sync.instanceId,
				instanceName: sync.instance?.label || "",
				startedAt: sync.startedAt.toISOString(),
				errorLog: sync.errorLog,
			})),
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
	 * Acknowledge a legacy interrupted wrapper that has no rollback ledger.
	 * This never claims rollback or mutates ARR; it records the administrator's
	 * explicit manual review so the unresolved local gate can be released.
	 */
	app.post<{
		Params: { syncId: string };
	}>("/:syncId/acknowledge-review", async (request, reply) => {
		const { syncId } = request.params;
		const userId = request.currentUser!.id;
		const sync = await app.prisma.trashSyncHistory.findFirst({
			where: { id: syncId, userId },
			select: { status: true, backupId: true, errorLog: true },
		});

		if (!sync) {
			return reply.status(404).send({ error: "NOT_FOUND", message: "Sync not found" });
		}
		if (sync.status !== "UNCERTAIN" || sync.backupId !== null) {
			return reply.status(409).send({
				error: "REVIEW_NOT_ACKNOWLEDGEABLE",
				message: "Only an uncertain sync without a rollback ledger can be acknowledged manually.",
			});
		}

		const reviewedAt = new Date();
		const reviewMessage = `Manual review acknowledged at ${reviewedAt.toISOString()}. No automatic rollback was performed; the administrator accepted the current ARR state.`;
		const updated = await app.prisma.trashSyncHistory.updateMany({
			where: { id: syncId, userId, status: "UNCERTAIN", backupId: null },
			data: {
				status: "FAILED",
				completedAt: reviewedAt,
				errorLog: sync.errorLog ? `${sync.errorLog}\n${reviewMessage}` : reviewMessage,
			},
		});
		if (updated.count !== 1) {
			return reply.status(409).send({
				error: "REVIEW_STATE_CHANGED",
				message: "The sync changed while manual review was being acknowledged. Refresh and retry.",
			});
		}

		request.log.warn({ syncId }, "Backup-less uncertain sync manually acknowledged");
		return reply.send({
			success: true,
			status: "FAILED",
			message: "Manual review acknowledged. No automatic rollback was performed.",
		});
	});

	/**
	 * Rollback to backup
	 * POST /api/trash-guides/sync/:syncId/rollback
	 *
	 * NOTE: Specialized catch block KEPT — records sync metrics on failure
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

		const rollbackAttemptedAt = new Date();
		const claim = await app.prisma.trashSyncHistory.updateMany({
			where: {
				id: syncId,
				userId,
				rolledBack: false,
				OR: [{ rollbackStatus: null }, { rollbackStatus: "PARTIAL" }],
			},
			data: {
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt,
			},
		});

		if (claim.count !== 1) {
			return reply.status(409).send({
				error: "ROLLBACK_IN_PROGRESS",
				message: "A rollback is already in progress for this sync operation",
			});
		}

		const persistPartialRollback = async () => {
			const result = await app.prisma.trashSyncHistory.updateMany({
				where: {
					id: syncId,
					userId,
					rolledBack: false,
					rollbackStatus: "IN_PROGRESS",
					rollbackAttemptedAt,
				},
				data: {
					rollbackStatus: "PARTIAL",
				},
			});
			if (result.count !== 1) {
				throw new Error("Rollback recovery state changed before progress could be persisted");
			}
		};
		const stopClaimedRollback = async (
			statusCode: number,
			payload: { error: string; message: string },
		) => {
			await persistPartialRollback();
			return reply.status(statusCode).send(payload);
		};

		// Start metrics tracking
		const metrics = getSyncMetrics();
		const completeMetrics = metrics.startOperation("rollback");

		try {
			return await withCleanupTopologyMutationLease(
				{ prisma: app.prisma, log: request.log },
				userId,
				() =>
					app.deploymentExecutor.runWithEndpointMutation(
						userId,
						sync.instance,
						"Rollback",
						async (endpointKey) => {
							const sync = await app.prisma.trashSyncHistory.findFirst({
								where: { id: syncId, userId },
								include: { backup: true, instance: true, template: true },
							});
							if (!sync) {
								return reply.status(404).send({
									error: "NOT_FOUND",
									message: "Sync not found",
								});
							}
							if (!sync.backupId || !sync.backup) {
								return stopClaimedRollback(400, {
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
							const backup = sync.backup;
							const currentInstance = await app.prisma.serviceInstance.findFirst({
								where: { id: sync.instanceId, userId },
							});
							const leasedCredentialIdentity = currentInstance
								? app.arrClientFactory.createConnectionCredentialIdentity(currentInstance)
								: null;
							if (
								!currentInstance ||
								createDeploymentEndpointKey(userId, {
									service: currentInstance.service,
									baseUrl: currentInstance.baseUrl,
									credentialIdentity: leasedCredentialIdentity!,
								}) !== endpointKey
							) {
								return stopClaimedRollback(409, {
									error: "ROLLBACK_TARGET_CHANGED",
									message: "The ARR service connection changed while rollback was starting.",
								});
							}

							let rawBackup: unknown;
							try {
								rawBackup = JSON.parse(backup.backupData);
							} catch (error) {
								request.log.warn(
									{ syncId, err: error },
									"Failed to parse backup data for rollback",
								);
								return stopClaimedRollback(400, {
									error: "INVALID_BACKUP",
									message: "Backup data is corrupted or invalid",
								});
							}
							const isV2Backup =
								typeof rawBackup === "object" &&
								rawBackup !== null &&
								!Array.isArray(rawBackup) &&
								Reflect.get(rawBackup, "schemaVersion") === 2;
							if (!isV2Backup) {
								return stopClaimedRollback(409, {
									error: "LEGACY_BACKUP_UNVERIFIED",
									message:
										"This legacy backup does not contain the endpoint and resource identity needed for a safe automatic rollback. Restore it manually after verifying the ARR instance and each target resource.",
								});
							}
							// Parse backup data (contains the pre-sync state)
							let backupEndpointKey = "";
							let backupConnectionStateToken = "";
							let backupCustomFormatDeployments: CustomFormatRollbackState[] = [];
							let backupQualityProfileDeployment: QualityProfileRollbackState | null = null;
							let backupNamingDeployment: {
								beforeConfig: Record<string, unknown>;
								postStateToken: string;
							} | null = null;
							let hasUnknownNamingDeployment = false;
							try {
								const parsed = parseDeploymentBackupState(backup.backupData);
								backupEndpointKey = parsed.endpointKey;
								backupConnectionStateToken = parsed.connectionStateToken;
								backupCustomFormatDeployments =
									parsed.customFormatDeployments as CustomFormatRollbackState[];
								if (parsed.qualityProfileDeployment.status !== "not_started") {
									backupQualityProfileDeployment =
										parsed.qualityProfileDeployment as QualityProfileRollbackState;
								}
								hasUnknownNamingDeployment =
									parsed.namingDeployment?.status === "pending" &&
									!parsed.namingDeployment.intendedPostStateToken;
								if (
									parsed.namingDeployment?.status === "pending" &&
									parsed.namingDeployment.intendedPostStateToken
								) {
									backupNamingDeployment = {
										beforeConfig: parsed.namingDeployment.beforeConfig,
										postStateToken: parsed.namingDeployment.intendedPostStateToken,
									};
								}
								if (parsed.namingDeployment?.status === "applied") {
									backupNamingDeployment = {
										beforeConfig: parsed.namingDeployment.beforeConfig,
										postStateToken: parsed.namingDeployment.postStateToken!,
									};
								}
							} catch (error) {
								request.log.warn(
									{ syncId, err: error },
									"Failed to parse backup data for rollback",
								);
								return stopClaimedRollback(400, {
									error: "INVALID_BACKUP",
									message: "Backup data is corrupted or invalid",
								});
							}
							if (
								!isDeploymentBackupEndpointIdentityCurrent({
									userId,
									backupEndpointKey,
									backupConnectionStateToken,
									instance: currentInstance,
									credentialIdentity: leasedCredentialIdentity!,
								})
							) {
								return stopClaimedRollback(409, {
									error: "ROLLBACK_TARGET_CHANGED",
									message:
										"The backup is not bound to this ARR service connection, so rollback was stopped.",
								});
							}
							if (!sync.templateId || !sync.backupId) {
								return stopClaimedRollback(409, {
									error: "ROLLBACK_OWNERSHIP_UNKNOWN",
									message: "The rollback history is missing durable deployment ownership metadata.",
								});
							}
							const aliases = await app.prisma.serviceInstance.findMany({
								where: { userId, service: currentInstance.service },
							});
							const currentCredentialIdentity =
								app.arrClientFactory.createConnectionCredentialIdentity(currentInstance);
							const equivalentInstanceIds = getEquivalentServiceInstanceIds(
								aliases.map((alias) => ({
									...alias,
									credentialIdentity:
										app.arrClientFactory.createConnectionCredentialIdentity(alias),
								})),
								{ ...currentInstance, credentialIdentity: currentCredentialIdentity },
							);
							if (!equivalentInstanceIds.includes(currentInstance.id)) {
								equivalentInstanceIds.push(currentInstance.id);
							}
							const ownership = await resolveActiveDeploymentOwnership(
								app.prisma,
								userId,
								equivalentInstanceIds,
								{ backupId: sync.backupId, templateId: sync.templateId },
							);
							const client = app.arrClientFactory.create(currentInstance) as
								| SonarrClient
								| RadarrClient;

							let appliedConfigs: AppliedConfig[] = [];
							try {
								if (sync.appliedConfigs) {
									appliedConfigs = rollbackAppliedConfigsSchema.parse(
										JSON.parse(sync.appliedConfigs),
									);
								}
							} catch (error) {
								request.log.warn(
									{ syncId, err: error },
									"Could not parse rollback ownership evidence",
								);
								throw new Error(
									"Rollback ownership evidence is invalid; no created Custom Formats were deleted",
								);
							}

							let restoredCount = 0;
							let deletedCount = 0;
							let failedCount = 0;
							let skippedSharedCount = 0;
							let stopAfterProfileFailure = false;
							let existingRollbackSteps: RollbackStep[];
							try {
								existingRollbackSteps = parseRollbackProgress(sync.rollbackProgress);
							} catch (error) {
								request.log.warn({ syncId, err: error }, "Invalid rollback progress rejected");
								return stopClaimedRollback(409, {
									error: "INVALID_ROLLBACK_PROGRESS",
									message:
										"The saved rollback progress is invalid, so no upstream changes were made.",
								});
							}
							const stepByKey = new Map(existingRollbackSteps.map((step) => [step.key, step]));
							const setStep = (step: RollbackStep): void => {
								for (const [existingKey, existing] of stepByKey) {
									if (
										existingKey !== step.key &&
										existing.kind === step.kind &&
										existing.name === step.name
									) {
										stepByKey.delete(existingKey);
									}
								}
								stepByKey.set(step.key, step);
							};
							const isFinished = (
								key: string,
								kind: RollbackStep["kind"],
								name: string,
							): boolean => {
								const step =
									stepByKey.get(key) ??
									[...stepByKey.values()].find(
										(candidate) => candidate.kind === kind && candidate.name === name,
									);
								return Boolean(
									step &&
										(step.outcome === "restored" ||
											step.outcome === "deleted" ||
											step.outcome === "already_reversed" ||
											step.outcome === "skipped_shared"),
								);
							};
							const rollbackAttemptedAt = new Date();
							const persistRollbackProgress = async (
								rollbackStatus: "IN_PROGRESS" | "PARTIAL",
							): Promise<void> => {
								const rollbackProgress = JSON.stringify([...stepByKey.values()]);
								await app.prisma.$transaction(async (tx) => {
									await tx.trashSyncHistory.updateMany({
										where: { backupId: sync.backupId, userId, rolledBack: false },
										data: { rollbackStatus, rollbackAttemptedAt, rollbackProgress },
									});
									await tx.templateDeploymentHistory.updateMany({
										where: { backupId: sync.backupId, userId },
										data: {
											undeployStatus: rollbackStatus,
											undeployAttemptedAt: rollbackAttemptedAt,
											undeployProgress: rollbackProgress,
										},
									});
								});
							};
							await persistRollbackProgress("IN_PROGRESS");
							if (
								hasUnknownNamingDeployment &&
								!isFinished("naming:configuration", "naming", "Naming configuration")
							) {
								const unknownStateError =
									"Naming may have been changed, but its post-deployment state was not verified. It was not restored automatically.";
								if (ownership.namingOwnedByAnotherDeployment) {
									try {
										const currentResponse = await app.arrClientFactory.rawRequest(
											currentInstance,
											"/api/v3/config/naming",
										);
										if (!currentResponse.ok) throw new Error(`HTTP ${currentResponse.status}`);
										const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
										const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
											ownership.sharedNamingStateTokens,
											"naming configuration",
										);
										if (createUpstreamResourceStateToken(currentConfig) !== expectedSurvivorToken) {
											throw new Error(unknownStateError);
										}
										setStep({
											key: "naming:configuration",
											kind: "naming",
											name: "Naming configuration",
											outcome: "skipped_shared",
										});
									} catch (error) {
										setStep({
											key: "naming:configuration",
											kind: "naming",
											name: "Naming configuration",
											outcome: "failed",
											error: `${unknownStateError} ${getErrorMessage(error, "Unknown error")}`,
										});
									}
								} else {
									setStep({
										key: "naming:configuration",
										kind: "naming",
										name: "Naming configuration",
										outcome: "failed",
										error: unknownStateError,
									});
								}
								await persistRollbackProgress("IN_PROGRESS");
							}

							// Restore the profile before any CF deletion. ARR may remove profile
							// references when a Custom Format is deleted, invalidating this snapshot.
							const profileStepName =
								backupQualityProfileDeployment?.profileName ?? "Quality profile";
							const profileStepKey = backupQualityProfileDeployment
								? `quality_profile:${backupQualityProfileDeployment.profileId ?? profileStepName}`
								: "quality_profile:none";
							if (
								backupQualityProfileDeployment &&
								!isFinished(profileStepKey, "quality_profile", profileStepName) &&
								backupQualityProfileDeployment.profileId !== null &&
								ownership.sharedQualityProfileIds.has(backupQualityProfileDeployment.profileId)
							) {
								try {
									const currentProfile = await client.qualityProfile.getById(
										backupQualityProfileDeployment.profileId,
									);
									const resourceLabel = `quality profile "${backupQualityProfileDeployment.profileName ?? backupQualityProfileDeployment.profileId}"`;
									const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
										ownership.sharedQualityProfileStateTokens.get(
											backupQualityProfileDeployment.profileId,
										),
										resourceLabel,
									);
									if (createQualityProfileStateToken(currentProfile) === expectedSurvivorToken) {
										setStep({
											key: profileStepKey,
											kind: "quality_profile",
											name: profileStepName,
											outcome: "skipped_shared",
										});
									} else {
										assertSharedDeploymentRestorationAllowed(
											ownership.restorableSharedQualityProfileIds.has(
												backupQualityProfileDeployment.profileId,
											),
											resourceLabel,
										);
										if (backupQualityProfileDeployment.action === "created") {
											throw new Error(
												`${resourceLabel} is shared, but this deployment has no prior state from which to restore the surviving deployment state.`,
											);
										}
										await rollbackQualityProfileDeployment(client, backupQualityProfileDeployment);
										const restoredProfile = await client.qualityProfile.getById(
											backupQualityProfileDeployment.profileId,
										);
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createQualityProfileStateToken(restoredProfile),
											resourceLabel,
										);
										setStep({
											key: profileStepKey,
											kind: "quality_profile",
											name: profileStepName,
											outcome: "restored",
										});
									}
								} catch (error) {
									const message = `Failed to verify shared quality profile: ${getErrorMessage(error, "Unknown error")}`;
									setStep({
										key: profileStepKey,
										kind: "quality_profile",
										name: profileStepName,
										outcome: "failed",
										error: message,
									});
									stopAfterProfileFailure = true;
								}
								await persistRollbackProgress("IN_PROGRESS");
							} else if (
								backupQualityProfileDeployment &&
								!isFinished(profileStepKey, "quality_profile", profileStepName)
							) {
								try {
									await rollbackQualityProfileDeployment(client, backupQualityProfileDeployment);
									request.log.info(
										{
											profileId: backupQualityProfileDeployment.profileId,
											action: backupQualityProfileDeployment.action,
										},
										"Quality profile rollback completed",
									);
									setStep({
										key: profileStepKey,
										kind: "quality_profile",
										name: profileStepName,
										outcome: "restored",
									});
								} catch (error) {
									const message = `Failed to roll back quality profile: ${getErrorMessage(error, "Unknown error")}`;
									setStep({
										key: profileStepKey,
										kind: "quality_profile",
										name: profileStepName,
										outcome: "failed",
										error: message,
									});
									stopAfterProfileFailure = true;
								}
								await persistRollbackProgress("IN_PROGRESS");
							}

							const legacyCustomFormatChanges = appliedConfigs.filter(
								(config) => !config.type && config.fields === undefined,
							);
							if (
								backupCustomFormatDeployments.length === 0 &&
								legacyCustomFormatChanges.length > 0 &&
								!isFinished("legacy:custom_formats", "legacy", "Custom Formats")
							) {
								const error =
									"The backup does not contain identity-bound Custom Format mutation records, so those changes were not rolled back automatically.";
								setStep({
									key: "legacy:custom_formats",
									kind: "legacy",
									name: "Custom Formats",
									outcome: "failed",
									error,
								});
								await persistRollbackProgress("IN_PROGRESS");
							}
							for (const state of stopAfterProfileFailure ? [] : backupCustomFormatDeployments) {
								const stepKey = `custom_format:${state.resourceId ?? state.name}`;
								if (isFinished(stepKey, "custom_format", state.name)) continue;
								if (
									state.resourceId !== null &&
									ownership.sharedCustomFormatIds.has(state.resourceId)
								) {
									try {
										const currentFormat = await client.customFormat.getById(state.resourceId);
										const resourceLabel = `Custom Format "${state.name}"`;
										const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
											ownership.sharedCustomFormatStateTokens.get(state.resourceId),
											resourceLabel,
										);
										if (createUpstreamResourceStateToken(currentFormat) === expectedSurvivorToken) {
											setStep({
												key: stepKey,
												kind: "custom_format",
												name: state.name,
												outcome: "skipped_shared",
											});
										} else {
											assertSharedDeploymentRestorationAllowed(
												ownership.restorableSharedCustomFormatIds.has(state.resourceId),
												resourceLabel,
											);
											if (state.action === "created") {
												throw new Error(
													`${resourceLabel} is shared, but this deployment has no prior state from which to restore the surviving deployment state.`,
												);
											}
											await rollbackCustomFormatDeployment(client, state);
											const restoredFormat = await client.customFormat.getById(state.resourceId);
											assertSharedDeploymentState(
												new Set([expectedSurvivorToken]),
												createUpstreamResourceStateToken(restoredFormat),
												resourceLabel,
											);
											setStep({
												key: stepKey,
												kind: "custom_format",
												name: state.name,
												outcome: "restored",
											});
										}
									} catch (error) {
										const message = `Failed to verify shared Custom Format "${state.name}": ${getErrorMessage(error, "Unknown error")}`;
										setStep({
											key: stepKey,
											kind: "custom_format",
											name: state.name,
											outcome: "failed",
											error: message,
										});
									}
									await persistRollbackProgress("IN_PROGRESS");
									continue;
								}
								try {
									const result = await rollbackCustomFormatDeployment(client, state);
									if (result === "restored") {
										setStep({
											key: stepKey,
											kind: "custom_format",
											name: state.name,
											outcome: "restored",
										});
									}
									if (result === "deleted") {
										setStep({
											key: stepKey,
											kind: "custom_format",
											name: state.name,
											outcome: "deleted",
										});
									}
									if (result === "noop") {
										setStep({
											key: stepKey,
											kind: "custom_format",
											name: state.name,
											outcome: "already_reversed",
										});
									}
								} catch (error) {
									const message = `Failed to roll back Custom Format "${state.name}": ${getErrorMessage(error, "Unknown error")}`;
									setStep({
										key: stepKey,
										kind: "custom_format",
										name: state.name,
										outcome: "failed",
										error: message,
									});
								}
								await persistRollbackProgress("IN_PROGRESS");
							}

							// Step 4: Restore naming configuration if this deployment changed it.
							if (
								backupNamingDeployment &&
								!stopAfterProfileFailure &&
								ownership.namingOwnedByAnotherDeployment &&
								!isFinished("naming:configuration", "naming", "Naming configuration")
							) {
								try {
									const currentResponse = await app.arrClientFactory.rawRequest(
										currentInstance,
										"/api/v3/config/naming",
									);
									if (!currentResponse.ok) throw new Error(`HTTP ${currentResponse.status}`);
									const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
									const expectedSurvivorToken = getExpectedSharedDeploymentStateToken(
										ownership.sharedNamingStateTokens,
										"naming configuration",
									);
									if (createUpstreamResourceStateToken(currentConfig) === expectedSurvivorToken) {
										setStep({
											key: "naming:configuration",
											kind: "naming",
											name: "Naming configuration",
											outcome: "skipped_shared",
										});
									} else {
										assertSharedDeploymentRestorationAllowed(
											ownership.sharedNamingRestorationAllowed,
											"naming configuration",
										);
										await restoreNamingDeployment(
											app.arrClientFactory,
											currentInstance,
											backupNamingDeployment.beforeConfig,
											backupNamingDeployment.postStateToken,
										);
										const restoredResponse = await app.arrClientFactory.rawRequest(
											currentInstance,
											"/api/v3/config/naming",
										);
										if (!restoredResponse.ok) throw new Error(`HTTP ${restoredResponse.status}`);
										const restoredConfig = (await restoredResponse.json()) as Record<
											string,
											unknown
										>;
										assertSharedDeploymentState(
											new Set([expectedSurvivorToken]),
											createUpstreamResourceStateToken(restoredConfig),
											"naming configuration",
										);
										setStep({
											key: "naming:configuration",
											kind: "naming",
											name: "Naming configuration",
											outcome: "restored",
										});
									}
								} catch (error) {
									const message = `Failed to verify shared naming configuration: ${getErrorMessage(error, "Unknown error")}`;
									setStep({
										key: "naming:configuration",
										kind: "naming",
										name: "Naming configuration",
										outcome: "failed",
										error: message,
									});
								}
								await persistRollbackProgress("IN_PROGRESS");
							} else if (
								backupNamingDeployment &&
								!stopAfterProfileFailure &&
								!isFinished("naming:configuration", "naming", "Naming configuration")
							) {
								try {
									await restoreNamingDeployment(
										app.arrClientFactory,
										currentInstance,
										backupNamingDeployment.beforeConfig,
										backupNamingDeployment.postStateToken,
									);
									setStep({
										key: "naming:configuration",
										kind: "naming",
										name: "Naming configuration",
										outcome: "restored",
									});
								} catch (error) {
									const message = `Failed to restore naming configuration: ${getErrorMessage(error, "Unknown error")}`;
									setStep({
										key: "naming:configuration",
										kind: "naming",
										name: "Naming configuration",
										outcome: "failed",
										error: message,
									});
								}
								await persistRollbackProgress("IN_PROGRESS");
							}

							const rollbackSteps = [...stepByKey.values()];
							restoredCount = rollbackSteps.filter((step) => step.outcome === "restored").length;
							deletedCount = rollbackSteps.filter((step) => step.outcome === "deleted").length;
							failedCount = rollbackSteps.filter((step) => step.outcome === "failed").length;
							skippedSharedCount = rollbackSteps.filter(
								(step) => step.outcome === "skipped_shared",
							).length;
							const errors = rollbackSteps.flatMap((step) =>
								step.outcome === "failed" && step.error ? [step.error] : [],
							);

							// Only mark as fully rolled back when all operations succeeded.
							// Partial failures leave rolledBack=false so the user can retry.
							if (failedCount === 0) {
								const rolledBackAt = new Date();
								await app.prisma.$transaction(async (tx) => {
									await tx.trashSyncHistory.updateMany({
										where: { backupId: sync.backupId, userId, rolledBack: false },
										data: {
											rolledBack: true,
											rolledBackAt,
											rollbackStatus: "COMPLETED",
											rollbackAttemptedAt,
											rollbackProgress: JSON.stringify(rollbackSteps),
										},
									});
									if (sync.backupId) {
										await tx.templateDeploymentHistory.updateMany({
											where: { backupId: sync.backupId, userId },
											data: {
												rolledBack: true,
												rolledBackAt,
												rolledBackBy: userId,
												undeployStatus: "COMPLETED",
												undeployAttemptedAt: rollbackAttemptedAt,
												undeployProgress: JSON.stringify(rollbackSteps),
											},
										});
									}
								});
							} else {
								await persistRollbackProgress("PARTIAL");
								request.log.warn(
									{ syncId, failedCount, errors },
									"Partial rollback — not marking as rolled back to allow retry",
								);
							}

							request.log.info(
								{
									syncId,
									restoredCount,
									deletedCount,
									failedCount,
									userId,
								},
								failedCount === 0 ? "Sync rollback completed" : "Sync rollback partially completed",
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
								skippedSharedCount,
								errors: errors.length > 0 ? errors : undefined,
								message:
									failedCount === 0
										? `Successfully rolled back: ${restoredCount} restored, ${deletedCount} deleted`
										: `Rollback completed with errors: ${restoredCount} restored, ${deletedCount} deleted, ${failedCount} failed`,
							});
						},
					),
			);
		} catch (error) {
			// Specialized catch: records failure metrics before propagating
			const errorMessage = getErrorMessage(error, "Rollback failed");
			try {
				await persistPartialRollback();
			} catch (stateError) {
				request.log.error(
					{ err: stateError, syncId, rollbackAttemptedAt },
					"Failed to persist rollback failure state",
				);
			}
			const metricsResult = completeMetrics();
			metricsResult.recordFailure(errorMessage);

			request.log.error({ error, syncId }, "Sync rollback failed");
			const statusCode =
				error &&
				typeof error === "object" &&
				"statusCode" in error &&
				typeof error.statusCode === "number"
					? error.statusCode
					: 500;
			return reply.status(statusCode).send({
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
