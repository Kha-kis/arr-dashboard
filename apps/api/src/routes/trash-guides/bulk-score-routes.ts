/**
 * Bulk Score Management API Routes
 *
 * Routes for managing custom format scores across multiple templates
 */

import { FastifyPluginCallback } from "fastify";
import { createBulkScoreManager } from "../../lib/trash-guides/bulk-score-manager.js";
import type {
	BulkScoreFilters,
	BulkScoreUpdate,
	BulkScoreCopy,
	BulkScoreReset,
	BulkScoreImport,
} from "@arr/shared";

// ============================================================================
// Routes
// ============================================================================

const bulkScoreRoutes: FastifyPluginCallback = (app, opts, done) => {
	/**
	 * GET /api/trash-guides/bulk-scores
	 * Get all custom format scores with filtering
	 */
	app.get("/", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const query = request.query as any;

		// Build filters from query parameters
		const filters: BulkScoreFilters = {
			instanceId: query.instanceId,
			search: query.search,
			modifiedOnly: query.modifiedOnly === "true",
			sortBy: query.sortBy as "name" | "score" | "templateName" | "groupName" | undefined,
			sortOrder: query.sortOrder as "asc" | "desc" | undefined,
		};

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const scores = await bulkScoreManager.getAllScores(userId, filters);

			return reply.status(200).send({
				success: true,
				data: {
					scores,
					count: scores.length,
				},
			});
		} catch (error) {
			app.log.error(`Failed to get bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to get scores",
			});
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/update
	 * Update scores for multiple CFs across templates
	 */
	app.post("/update", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const update = request.body as BulkScoreUpdate;

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const result = await bulkScoreManager.updateScores(userId, update);

			return reply.status(200).send(result);
		} catch (error) {
			app.log.error(`Failed to update bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				message: error instanceof Error ? error.message : "Failed to update scores",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/copy
	 * Copy scores from one template to others
	 */
	app.post("/copy", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const copy = request.body as BulkScoreCopy;

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const result = await bulkScoreManager.copyScores(userId, copy);

			return reply.status(200).send(result);
		} catch (error) {
			app.log.error(`Failed to copy bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				message: error instanceof Error ? error.message : "Failed to copy scores",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/reset
	 * Reset scores to TRaSH Guides defaults
	 */
	app.post("/reset", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const reset = request.body as BulkScoreReset;

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const result = await bulkScoreManager.resetScores(userId, reset);

			return reply.status(200).send(result);
		} catch (error) {
			app.log.error(`Failed to reset bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				message: error instanceof Error ? error.message : "Failed to reset scores",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/export
	 * Export scores to JSON
	 */
	app.post("/export", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const { templateIds, serviceType } = request.body as {
			templateIds: string[];
			serviceType?: "RADARR" | "SONARR";
		};

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const exportData = await bulkScoreManager.exportScores(
				userId,
				templateIds,
				serviceType,
			);

			return reply.status(200).send({
				success: true,
				data: exportData,
			});
		} catch (error) {
			app.log.error(`Failed to export bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to export scores",
			});
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/import
	 * Import scores from JSON
	 */
	app.post("/import", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const importData = request.body as BulkScoreImport;

		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.encryptor);
			const result = await bulkScoreManager.importScores(userId, importData);

			return reply.status(200).send(result);
		} catch (error) {
			app.log.error(`Failed to import bulk scores: ${error}`);
			return reply.status(500).send({
				success: false,
				message: error instanceof Error ? error.message : "Failed to import scores",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}
	});

	done();
};

export default bulkScoreRoutes;
