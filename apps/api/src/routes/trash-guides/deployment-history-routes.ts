/**
 * TRaSH Guides Deployment History Routes
 *
 * API endpoints for retrieving deployment history and rollback capabilities.
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
			const appliedConfigs = history.appliedConfigs ? JSON.parse(history.appliedConfigs) : [];
			const failedConfigs = history.failedConfigs ? JSON.parse(history.failedConfigs) : [];

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
	 * POST /api/trash-guides/deployment/history/:historyId/rollback
	 * Rollback a deployment using its backup
	 */
	app.post<{
		Params: { historyId: string };
	}>("/history/:historyId/rollback", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		try {
			const { historyId } = request.params;

			// Get deployment history
			const history = await app.prisma.templateDeploymentHistory.findUnique({
				where: { id: historyId },
				include: {
					backup: true,
					instance: true,
					template: true,
				},
			});

			if (!history) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Deployment history not found",
				});
			}

			// Check if already rolled back
			if (history.rolledBack) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Deployment has already been rolled back",
				});
			}

			// Check if backup exists
			if (!history.backup) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "No backup available for rollback",
				});
			}

			// Verify template belongs to user
			if (history.template && history.template.userId !== request.currentUser.id) {
				return reply.status(403).send({
					statusCode: 403,
					error: "Forbidden",
					message: "Not authorized to rollback this deployment",
				});
			}

			// Parse the backup data to restore Custom Formats
			const backupData: CustomFormat[] = JSON.parse(history.backup.backupData);

			// Create API client for the instance
			const apiClient = createArrApiClient(history.instance, app.encryptor);

			// Test connection before attempting rollback
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

			// Rollback strategy:
			// 1. Delete all Custom Formats that don't exist in the backup
			// 2. Update existing Custom Formats that have changed
			// 3. Create Custom Formats that existed in backup but not currently

			const backupCFMap = new Map(backupData.map((cf) => [cf.name, cf]));
			const currentCFMap = new Map(currentCFs.map((cf) => [cf.name, cf]));

			let restored = 0;
			let deleted = 0;
			let updated = 0;
			const errors: string[] = [];

			// Delete CFs that don't exist in backup
			for (const currentCF of currentCFs) {
				if (!backupCFMap.has(currentCF.name) && currentCF.id) {
					try {
						await apiClient.deleteCustomFormat(currentCF.id);
						deleted++;
					} catch (error) {
						errors.push(
							`Failed to delete CF "${currentCF.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
						);
					}
				}
			}

			// Restore or update CFs from backup
			for (const backupCF of backupData) {
				const currentCF = currentCFMap.get(backupCF.name);

				try {
					if (currentCF && currentCF.id) {
						// Update existing CF
						await apiClient.updateCustomFormat(currentCF.id, {
							...backupCF,
							id: currentCF.id,
						});
						updated++;
					} else {
						// Create new CF from backup
						await apiClient.createCustomFormat(backupCF);
						restored++;
					}
				} catch (error) {
					errors.push(
						`Failed to restore CF "${backupCF.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}

			// Update history record with rollback information
			const updatedHistory = await app.prisma.templateDeploymentHistory.update({
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
						? "Deployment rollback completed successfully"
						: "Deployment rollback completed with some errors",
				data: {
					history: updatedHistory,
					rollbackResults: {
						restored,
						deleted,
						updated,
						errors,
					},
				},
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to rollback deployment");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message:
					error instanceof Error
						? error.message
						: "Failed to rollback deployment",
			});
		}
	});
};
