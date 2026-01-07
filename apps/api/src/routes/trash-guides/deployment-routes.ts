/**
 * TRaSH Guides Deployment Routes
 *
 * Phase 4: Deployment System
 * - Deployment preview endpoint
 * - Deployment execution endpoint (future)
 */

import type { FastifyInstance } from "fastify";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";
import { createDeploymentPreviewService } from "../../lib/trash-guides/deployment-preview.js";

export async function deploymentRoutes(app: FastifyInstance) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	const { prisma } = app;
	const deploymentPreview = createDeploymentPreviewService(prisma, app.encryptor);
	const deploymentExecutor = createDeploymentExecutorService(prisma, app.encryptor);

	/**
	 * POST /api/trash-guides/deployment/preview
	 * Generate deployment preview showing what would change
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceId: string;
		};
	}>("/preview", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.body;
			const userId = request.currentUser!.id; // preHandler guarantees auth

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceId are required",
				});
			}

			const preview = await deploymentPreview.generatePreview(templateId, instanceId, userId);

			// Check for existing deployment to get current sync strategy
			// Find the mapping by templateId and instanceId
			const existingMapping = await prisma.templateQualityProfileMapping.findFirst({
				where: {
					templateId,
					instanceId,
				},
				select: { syncStrategy: true },
			});

			return reply.send({
				success: true,
				data: {
					...preview,
					// Include existing sync strategy if this instance was previously deployed
					existingSyncStrategy: existingMapping?.syncStrategy as
						| "auto"
						| "manual"
						| "notify"
						| undefined,
				},
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes("not found") || error.message.includes("mismatch"))
			) {
				return reply.status(400).send({
					success: false,
					error: error.message,
				});
			}

			request.log.error({ error }, "Failed to generate deployment preview");
			return reply.status(500).send({
				success: false,
				error: "Failed to generate deployment preview",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/trash-guides/deployment/execute
	 * Execute deployment to instance
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceId: string;
			syncStrategy?: "auto" | "manual" | "notify";
			conflictResolutions?: Record<string, "use_template" | "keep_existing">; // Map of trashId → resolution
		};
	}>("/execute", async (request, reply) => {
		try {
			const { templateId, instanceId, syncStrategy, conflictResolutions } = request.body;
			const userId = request.currentUser!.id; // preHandler guarantees auth

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceId are required",
				});
			}

			// Execute deployment with conflict resolutions
			const result = await deploymentExecutor.deploySingleInstance(
				templateId,
				instanceId,
				userId,
				syncStrategy,
				conflictResolutions,
			);

			if (result.success) {
				return reply.send({
					success: true,
					result: result,
				});
			}
			return reply.status(400).send({
				success: false,
				error: "Deployment failed",
				result: result,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes("not found") || error.message.includes("mismatch"))
			) {
				return reply.status(400).send({
					success: false,
					error: error.message,
				});
			}

			request.log.error({ error }, "Failed to execute deployment");
			return reply.status(500).send({
				success: false,
				error: "Failed to execute deployment",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * PATCH /api/trash-guides/deployment/sync-strategy
	 * Update sync strategy for an existing deployment (template-instance mapping)
	 */
	app.patch<{
		Body: {
			templateId: string;
			instanceId: string;
			syncStrategy: "auto" | "manual" | "notify";
		};
	}>("/sync-strategy", async (request, reply) => {
		try {
			const userId = request.currentUser!.id; // preHandler guarantees auth
			const { templateId, instanceId, syncStrategy } = request.body;

			if (!templateId || !instanceId || !syncStrategy) {
				return reply.status(400).send({
					success: false,
					error: "templateId, instanceId, and syncStrategy are required",
				});
			}

			// Validate syncStrategy value
			if (!["auto", "manual", "notify"].includes(syncStrategy)) {
				return reply.status(400).send({
					success: false,
					error: "syncStrategy must be 'auto', 'manual', or 'notify'",
				});
			}

			// Find the mapping and verify ownership
			const mapping = await prisma.templateQualityProfileMapping.findFirst({
				where: {
					templateId,
					instanceId,
				},
				include: {
					template: {
						select: { userId: true },
					},
				},
			});

			if (!mapping) {
				return reply.status(404).send({
					success: false,
					error: "No active deployment found",
					details:
						"This instance was synced in the past but is no longer linked to this template. Re-deploy the template to this instance to change sync strategy.",
				});
			}

			// Verify ownership
			if (mapping.template.userId !== userId) {
				return reply.status(403).send({
					success: false,
					error: "You do not have permission to modify this template",
				});
			}

			// Update the sync strategy (single instance)
			const updated = await prisma.templateQualityProfileMapping.update({
				where: { id: mapping.id },
				data: {
					syncStrategy,
					updatedAt: new Date(),
				},
			});

			return reply.send({
				success: true,
				message: `Sync strategy updated to '${syncStrategy}'`,
				data: {
					templateId,
					instanceId,
					syncStrategy: updated.syncStrategy,
				},
			});
		} catch (error) {
			request.log.error({ error }, "Failed to update sync strategy");
			return reply.status(500).send({
				success: false,
				error: "Failed to update sync strategy",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * PATCH /api/trash-guides/deployment/sync-strategy-bulk
	 * Update sync strategy for all instances of a template at once
	 */
	app.patch<{
		Body: {
			templateId: string;
			syncStrategy: "auto" | "manual" | "notify";
		};
	}>("/sync-strategy-bulk", async (request, reply) => {
		try {
			const userId = request.currentUser!.id; // preHandler guarantees auth
			const { templateId, syncStrategy } = request.body;

			if (!templateId || !syncStrategy) {
				return reply.status(400).send({
					success: false,
					error: "templateId and syncStrategy are required",
				});
			}

			// Validate syncStrategy value
			if (!["auto", "manual", "notify"].includes(syncStrategy)) {
				return reply.status(400).send({
					success: false,
					error: "syncStrategy must be 'auto', 'manual', or 'notify'",
				});
			}

			// Verify template belongs to user
			const template = await prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId,
				},
			});

			if (!template) {
				return reply.status(404).send({
					success: false,
					error: "Template not found or not owned by user",
				});
			}

			// Update all mappings for this template
			const result = await prisma.templateQualityProfileMapping.updateMany({
				where: {
					templateId,
				},
				data: {
					syncStrategy,
					updatedAt: new Date(),
				},
			});

			if (result.count === 0) {
				return reply.status(404).send({
					success: false,
					error: "No deployment mappings found for this template",
				});
			}

			return reply.send({
				success: true,
				message: `Updated ${result.count} instance(s) to '${syncStrategy}' sync strategy`,
				data: {
					templateId,
					syncStrategy,
					updatedCount: result.count,
				},
			});
		} catch (error) {
			request.log.error({ error }, "Failed to bulk update sync strategy");
			return reply.status(500).send({
				success: false,
				error: "Failed to bulk update sync strategy",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/deployment/unlink
	 * Remove a template from a single instance (unlink without deleting the template)
	 * This removes the TemplateQualityProfileMapping but keeps Custom Formats on the instance
	 */
	app.delete<{
		Body: {
			templateId: string;
			instanceId: string;
		};
	}>("/unlink", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.body;
			const userId = request.currentUser!.id; // preHandler guarantees auth

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceId are required",
				});
			}

			// Find the mapping
			const mapping = await prisma.templateQualityProfileMapping.findFirst({
				where: {
					templateId,
					instanceId,
				},
				include: {
					instance: {
						select: {
							label: true,
						},
					},
					template: {
						select: {
							name: true,
							userId: true,
						},
					},
				},
			});

			if (!mapping) {
				return reply.status(404).send({
					success: false,
					error: "No deployment mapping found for this template and instance",
				});
			}

			// Verify ownership
			if (mapping.template.userId !== userId) {
				return reply.status(403).send({
					success: false,
					error: "You do not have permission to modify this template",
				});
			}

			// Delete the mapping
			await prisma.templateQualityProfileMapping.delete({
				where: { id: mapping.id },
			});

			// Also delete any instance-level overrides for this template+instance
			await prisma.instanceQualityProfileOverride.deleteMany({
				where: {
					instanceId,
					qualityProfileId: mapping.qualityProfileId,
				},
			});

			request.log.info(
				{ templateId, instanceId, mappingId: mapping.id },
				"Template unlinked from instance",
			);

			return reply.send({
				success: true,
				message: `Template "${mapping.template.name}" has been unlinked from instance "${mapping.instance.label}"`,
				data: {
					templateId,
					instanceId,
					templateName: mapping.template.name,
					instanceName: mapping.instance.label,
				},
			});
		} catch (error) {
			request.log.error({ error }, "Failed to unlink template from instance");
			return reply.status(500).send({
				success: false,
				error: "Failed to unlink template from instance",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/trash-guides/deployment/execute-bulk
	 * Execute deployment to multiple instances
	 * Supports per-instance sync strategies via instanceSyncStrategies map
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceIds: string[];
			syncStrategy?: "auto" | "manual" | "notify";
			instanceSyncStrategies?: Record<string, "auto" | "manual" | "notify">;
		};
	}>("/execute-bulk", async (request, reply) => {
		try {
			const { templateId, instanceIds, syncStrategy, instanceSyncStrategies } = request.body;
			const userId = request.currentUser!.id; // preHandler guarantees auth

			if (!templateId || !instanceIds || instanceIds.length === 0) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceIds are required",
				});
			}

			// Execute bulk deployment with per-instance strategies support
			const result = await deploymentExecutor.deployBulkInstances(
				templateId,
				instanceIds,
				userId,
				syncStrategy,
				instanceSyncStrategies,
			);

			// Derive top-level success from per-deployment statuses
			// success: true only when all deployments succeeded
			// Check both failedInstances count and individual result.success flags
			const hasFailures =
				result.failedInstances > 0 || result.results.some((deployment) => !deployment.success);

			return reply.send({
				success: !hasFailures,
				result: result,
			});
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found")) {
				return reply.status(400).send({
					success: false,
					error: error.message,
				});
			}

			request.log.error({ error }, "Failed to execute bulk deployment");
			return reply.status(500).send({
				success: false,
				error: "Failed to execute bulk deployment",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
