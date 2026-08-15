/**
 * TRaSH Guides Deployment History Routes
 *
 * API endpoints for retrieving deployment history.
 */

import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyPluginAsync } from "fastify";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { isNonterminalUndeploy } from "../../lib/backup/backup-validation.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";

// ============================================================================
// Route Handlers
// ============================================================================

export const deploymentHistoryRoutes: FastifyPluginAsync = async (app) => {
	/**
	 * GET /api/trash-guides/deployment/history
	 * Get all deployment history (global view)
	 */
	app.get<{
		Querystring: { limit?: number; offset?: number };
	}>("/history", async (request, reply) => {
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		// Get all deployment history for templates belonging to the user
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				template: {
					userId: request.currentUser!.id, // preHandler guarantees authentication
				},
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
				template: {
					select: {
						id: true,
						name: true,
						serviceType: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: {
				template: {
					userId: request.currentUser!.id, // preHandler guarantees authentication
				},
			},
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/template/:templateId
	 * Get deployment history for a specific template
	 */
	app.get<{
		Params: { templateId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/template/:templateId", async (request, reply) => {
		const { templateId } = request.params;
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		// Verify template belongs to user
		const template = await app.prisma.trashTemplate.findFirst({
			where: {
				id: templateId,
				userId: request.currentUser!.id, // preHandler guarantees authentication
			},
		});

		if (!template) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Template not found",
			});
		}

		// Get deployment history
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				templateId,
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: { templateId },
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/instance/:instanceId
	 * Get deployment history for a specific instance
	 */
	app.get<{
		Params: { instanceId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/instance/:instanceId", async (request, reply) => {
		const { instanceId } = request.params;
		const limit = request.query.limit ? Number(request.query.limit) : 50;
		const offset = request.query.offset ? Number(request.query.offset) : 0;

		await requireInstance(app, request.currentUser!.id, instanceId);

		// Get deployment history
		const history = await app.prisma.templateDeploymentHistory.findMany({
			where: {
				instanceId,
			},
			include: {
				template: {
					select: {
						id: true,
						name: true,
						serviceType: true,
					},
				},
			},
			orderBy: {
				deployedAt: "desc",
			},
			take: limit,
			skip: offset,
		});

		// Get total count
		const total = await app.prisma.templateDeploymentHistory.count({
			where: { instanceId },
		});

		return reply.send({
			success: true,
			data: {
				history,
				pagination: {
					total,
					limit,
					offset,
					hasMore: offset + history.length < total,
				},
			},
		});
	});

	/**
	 * GET /api/trash-guides/deployment/history/:historyId
	 * Get detailed information for a specific deployment
	 */
	app.get<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		const { historyId } = request.params;
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history with all relations - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				instance: {
					select: {
						id: true,
						label: true,
						service: true,
					},
				},
				template: {
					select: {
						id: true,
						name: true,
						description: true,
						serviceType: true,
						userId: true,
					},
				},
				backup: {
					select: {
						id: true,
						createdAt: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		// Parse JSON fields for detailed information
		let appliedConfigs: unknown[] = [];
		let failedConfigs: unknown[] = [];
		try {
			appliedConfigs = history.appliedConfigs ? JSON.parse(history.appliedConfigs) : [];
		} catch {
			app.log.warn({ historyId: history.id }, "Failed to parse appliedConfigs JSON");
		}
		try {
			failedConfigs = history.failedConfigs ? JSON.parse(history.failedConfigs) : [];
		} catch {
			app.log.warn({ historyId: history.id }, "Failed to parse failedConfigs JSON");
		}

		return reply.send({
			success: true,
			data: {
				...history,
				appliedConfigs,
				failedConfigs,
			},
		});
	});

	/**
	 * DELETE /api/trash-guides/deployment/history/:historyId
	 * Delete a deployment history entry
	 */
	app.delete<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		const { historyId } = request.params;

		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				template: {
					select: {
						userId: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		if (isNonterminalUndeploy(history)) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message:
					"Complete or explicitly resolve the undeploy before deleting its deployment history.",
			});
		}

		// Delete only if ownership and terminal undeploy state still match at mutation time.
		// Note: Associated backup will be cascade deleted if configured, otherwise it remains.
		const deletion = await app.prisma.templateDeploymentHistory.deleteMany({
			where: {
				id: historyId,
				userId,
				OR: [
					{ rolledBack: true },
					{ undeployStatus: "COMPLETED" },
					{
						undeployStatus: null,
						NOT: { status: "PARTIAL_UNDEPLOY" },
					},
				],
			},
		});

		if (deletion.count !== 1) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message:
					"Complete or explicitly resolve the undeploy before deleting its deployment history.",
			});
		}

		return reply.send({
			success: true,
			message: "Deployment history deleted successfully",
		});
	});

	/**
	 * POST /api/trash-guides/deployment/history/:historyId/undeploy
	 * Undeploy (remove) Custom Formats that were deployed by this specific deployment.
	 * Only removes CFs that are unique to this template (not shared with other templates).
	 */
	app.post<{
		Params: { historyId: string };
	}>("/history/:historyId/undeploy", async (request, reply) => {
		const { historyId } = request.params;
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Get deployment history with template config - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: {
				id: historyId,
				userId,
			},
			include: {
				instance: true,
				template: {
					select: {
						id: true,
						name: true,
						userId: true,
						configData: true,
					},
				},
			},
		});

		if (!history) {
			return reply.status(404).send({
				statusCode: 404,
				error: "NotFound",
				message: "Deployment history not found",
			});
		}

		// Check if already undeployed
		if (history.rolledBack) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "This deployment has already been undeployed",
			});
		}

		// Get the CFs that were deployed by this template
		// Use templateSnapshot if available, otherwise use current template config
		let deployedCFNames: string[] = [];
		const configSource = history.templateSnapshot || history.template?.configData;

		if (configSource) {
			try {
				const templateConfig = JSON.parse(configSource);
				deployedCFNames = Array.isArray(templateConfig.customFormats)
					? templateConfig.customFormats.map((cf: { name: string }) => cf.name)
					: [];
			} catch {
				// If we can't parse the config, we can't undeploy
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Cannot determine which Custom Formats to remove - template config is invalid",
				});
			}
		} else {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "Cannot undeploy - template no longer exists and no snapshot was saved",
			});
		}

		if (deployedCFNames.length === 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "No Custom Formats found in this deployment",
			});
		}

		const undeployAttemptedAt = new Date();
		const claim = await app.prisma.templateDeploymentHistory.updateMany({
			where: {
				id: historyId,
				userId,
				rolledBack: false,
				OR: [{ undeployStatus: null }, { undeployStatus: "PARTIAL" }],
			},
			data: {
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt,
				undeployProgress: JSON.stringify([
					{
						step: "remove-custom-formats",
						status: "IN_PROGRESS",
						attemptedAt: undeployAttemptedAt.toISOString(),
					},
				]),
			},
		});

		if (claim.count !== 1) {
			return reply.status(409).send({
				statusCode: 409,
				error: "Conflict",
				message: "An undeploy is already active or requires explicit recovery resolution.",
			});
		}

		const persistPartialUndeploy = async (
			errors: string[],
			progress: Record<string, unknown> = {},
		) => {
			const result = await app.prisma.templateDeploymentHistory.updateMany({
				where: {
					id: historyId,
					userId,
					undeployStatus: "IN_PROGRESS",
					undeployAttemptedAt,
				},
				data: {
					status: "PARTIAL_UNDEPLOY",
					undeployStatus: "PARTIAL",
					undeployProgress: JSON.stringify([
						{ step: "remove-custom-formats", status: "PARTIAL", errors, ...progress },
					]),
					errors: JSON.stringify({
						undeployErrors: errors,
						undeployAttemptedAt: undeployAttemptedAt.toISOString(),
						...progress,
					}),
				},
			});
			if (result.count !== 1) {
				throw new Error("Undeploy recovery state changed before progress could be persisted");
			}
		};

		try {
			// Get all OTHER templates deployed to this instance to find shared CFs
			const otherDeployments = await app.prisma.templateDeploymentHistory.findMany({
				where: {
					instanceId: history.instanceId,
					userId,
					id: { not: historyId },
					rolledBack: false, // Only consider active deployments
				},
				include: {
					template: {
						select: {
							configData: true,
						},
					},
				},
			});

			// Build a set of CF names used by other templates on this instance
			const sharedCFNames = new Set<string>();
			for (const deployment of otherDeployments) {
				const configData = deployment.templateSnapshot || deployment.template?.configData;
				if (configData) {
					try {
						const config = JSON.parse(configData);
						for (const cf of config.customFormats || []) {
							if (deployedCFNames.includes(cf.name)) {
								sharedCFNames.add(cf.name);
							}
						}
					} catch (error) {
						throw new Error(
							`Cannot safely undeploy because another active deployment has invalid configuration: ${getErrorMessage(error, "invalid configuration")}`,
						);
					}
				}
			}

			// Create SDK client using factory
			const client = app.arrClientFactory.create(history.instance) as SonarrClient | RadarrClient;

			// Test connection
			try {
				await client.system.get();
			} catch (error) {
				const errorMessage = getErrorMessage(error, "Unknown error");
				await persistPartialUndeploy([errorMessage], { step: "connect" });
				return reply.status(503).send({
					statusCode: 503,
					error: "ServiceUnavailable",
					message: `Instance unreachable: ${errorMessage}`,
				});
			}

			// Get current Custom Formats from instance
			const currentCFs = await client.customFormat.getAll();
			const currentCFMap = new Map(currentCFs.map((cf) => [cf.name, cf]));

			// Delete only CFs that:
			// 1. Were part of this deployment
			// 2. Are NOT shared with other templates
			// 3. Currently exist on the instance
			const deletedCFs: string[] = [];
			const skippedShared: string[] = [];
			const notFound: string[] = [];
			const deletionErrors: string[] = [];

			for (const cfName of deployedCFNames) {
				if (sharedCFNames.has(cfName)) {
					skippedShared.push(cfName);
					continue;
				}

				const currentCF = currentCFMap.get(cfName);
				if (!currentCF?.id) {
					notFound.push(cfName);
					continue;
				}

				try {
					await client.customFormat.delete(currentCF.id);
					deletedCFs.push(cfName);
				} catch (error) {
					deletionErrors.push(
						`Failed to delete CF "${cfName}": ${getErrorMessage(error, "Unknown error")}`,
					);
				}
			}

			// Update deployment status based on undeploy result
			const isFullSuccess = deletionErrors.length === 0;
			const now = new Date();

			// Attempt to update the database to reflect the current state
			let dbUpdateSucceeded = false;
			let dbUpdateError: string | null = null;

			try {
				if (isFullSuccess) {
					// Full success: mark as rolled back
					const completion = await app.prisma.templateDeploymentHistory.updateMany({
						where: {
							id: historyId,
							userId,
							undeployStatus: "IN_PROGRESS",
							undeployAttemptedAt,
						},
						data: {
							rolledBack: true,
							rolledBackAt: now,
							rolledBackBy: request.currentUser!.id,
							undeployStatus: "COMPLETED",
							undeployProgress: JSON.stringify([
								{
									step: "remove-custom-formats",
									status: "COMPLETED",
									deletedCFs,
									skippedShared,
									notFound,
								},
							]),
							errors: JSON.stringify({
								undeploySucceeded: true,
								deletedCFs,
								skippedShared,
								notFound,
								completedAt: now.toISOString(),
							}),
						},
					});
					if (completion.count !== 1) {
						throw new Error("Undeploy recovery ownership changed before completion");
					}
				} else {
					// Partial failure: update status and store errors for investigation/retry
					await persistPartialUndeploy(deletionErrors, {
						deletedCFs,
						deletedCount: deletedCFs.length,
						failedCount: deletionErrors.length,
						skippedShared,
						notFound,
					});
				}
				dbUpdateSucceeded = true;
			} catch (error) {
				dbUpdateError = getErrorMessage(error, "Database update failed");
				await persistPartialUndeploy([dbUpdateError], {
					deletedCFs,
					deletedCount: deletedCFs.length,
					failedCount: deletionErrors.length,
					skippedShared,
					notFound,
				}).catch((stateError) => {
					request.log.error(
						{ err: stateError, historyId },
						"Failed to preserve retryable undeploy state after terminal persistence failed",
					);
				});
				app.log.error(
					{
						err: error,
						historyId,
						deletedCFs,
						deletionErrors,
					},
					"Failed to update deployment history after undeploy - database state may be inconsistent",
				);
			}

			// Build response based on actual outcome
			const responseData = {
				deleted: deletedCFs.length,
				deletedCFs,
				skippedShared,
				skippedSharedCount: skippedShared.length,
				notFound,
				notFoundCount: notFound.length,
				errors: deletionErrors,
				totalInTemplate: deployedCFNames.length,
				dbUpdateSucceeded,
				...(dbUpdateError && { dbUpdateError }),
			};

			// If DB update failed but deletions occurred, return partial success with warning
			if (!dbUpdateSucceeded && deletedCFs.length > 0) {
				return reply.status(207).send({
					success: false,
					message: `Deleted ${deletedCFs.length} Custom Format(s) but failed to update database. Manual cleanup may be required.`,
					warning:
						"Database state may not reflect actual changes. Please verify and retry if needed.",
					data: responseData,
				});
			}

			// If DB update failed and no deletions occurred (or only errors), return error
			if (!dbUpdateSucceeded) {
				return reply.status(500).send({
					success: false,
					message: `Undeploy operation encountered errors: ${dbUpdateError}`,
					data: responseData,
				});
			}

			return reply.send({
				success: isFullSuccess,
				message: isFullSuccess
					? `Successfully undeployed ${deletedCFs.length} Custom Format(s)`
					: `Undeploy completed with ${deletionErrors.length} error(s)`,
				data: responseData,
			});
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Undeploy failed");
			await persistPartialUndeploy([errorMessage]).catch((stateError) => {
				request.log.error(
					{ err: stateError, historyId },
					"Failed to persist retryable undeploy state after an unexpected failure",
				);
			});
			request.log.error({ err: error, historyId }, "Undeploy failed");
			return reply.status(500).send({
				success: false,
				message: errorMessage,
			});
		}
	});
};
