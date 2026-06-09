/**
 * TRaSH Guides Deployment Routes
 *
 * Phase 4: Deployment System
 * - Deployment preview endpoint
 * - Deployment execution endpoint (future)
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createDeploymentPreviewService } from "../../lib/trash-guides/deployment-preview.js";
import { validateRequest } from "../../lib/utils/validate.js";

const syncStrategyEnum = z.enum(["auto", "manual", "notify"]);

const previewSchema = z.object({
	templateId: z.string().min(1),
	instanceId: z.string().min(1),
});

const executeSchema = z.object({
	templateId: z.string().min(1),
	instanceId: z.string().min(1),
	syncStrategy: syncStrategyEnum.optional(),
	// Map of trashId → resolution
	conflictResolutions: z.record(z.string(), z.enum(["use_template", "keep_existing"])).optional(),
});

const syncStrategySchema = z.object({
	templateId: z.string().min(1),
	instanceId: z.string().min(1),
	syncStrategy: syncStrategyEnum,
});

const syncStrategyBulkSchema = z.object({
	templateId: z.string().min(1),
	syncStrategy: syncStrategyEnum,
});

const unlinkSchema = z.object({
	templateId: z.string().min(1),
	instanceId: z.string().min(1),
});

const executeBulkSchema = z.object({
	templateId: z.string().min(1),
	instanceIds: z.array(z.string().min(1)).min(1),
	syncStrategy: syncStrategyEnum.optional(),
	instanceSyncStrategies: z.record(z.string(), syncStrategyEnum).optional(),
});

export async function deploymentRoutes(app: FastifyInstance) {
	const { prisma, deploymentExecutor } = app;
	const deploymentPreview = createDeploymentPreviewService(prisma, app.arrClientFactory, app.log);

	/**
	 * POST /api/trash-guides/deployment/preview
	 * Generate deployment preview showing what would change
	 */
	app.post("/preview", async (request, reply) => {
		const { templateId, instanceId } = validateRequest(previewSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		const preview = await deploymentPreview.generatePreview(templateId, instanceId, userId);

		// Check for existing deployment to get current sync strategy
		// Find the mapping by templateId and instanceId
		const existingMapping = await prisma.templateQualityProfileMapping.findFirst({
			where: {
				templateId,
				instanceId,
			},
			orderBy: { updatedAt: "desc" },
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
	});

	/**
	 * POST /api/trash-guides/deployment/execute
	 * Execute deployment to instance
	 */
	app.post("/execute", async (request, reply) => {
		const { templateId, instanceId, syncStrategy, conflictResolutions } = validateRequest(
			executeSchema,
			request.body,
		);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Execute deployment with conflict resolutions
		const result = await deploymentExecutor.deploySingleInstance(
			templateId,
			instanceId,
			userId,
			syncStrategy,
			conflictResolutions,
		);

		request.log.info({ templateId, instanceId, success: result.success }, "Deployment executed");

		if (result.success) {
			return reply.send({
				success: true,
				result: result,
			});
		}

		app.notificationService
			?.notify({
				eventType: "TRASH_DEPLOY_FAILED",
				title: `TRaSH deployment failed on ${result.instanceLabel}`,
				body: result.errors?.join("; ") ?? "Deployment failed",
				url: "/trash-guides",
				metadata: {
					instance: result.instanceLabel,
					templateId,
				},
			})
			.catch((err) => {
				request.log.warn({ err }, "Deployment failed notification dispatch failed");
			});

		return reply.status(400).send({
			success: false,
			error: "Deployment failed",
			result: result,
		});
	});

	/**
	 * PATCH /api/trash-guides/deployment/sync-strategy
	 * Update sync strategy for an existing deployment (template-instance mapping)
	 */
	app.patch("/sync-strategy", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { templateId, instanceId, syncStrategy } = validateRequest(
			syncStrategySchema,
			request.body,
		);

		// Find the mapping and verify ownership
		const mapping = await prisma.templateQualityProfileMapping.findFirst({
			where: {
				templateId,
				instanceId,
			},
			orderBy: { updatedAt: "desc" },
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

		request.log.info({ templateId, instanceId, syncStrategy }, "Sync strategy updated");

		return reply.send({
			success: true,
			message: `Sync strategy updated to '${syncStrategy}'`,
			data: {
				templateId,
				instanceId,
				syncStrategy: updated.syncStrategy,
			},
		});
	});

	/**
	 * PATCH /api/trash-guides/deployment/sync-strategy-bulk
	 * Update sync strategy for all instances of a template at once
	 */
	app.patch("/sync-strategy-bulk", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { templateId, syncStrategy } = validateRequest(syncStrategyBulkSchema, request.body);

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
	});

	/**
	 * DELETE /api/trash-guides/deployment/unlink
	 * Remove a template from a single instance (unlink without deleting the template)
	 * This removes the TemplateQualityProfileMapping but keeps Custom Formats on the instance
	 */
	app.delete("/unlink", async (request, reply) => {
		const { templateId, instanceId } = validateRequest(unlinkSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Find the mapping
		const mapping = await prisma.templateQualityProfileMapping.findFirst({
			where: {
				templateId,
				instanceId,
			},
			orderBy: { updatedAt: "desc" },
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
	});

	/**
	 * POST /api/trash-guides/deployment/execute-bulk
	 * Execute deployment to multiple instances
	 * Supports per-instance sync strategies via instanceSyncStrategies map
	 */
	app.post("/execute-bulk", async (request, reply) => {
		const { templateId, instanceIds, syncStrategy, instanceSyncStrategies } = validateRequest(
			executeBulkSchema,
			request.body,
		);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Execute bulk deployment with per-instance strategies support
		const result = await deploymentExecutor.deployBulkInstances(
			templateId,
			instanceIds,
			userId,
			syncStrategy,
			instanceSyncStrategies,
		);

		request.log.info({ templateId, instanceCount: instanceIds.length }, "Bulk deployment executed");

		// Derive top-level success from per-deployment statuses
		// success: true only when all deployments succeeded
		// Check both failedInstances count and individual result.success flags
		const hasFailures =
			result.failedInstances > 0 || result.results.some((deployment) => !deployment.success);

		if (hasFailures) {
			const failedNames = result.results
				.filter((r) => !r.success)
				.map((r) => r.instanceLabel)
				.join(", ");

			app.notificationService
				?.notify({
					eventType: "TRASH_DEPLOY_FAILED",
					title: `TRaSH bulk deployment had failures`,
					body: `Failed on: ${failedNames || "unknown instances"}`,
					url: "/trash-guides",
					metadata: {
						totalInstances: instanceIds.length,
						failedInstances: result.failedInstances,
						templateId,
					},
				})
				.catch((err) => {
					request.log.warn({ err }, "Bulk deployment failed notification dispatch failed");
				});
		}

		return reply.send({
			success: !hasFailures,
			result: result,
		});
	});
}
