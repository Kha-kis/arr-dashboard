/**
 * TRaSH Guides Deployment Routes
 *
 * Phase 4: Deployment System
 * - Deployment preview endpoint
 * - Deployment execution endpoint (future)
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConflictError } from "../../lib/errors.js";
import { withCleanupTopologyMutationLease } from "../../lib/library-cleanup/cleanup-run-lease.js";
import { createDeploymentPreviewService } from "../../lib/trash-guides/deployment-preview.js";
import { assertEquivalentDeploymentMappingAuthority } from "../../lib/trash-guides/deployment-target.js";
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
	executionToken: z.string().length(64),
});

const executeBulkSchema = z
	.object({
		templateId: z.string().min(1),
		instanceIds: z.array(z.string().min(1)).min(1),
		syncStrategy: syncStrategyEnum.optional(),
		instanceSyncStrategies: z.record(z.string(), syncStrategyEnum).optional(),
		executionTokens: z.record(z.string(), z.string().length(64)),
	})
	.superRefine((body, context) => {
		const selectedInstanceIds = new Set(body.instanceIds);
		for (const instanceId of body.instanceIds) {
			if (!body.executionTokens[instanceId]) {
				context.addIssue({
					code: "custom",
					path: ["executionTokens", instanceId],
					message: "A fresh execution token is required for every selected instance",
				});
			}
		}
		for (const instanceId of Object.keys(body.executionTokens)) {
			if (!selectedInstanceIds.has(instanceId)) {
				context.addIssue({
					code: "custom",
					path: ["executionTokens", instanceId],
					message: "Execution tokens may only be provided for selected instances",
				});
			}
		}
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

export async function deploymentRoutes(app: FastifyInstance) {
	const { prisma, deploymentExecutor } = app;
	const deploymentPreview = createDeploymentPreviewService(prisma, app.arrClientFactory, app.log);
	const runWithEndpointLocks = async <T>(
		userId: string,
		instances: Array<Parameters<typeof deploymentExecutor.createEndpointMutationKey>[1]>,
		operation: string,
		action: () => Promise<T>,
	): Promise<T> => {
		const targets = new Map<string, (typeof instances)[number]>();
		for (const instance of instances) {
			targets.set(deploymentExecutor.createEndpointMutationKey(userId, instance), instance);
		}
		const orderedTargets = [...targets.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		);
		const acquire = async (index: number): Promise<T> => {
			const target = orderedTargets[index];
			if (!target) return action();
			return deploymentExecutor.runWithEndpointMutation(userId, target[1], operation, () =>
				acquire(index + 1),
			);
		};
		return withCleanupTopologyMutationLease({ prisma, log: app.log }, userId, () => acquire(0));
	};
	const loadEquivalentEndpointMappings = async (
		userId: string,
		templateId: string,
		targetInstance: Parameters<typeof deploymentExecutor.createEndpointMutationKey>[1],
	) => {
		const endpointKey = deploymentExecutor.createEndpointMutationKey(userId, targetInstance);
		const configuredInstances = await prisma.serviceInstance.findMany({
			where: { userId },
		});
		const equivalentInstanceIds = configuredInstances
			.filter(
				(instance) =>
					deploymentExecutor.createEndpointMutationKey(userId, instance) === endpointKey,
			)
			.map((instance) => instance.id);
		if (!equivalentInstanceIds.includes(targetInstance.id)) {
			equivalentInstanceIds.push(targetInstance.id);
		}
		return prisma.templateQualityProfileMapping.findMany({
			where: {
				templateId,
				instanceId: { in: equivalentInstanceIds },
				template: { userId },
			},
			orderBy: { updatedAt: "desc" },
			include: { instance: true },
		});
	};
	const notifyUncertainDeployment = async (
		userId: string,
		title: string,
		body: string,
		metadata: Record<string, unknown>,
	): Promise<void> => {
		if (!app.notificationService) return;
		await app.notificationService.notify(
			{
				eventType: "TRASH_DEPLOY_UNCERTAIN",
				title,
				body,
				url: "/trash-guides",
				metadata: { ...metadata, reason: "uncertain_result" },
			},
			{ userId, fallbackEventTypes: ["TRASH_DEPLOY_FAILED"] },
		);
	};

	/**
	 * POST /api/trash-guides/deployment/preview
	 * Generate deployment preview showing what would change
	 */
	app.post("/preview", async (request, reply) => {
		const { templateId, instanceId } = validateRequest(previewSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		const preview = await deploymentPreview.generatePreview(templateId, instanceId, userId);

		return reply.send({
			success: true,
			data: preview,
		});
	});

	/**
	 * POST /api/trash-guides/deployment/execute
	 * Execute deployment to instance
	 */
	app.post("/execute", async (request, reply) => {
		const { templateId, instanceId, syncStrategy, conflictResolutions, executionToken } =
			validateRequest(executeSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Execute deployment with conflict resolutions
		const result = await deploymentExecutor.deploySingleInstance(
			templateId,
			instanceId,
			userId,
			syncStrategy,
			conflictResolutions,
			executionToken,
		);

		request.log.info({ templateId, instanceId, success: result.success }, "Deployment executed");

		if (result.success) {
			return reply.send({
				success: true,
				result: result,
			});
		}

		if (result.status === "UNCERTAIN") {
			request.log.warn(
				{ templateId, instanceId },
				"Deployment result is uncertain and requires reconciliation",
			);
			notifyUncertainDeployment(
				userId,
				`TRaSH deployment needs review on ${result.instanceLabel}`,
				result.errors?.join("; ") ??
					"ARR may have applied changes, but the result could not be verified.",
				{ instance: result.instanceLabel, templateId, instanceId },
			).catch((err) => {
				request.log.warn({ err }, "Deployment review notification dispatch failed");
			});
			return reply.send({
				success: false,
				error: "Deployment result is uncertain",
				result,
			});
		}

		const partiallyApplied =
			result.customFormatsCreated > 0 ||
			result.customFormatsUpdated > 0 ||
			Boolean(result.qualityProfileApplied) ||
			(result.namingFieldsApplied ?? 0) > 0;
		if (partiallyApplied) {
			return reply.send({
				success: false,
				error: "Deployment partially applied",
				result,
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

		return reply.send({
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
				instance: true,
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

		await runWithEndpointLocks(
			userId,
			[mapping.instance],
			"Deployment authority update",
			async () => {
				const equivalentMappings = await loadEquivalentEndpointMappings(
					userId,
					templateId,
					mapping.instance,
				);
				if (!equivalentMappings.some((candidate) => candidate.id === mapping.id)) {
					throw new ConflictError(
						"Deployment authority changed while the sync strategy was being updated",
					);
				}
				// A strategy write is also the repair path for aliases left with divergent
				// strategies by older single-row writers. Every other ownership field must
				// still agree before replacing that one field across the endpoint.
				assertEquivalentDeploymentMappingAuthority(
					equivalentMappings.map((candidate) => ({ ...candidate, syncStrategy: null })),
				);
				const updated = await prisma.templateQualityProfileMapping.updateMany({
					where: {
						templateId,
						template: { userId },
						OR: equivalentMappings.map((candidate) => ({
							id: candidate.id,
							updatedAt: candidate.updatedAt,
						})),
					},
					data: { syncStrategy, updatedAt: new Date() },
				});
				if (updated.count !== equivalentMappings.length) {
					throw new ConflictError(
						"Deployment authority changed while the sync strategy was being updated",
					);
				}
			},
		);

		request.log.info({ templateId, instanceId, syncStrategy }, "Sync strategy updated");

		return reply.send({
			success: true,
			message: `Sync strategy updated to '${syncStrategy}'`,
			data: {
				templateId,
				instanceId,
				syncStrategy,
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

		const mappings = await prisma.templateQualityProfileMapping.findMany({
			where: { templateId, template: { userId } },
			include: { instance: true },
		});
		if (mappings.length === 0) {
			return reply.status(404).send({
				success: false,
				error: "No deployment mappings found for this template",
			});
		}

		await runWithEndpointLocks(
			userId,
			mappings.map((mapping) => mapping.instance),
			"Bulk deployment authority update",
			async () => {
				const currentMappings = await prisma.templateQualityProfileMapping.findMany({
					where: { templateId, template: { userId } },
					include: { instance: true },
				});
				const reviewedMappingState = new Set(
					mappings.map((mapping) => `${mapping.id}:${mapping.updatedAt.toISOString()}`),
				);
				if (
					currentMappings.length !== mappings.length ||
					currentMappings.some(
						(mapping) =>
							!reviewedMappingState.has(`${mapping.id}:${mapping.updatedAt.toISOString()}`),
					)
				) {
					throw new ConflictError(
						"Deployment authority changed while the bulk sync strategy was being updated",
					);
				}
				const result = await prisma.templateQualityProfileMapping.updateMany({
					where: {
						templateId,
						template: { userId },
						OR: mappings.map((mapping) => ({ id: mapping.id, updatedAt: mapping.updatedAt })),
					},
					data: { syncStrategy, updatedAt: new Date() },
				});
				if (result.count !== mappings.length) {
					throw new ConflictError(
						"Deployment authority changed while the bulk sync strategy was being updated",
					);
				}
			},
		);

		return reply.send({
			success: true,
			message: `Updated ${mappings.length} instance(s) to '${syncStrategy}' sync strategy`,
			data: {
				templateId,
				syncStrategy,
				updatedCount: mappings.length,
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
				instance: true,
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

		await runWithEndpointLocks(
			userId,
			[mapping.instance],
			"Deployment authority unlink",
			async () => {
				const equivalentMappings = await loadEquivalentEndpointMappings(
					userId,
					templateId,
					mapping.instance,
				);
				if (!equivalentMappings.some((candidate) => candidate.id === mapping.id)) {
					throw new ConflictError(
						"Deployment authority changed while the template was being unlinked",
					);
				}
				assertEquivalentDeploymentMappingAuthority(
					equivalentMappings.map((candidate) => ({
						...candidate,
						// Unlink is allowed to repair strategy-only drift, but not disagreement
						// about the profile or Custom Formats that this template owns.
						syncStrategy: null,
					})),
				);
				await prisma.$transaction(async (transaction) => {
					const unresolvedScoreIntent = await transaction.instanceQualityProfileOverride.findFirst({
						where: {
							userId,
							status: { in: ["PENDING", "UNCERTAIN"] },
							OR: equivalentMappings.map((candidate) => ({
								instanceId: candidate.instanceId,
								qualityProfileId: candidate.qualityProfileId,
							})),
						},
						select: { id: true },
					});
					if (unresolvedScoreIntent) {
						throw new ConflictError(
							"Resolve the pending or uncertain score change before unlinking this template",
						);
					}
					const deleted = await transaction.templateQualityProfileMapping.deleteMany({
						where: {
							templateId,
							template: { userId },
							OR: equivalentMappings.map((candidate) => ({
								id: candidate.id,
								updatedAt: candidate.updatedAt,
							})),
						},
					});
					if (deleted.count !== equivalentMappings.length) {
						throw new ConflictError(
							"Deployment authority changed while the template was being unlinked",
						);
					}
					await transaction.instanceQualityProfileOverride.deleteMany({
						where: {
							userId,
							// Pending and uncertain rows are durable upstream-write intents. Keep
							// them available for exact retry/reconciliation after unlinking.
							status: "APPLIED",
							OR: equivalentMappings.map((candidate) => ({
								instanceId: candidate.instanceId,
								qualityProfileId: candidate.qualityProfileId,
							})),
						},
					});
				});
			},
		);

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
		const { templateId, instanceIds, syncStrategy, instanceSyncStrategies, executionTokens } =
			validateRequest(executeBulkSchema, request.body);
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Execute bulk deployment with per-instance strategies support
		const result = await deploymentExecutor.deployBulkInstances(
			templateId,
			instanceIds,
			userId,
			syncStrategy,
			instanceSyncStrategies,
			executionTokens,
		);

		request.log.info({ templateId, instanceCount: instanceIds.length }, "Bulk deployment executed");

		// Derive top-level success from per-deployment statuses
		// success: true only when all deployments succeeded
		// Check both failedInstances count and individual result.success flags
		const hasFailures =
			result.failedInstances > 0 ||
			result.results.some((deployment) => deployment.status === "FAILED");
		const hasUncertain =
			result.uncertainInstances > 0 ||
			result.results.some((deployment) => deployment.status === "UNCERTAIN");
		const failedNames = result.results
			.filter((deployment) => deployment.status === "FAILED")
			.map((deployment) => deployment.instanceLabel)
			.join(", ");

		if (hasFailures && !hasUncertain) {
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

		if (hasUncertain) {
			const uncertainNames = result.results
				.filter((deployment) => deployment.status === "UNCERTAIN")
				.map((deployment) => deployment.instanceLabel)
				.join(", ");
			void notifyUncertainDeployment(
				userId,
				hasFailures
					? "TRaSH bulk deployment had failures and needs review"
					: "TRaSH bulk deployment needs review",
				`${hasFailures ? `Failed on: ${failedNames || "unknown instances"}. ` : ""}Unverified result on: ${uncertainNames || "unknown instances"}`,
				{
					totalInstances: instanceIds.length,
					failedInstances: result.failedInstances,
					uncertainInstances: result.uncertainInstances,
					templateId,
				},
			).catch((err) => {
				request.log.warn({ err }, "Bulk deployment review notification dispatch failed");
			});
		}

		return reply.send({
			success: !hasFailures && !hasUncertain,
			result: result,
		});
	});
}
