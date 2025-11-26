/**
 * TRaSH Guides Deployment History Routes
 *
 * API endpoints for retrieving deployment history.
 */

import type { FastifyPluginAsync } from "fastify";
import {
	createArrApiClient,
	type CustomFormat,
} from "../../lib/trash-guides/arr-api-client.js";

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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Get all deployment history for templates belonging to the user
			const history = await app.prisma.templateDeploymentHistory.findMany({
				where: {
					template: {
						userId: request.currentUser.id,
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
						userId: request.currentUser.id,
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
			app.log.error(
				{ err: error },
				"Failed to retrieve global deployment history",
			);
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to retrieve deployment history",
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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { templateId } = request.params;
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Verify template belongs to user
			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser.id,
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
			app.log.error(
				{ err: error },
				"Failed to retrieve deployment history for template",
			);
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to retrieve deployment history",
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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { instanceId } = request.params;
			const limit = request.query.limit ? Number(request.query.limit) : 50;
			const offset = request.query.offset ? Number(request.query.offset) : 0;

			// Verify instance exists
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
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
			app.log.error(
				{ err: error },
				"Failed to retrieve deployment history for instance",
			);
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to retrieve deployment history",
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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { historyId } = request.params;

			// Get deployment history with all relations
			const history = await app.prisma.templateDeploymentHistory.findUnique({
				where: { id: historyId },
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
			app.log.error(
				{ err: error },
				"Failed to retrieve deployment history details",
			);
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to retrieve deployment history details",
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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { historyId } = request.params;

			// Get deployment history with template to verify ownership
			const history = await app.prisma.templateDeploymentHistory.findUnique({
				where: { id: historyId },
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

			// Verify template belongs to user
			if (history.template && history.template.userId !== request.currentUser.id) {
				return reply.status(403).send({
					statusCode: 403,
					error: "Forbidden",
					message: "Not authorized to delete this deployment history",
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
				message:
					error instanceof Error
						? error.message
						: "Failed to delete deployment history",
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
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { historyId } = request.params;

			// Get deployment history with template config
			const history = await app.prisma.templateDeploymentHistory.findUnique({
				where: { id: historyId },
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

			// Verify template belongs to user (if template still exists)
			if (history.template && history.template.userId !== request.currentUser.id) {
				return reply.status(403).send({
					statusCode: 403,
					error: "Forbidden",
					message: "Not authorized to undeploy this deployment",
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
						(cf: { name: string }) => cf.name
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
			let deleted = 0;
			const skippedShared: string[] = [];
			const notFound: string[] = [];
			const errors: string[] = [];

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
					deleted++;
				} catch (error) {
					errors.push(
						`Failed to delete CF "${cfName}": ${error instanceof Error ? error.message : "Unknown error"}`
					);
				}
			}

			// Mark deployment as undeployed (using rolledBack field for backwards compatibility)
			await app.prisma.templateDeploymentHistory.update({
				where: { id: historyId },
				data: {
					rolledBack: true,
					rolledBackAt: new Date(),
				},
			});

			return reply.send({
				success: errors.length === 0,
				message:
					errors.length === 0
						? `Successfully undeployed ${deleted} Custom Format(s)`
						: `Undeploy completed with ${errors.length} error(s)`,
				data: {
					deleted,
					skippedShared,
					skippedSharedCount: skippedShared.length,
					notFound,
					notFoundCount: notFound.length,
					errors,
					totalInTemplate: deployedCFNames.length,
				},
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to undeploy");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to undeploy",
			});
		}
	});
};
