/**
 * TRaSH Guides Deployment History Routes
 *
 * API endpoints for retrieving deployment history.
 */

import type { FastifyPluginAsync } from "fastify";
import { type CustomFormat, createArrApiClient } from "../../lib/trash-guides/arr-api-client.js";

// ============================================================================
// Route Handlers
// ============================================================================

export const deploymentHistoryRoutes: FastifyPluginAsync = async (app) => {
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
	 * GET /api/trash-guides/deployment/history
	 * Get all deployment history (global view)
	 */
	app.get<{
		Querystring: { limit?: number; offset?: number };
	}>("/history", async (request, reply) => {
		try {
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Get all deployment history for templates belonging to the user
			const history = await app.prisma.templateDeploymentHistory.findMany({
				where: {
					template: {
						userId: request.currentUser?.id,
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
						userId: request.currentUser?.id,
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
		} catch (error) {
			app.log.error({ err: error }, "Failed to retrieve global deployment history");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to retrieve deployment history",
			});
		}
	});

	/**
	 * GET /api/trash-guides/deployment/history/template/:templateId
	 * Get deployment history for a specific template
	 */
	app.get<{
		Params: { templateId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/template/:templateId", async (request, reply) => {
		try {
			const { templateId } = request.params;
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Verify template belongs to user
			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser?.id,
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
		} catch (error) {
			app.log.error({ err: error }, "Failed to retrieve deployment history for template");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to retrieve deployment history",
			});
		}
	});

	/**
	 * GET /api/trash-guides/deployment/history/instance/:instanceId
	 * Get deployment history for a specific instance
	 */
	app.get<{
		Params: { instanceId: string };
		Querystring: { limit?: number; offset?: number };
	}>("/history/instance/:instanceId", async (request, reply) => {
		try {
			const { instanceId } = request.params;
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Verify instance exists and belongs to the user (combined check prevents info leakage)
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					userId: request.currentUser?.id,
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found",
				});
			}

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
		} catch (error) {
			app.log.error({ err: error }, "Failed to retrieve deployment history for instance");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to retrieve deployment history",
			});
		}
	});

	/**
	 * GET /api/trash-guides/deployment/history/:historyId
	 * Get detailed information for a specific deployment
	 */
	app.get<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		try {
			const { historyId } = request.params;
			const userId = request.currentUser!.id; // preHandler guarantees authentication

			// Get deployment history with all relations - verify ownership by including userId in where clause.
			// Including userId ensures non-owned histories return null,
			// preventing enumeration attacks (all non-owned histories return 404).
			const history = await app.prisma.templateDeploymentHistory.findFirst({
				where: { 
					id: historyId,
					userId 
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
		} catch (error) {
			app.log.error({ err: error }, "Failed to retrieve deployment history details");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error ? error.message : "Failed to retrieve deployment history details",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/deployment/history/:historyId
	 * Delete a deployment history entry
	 */
	app.delete<{
		Params: { historyId: string };
	}>("/history/:historyId", async (request, reply) => {
		try {
			const { historyId } = request.params;

		const userId = request.currentUser!.id; // preHandler guarantees authentication
		
		// Get deployment history - verify ownership by including userId in where clause.
		// Including userId ensures non-owned histories return null,
		// preventing enumeration attacks (all non-owned histories return 404).
		const history = await app.prisma.templateDeploymentHistory.findFirst({
			where: { 
				id: historyId,
				userId 
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

			// Delete the deployment history entry
			// Note: Associated backup will be cascade deleted if configured, otherwise it remains
			await app.prisma.templateDeploymentHistory.delete({
				where: { id: historyId },
			});

			return reply.send({
				success: true,
				message: "Deployment history deleted successfully",
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to delete deployment history");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to delete deployment history",
			});
		}
	});

	/**
	 * POST /api/trash-guides/deployment/history/:historyId/undeploy
	 * Undeploy (remove) Custom Formats that were deployed by this specific deployment.
	 * Only removes CFs that are unique to this template (not shared with other templates).
	 */
	app.post<{
		Params: { historyId: string };
	}>("/history/:historyId/undeploy", async (request, reply) => {
		try {
			const { historyId } = request.params;
			const userId = request.currentUser!.id; // preHandler guarantees authentication

			// Get deployment history with template config - verify ownership by including userId in where clause.
			// Including userId ensures non-owned histories return null,
			// preventing enumeration attacks (all non-owned histories return 404).
			const history = await app.prisma.templateDeploymentHistory.findFirst({
				where: { 
					id: historyId,
					userId 
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
					deployedCFNames = (templateConfig.customFormats || []).map(
						(cf: { name: string }) => cf.name,
					);
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

			// Get all OTHER templates deployed to this instance to find shared CFs
			const otherDeployments = await app.prisma.templateDeploymentHistory.findMany({
				where: {
					instanceId: history.instanceId,
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
					} catch {
						// Skip deployments with invalid config
					}
				}
			}

			// Create API client for the instance
			const apiClient = createArrApiClient(history.instance, app.encryptor);

			// Test connection
			try {
				await apiClient.getSystemStatus();
			} catch (error) {
				return reply.status(503).send({
					statusCode: 503,
					error: "ServiceUnavailable",
					message: `Instance unreachable: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}

			// Get current Custom Formats from instance
			const currentCFs = await apiClient.getCustomFormats();
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
				if (!currentCF || !currentCF.id) {
					notFound.push(cfName);
					continue;
				}

				try {
					await apiClient.deleteCustomFormat(currentCF.id);
					deletedCFs.push(cfName);
				} catch (error) {
					deletionErrors.push(
						`Failed to delete CF "${cfName}": ${error instanceof Error ? error.message : "Unknown error"}`,
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
					await app.prisma.templateDeploymentHistory.update({
						where: { id: historyId },
						data: {
							rolledBack: true,
							rolledBackAt: now,
							rolledBackBy: request.currentUser?.id,
							errors: JSON.stringify({
								undeploySucceeded: true,
								deletedCFs,
								skippedShared,
								notFound,
								completedAt: now.toISOString(),
							}),
						},
					});
				} else {
					// Partial failure: update status and store errors for investigation/retry
					await app.prisma.templateDeploymentHistory.update({
						where: { id: historyId },
						data: {
							status: "PARTIAL_UNDEPLOY",
							errors: JSON.stringify({
								undeployErrors: deletionErrors,
								undeployAttemptedAt: now.toISOString(),
								deletedCFs,
								deletedCount: deletedCFs.length,
								failedCount: deletionErrors.length,
								skippedShared,
								notFound,
							}),
						},
					});
				}
				dbUpdateSucceeded = true;
			} catch (error) {
				dbUpdateError = error instanceof Error ? error.message : "Database update failed";
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
					warning: "Database state may not reflect actual changes. Please verify and retry if needed.",
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
			app.log.error({ err: error }, "Failed to undeploy");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to undeploy",
			});
		}
	});
};
