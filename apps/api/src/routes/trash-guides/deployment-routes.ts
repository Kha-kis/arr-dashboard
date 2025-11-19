/**
 * TRaSH Guides Deployment Routes
 *
 * Phase 4: Deployment System
 * - Deployment preview endpoint
 * - Deployment execution endpoint (future)
 */

import type { FastifyInstance } from "fastify";
import { createDeploymentPreviewService } from "../../lib/trash-guides/deployment-preview.js";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";

export async function deploymentRoutes(app: FastifyInstance) {
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

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceId are required",
				});
			}

			const preview = await deploymentPreview.generatePreview(
				templateId,
				instanceId,
			);

			return reply.send({
				success: true,
				data: preview,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes("not found") ||
					error.message.includes("mismatch"))
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
			userId?: string; // Optional userId, will be required when auth is implemented
			conflictResolutions?: Record<string, string>; // Map of trashId → resolution
			createBackup?: boolean;
		};
	}>("/execute", async (request, reply) => {
		try {
			const { templateId, instanceId, userId: bodyUserId } = request.body;
			// TODO: Replace with actual auth when implemented
			const userId = bodyUserId || "system";

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceId are required",
				});
			}

			// Execute deployment
			const result = await deploymentExecutor.deploySingleInstance(
				templateId,
				instanceId,
				userId,
			);

			if (result.success) {
				return reply.send({
					success: true,
					data: result,
				});
			} else {
				return reply.status(400).send({
					success: false,
					error: "Deployment failed",
					data: result,
				});
			}
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes("not found") ||
					error.message.includes("mismatch"))
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
	 * POST /api/trash-guides/deployment/execute-bulk
	 * Execute deployment to multiple instances
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceIds: string[];
			userId?: string; // Optional userId, will be required when auth is implemented
		};
	}>("/execute-bulk", async (request, reply) => {
		try {
			const { templateId, instanceIds, userId: bodyUserId } = request.body;
			// TODO: Replace with actual auth when implemented
			const userId = bodyUserId || "system";

			if (!templateId || !instanceIds || instanceIds.length === 0) {
				return reply.status(400).send({
					success: false,
					error: "templateId and instanceIds are required",
				});
			}

			// Execute bulk deployment
			const result = await deploymentExecutor.deployBulkInstances(
				templateId,
				instanceIds,
				userId,
			);

			return reply.send({
				success: true,
				data: result,
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
