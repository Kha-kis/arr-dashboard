/**
 * TRaSH Guides Template Update Routes
 *
 * API endpoints for checking and applying TRaSH Guides updates to templates.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTemplateUpdater } from "../../lib/trash-guides/template-updater.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const syncTemplateSchema = z.object({
	targetCommitHash: z.string().optional(),
	strategy: z.enum(["replace", "merge", "keep_custom"]).optional(),
});

// ============================================================================
// Route Registration
// ============================================================================

export async function registerUpdateRoutes(
	app: FastifyInstance,
	opts: FastifyPluginOptions,
) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	// Initialize services
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

	/**
	 * GET /api/trash-guides/updates
	 * Check for available template updates
	 */
	app.get("/", async (request, reply) => {
		try {
			const updateCheck = await templateUpdater.checkForUpdates(request.currentUser!.id);

			return reply.send({
				success: true,
				data: {
					templatesWithUpdates: updateCheck.templatesWithUpdates,
					latestCommit: updateCheck.latestCommit,
					summary: {
						total: updateCheck.totalTemplates,
						outdated: updateCheck.outdatedTemplates,
						upToDate: updateCheck.totalTemplates - updateCheck.outdatedTemplates,
					},
				},
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to check for updates");
			return reply.status(500).send({
				success: false,
				error: "Failed to check for template updates",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * GET /api/trash-guides/updates/attention
	 * Get templates requiring user attention (manual review needed)
	 */
	app.get("/attention", async (request, reply) => {
		try {
			const templates = await templateUpdater.getTemplatesNeedingAttention(request.currentUser!.id);

			return reply.send({
				success: true,
				data: {
					templates,
					count: templates.length,
				},
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to get templates needing attention");
			return reply.status(500).send({
				success: false,
				error: "Failed to retrieve templates needing attention",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/trash-guides/updates/:id/sync
	 * Sync a specific template to latest or target commit
	 */
	app.post<{
		Params: { id: string };
		Body: z.infer<typeof syncTemplateSchema>;
	}>("/:id/sync", async (request, reply) => {
		try {
			const { id } = request.params;
			const body = syncTemplateSchema.parse(request.body);

			const result = await templateUpdater.syncTemplate(
				id,
				body.targetCommitHash,
				request.currentUser!.id,
			);

			if (result.success) {
				return reply.send({
					success: true,
					data: {
						templateId: result.templateId,
						previousCommit: result.previousCommit,
						newCommit: result.newCommit,
						message: "Template synced successfully",
					},
				});
			}

			// Handle specific error types with appropriate HTTP status codes
			if (result.errorType === "not_found") {
				return reply.status(404).send({
					success: false,
					error: "Template not found",
				});
			}

			if (result.errorType === "not_authorized") {
				return reply.status(403).send({
					success: false,
					error: "Not authorized to modify this template",
				});
			}

			return reply.status(400).send({
				success: false,
				error: "Failed to sync template",
				details: result.errors,
			});
		} catch (error: unknown) {
			if (error instanceof z.ZodError) {
				return reply.status(400).send({
					success: false,
					error: "Invalid request data",
					details: error.errors,
				});
			}

			request.log.error({ error }, "Failed to sync template");
			return reply.status(500).send({
				success: false,
				error: "Failed to sync template",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/trash-guides/updates/process-auto
	 * Process all auto-sync eligible templates
	 */
	app.post("/process-auto", async (request, reply) => {
		try {
			const result = await templateUpdater.processAutoUpdates(request.currentUser!.id);

			return reply.send({
				success: true,
				data: {
					summary: {
						processed: result.processed,
						successful: result.successful,
						failed: result.failed,
					},
					results: result.results,
				},
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to process auto-updates");
			return reply.status(500).send({
				success: false,
				error: "Failed to process automatic updates",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * GET /api/trash-guides/updates/:id/diff
	 * Get differences between template's current version and latest TRaSH Guides
	 */
	app.get<{
		Params: { id: string };
		Querystring: { targetCommit?: string };
	}>("/:id/diff", async (request, reply) => {
		try {
			const { id } = request.params;
			const { targetCommit } = request.query;

			const diffResult = await templateUpdater.getTemplateDiff(id, targetCommit, request.currentUser!.id);

			return reply.send({
				success: true,
				data: diffResult,
			});
		} catch (error: unknown) {
			if (error instanceof Error) {
				if (error.message === "Template not found") {
					return reply.status(404).send({
						success: false,
						error: "Template not found",
					});
				}
				if (error.message === "Not authorized to access this template") {
					return reply.status(403).send({
						success: false,
						error: "Not authorized to access this template",
					});
				}
			}

			request.log.error({ error }, "Failed to generate diff");
			return reply.status(500).send({
				success: false,
				error: "Failed to generate template diff",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * GET /api/trash-guides/updates/version/latest
	 * Get latest TRaSH Guides version information
	 */
	app.get("/version/latest", async (request, reply) => {
		try {
			const latestCommit = await versionTracker.getLatestCommit();

			return reply.send({
				success: true,
				data: latestCommit,
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to get latest version");
			return reply.status(500).send({
				success: false,
				error: "Failed to retrieve latest version information",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * GET /api/trash-guides/updates/scheduler/status
	 * Get background scheduler status
	 */
	app.get("/scheduler/status", async (request, reply) => {
		try {
			if (!app.trashUpdateScheduler) {
				return reply.send({
					success: true,
					data: {
						enabled: false,
						message: "Scheduler not initialized",
					},
				});
			}

			const stats = app.trashUpdateScheduler.getStats();

			return reply.send({
				success: true,
				data: stats,
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to get scheduler status");
			return reply.status(500).send({
				success: false,
				error: "Failed to retrieve scheduler status",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/trash-guides/updates/scheduler/trigger
	 * Manually trigger an update check
	 */
	app.post("/scheduler/trigger", async (request, reply) => {
		try {
			if (!app.trashUpdateScheduler) {
				return reply.status(503).send({
					success: false,
					error: "Scheduler not initialized",
				});
			}

			await app.trashUpdateScheduler.triggerCheck();

			// Return the scheduler stats so the frontend can know when the check completed
			const stats = app.trashUpdateScheduler.getStats();

			return reply.send({
				success: true,
				message: "Update check completed successfully",
				completedAt: stats.lastCheckAt?.toISOString() ?? new Date().toISOString(),
				result: stats.lastCheckResult ?? null,
			});
		} catch (error: unknown) {
			request.log.error({ error }, "Failed to trigger update check");
			return reply.status(500).send({
				success: false,
				error: "Failed to trigger update check",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
