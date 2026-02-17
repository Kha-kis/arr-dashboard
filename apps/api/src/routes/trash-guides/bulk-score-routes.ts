/**
 * Bulk Score Management API Routes
 *
 * Routes for managing custom format scores across multiple templates
 */

import type { FastifyPluginCallback } from "fastify";
import { createBulkScoreManager } from "../../lib/trash-guides/bulk-score-manager.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { z } from "zod";
import type {
	BulkScoreFilters,
	BulkScoreUpdate,
	BulkScoreCopy,
	BulkScoreReset,
	BulkScoreImport,
} from "@arr/shared";
import { getErrorMessage } from "../../lib/utils/error-message.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const bulkScoreUpdateSchema = z.object({
	targetTrashIds: z.array(z.string()).min(1, "At least one trash ID is required"),
	targetTemplateIds: z.array(z.string()).optional(),
	targetScoreSets: z.array(z.string()).optional(),
	newScore: z.number().int(),
	resetToDefault: z.boolean().optional(),
});

const bulkScoreExportSchema = z.object({
	version: z.string(),
	exportedAt: z.string(),
	serviceType: z.enum(["RADARR", "SONARR"]),
	templates: z.array(
		z.object({
			templateId: z.string(),
			templateName: z.string(),
			scores: z.record(z.string(), z.number()),
		}),
	),
});

const bulkScoreImportSchema = z.object({
	data: bulkScoreExportSchema,
	targetTemplateIds: z.array(z.string()).optional(),
	overwriteExisting: z.boolean().optional(),
	createMissing: z.boolean().optional(),
});

const bulkScoreResetSchema = z.object({
	templateIds: z.array(z.string()).min(1, "At least one template ID is required"),
	cfTrashIds: z.array(z.string()).optional(),
	resetModificationsFlag: z.boolean().optional(),
});

const bulkScoreCopySchema = z.object({
	sourceTemplateId: z.string().min(1, "Source template ID is required"),
	targetTemplateIds: z.array(z.string()).min(1, "At least one target template ID is required"),
	cfTrashIds: z.array(z.string()).optional(),
	overwriteModified: z.boolean().optional(),
});

// ============================================================================
// Routes
// ============================================================================

const bulkScoreRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /api/trash-guides/bulk-scores
	 * Get all custom format scores with filtering
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const query = request.query as Record<string, string | undefined>;

		// Validate required instanceId parameter
		if (!query.instanceId) {
			return reply.status(400).send({
				success: false,
				error: "instanceId query parameter is required for bulk score management",
			});
		}

		// Build filters from query parameters
		const filters: BulkScoreFilters = {
			instanceId: query.instanceId,
			search: query.search,
			modifiedOnly: query.modifiedOnly === "true",
			sortBy: query.sortBy as "name" | "score" | "templateName" | "groupName" | undefined,
			sortOrder: query.sortOrder as "asc" | "desc" | undefined,
		};

		// Specialized catch: returns 404 for "not found" errors, lets others propagate
		try {
			const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
			const scores = await bulkScoreManager.getAllScores(userId, filters);

			return reply.status(200).send({
				success: true,
				data: {
					scores,
					count: scores.length,
				},
			});
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Failed to get scores");

			// Return 404 for "not found" errors, let others propagate to global handler
			if (errorMessage.includes("not found") || errorMessage.includes("access denied")) {
				return reply.status(404).send({
					success: false,
					error: errorMessage,
				});
			}

			throw error;
		}
	});

	/**
	 * POST /api/trash-guides/bulk-scores/update
	 * Update scores for multiple CFs across templates
	 */
	app.post("/update", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const update: BulkScoreUpdate = validateRequest(bulkScoreUpdateSchema, request.body);

		const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
		const result = await bulkScoreManager.updateScores(userId, update);

		return reply.status(200).send(result);
	});

	/**
	 * POST /api/trash-guides/bulk-scores/copy
	 * Copy scores from one template to others
	 */
	app.post("/copy", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const copy: BulkScoreCopy = validateRequest(bulkScoreCopySchema, request.body);

		const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
		const result = await bulkScoreManager.copyScores(userId, copy);

		return reply.status(200).send(result);
	});

	/**
	 * POST /api/trash-guides/bulk-scores/reset
	 * Reset scores to TRaSH Guides defaults
	 */
	app.post("/reset", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const reset: BulkScoreReset = validateRequest(bulkScoreResetSchema, request.body);

		const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
		const result = await bulkScoreManager.resetScores(userId, reset);

		return reply.status(200).send(result);
	});

	/**
	 * POST /api/trash-guides/bulk-scores/export
	 * Export scores to JSON
	 */
	app.post("/export", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const { templateIds, serviceType } = request.body as {
			templateIds: string[];
			serviceType?: "RADARR" | "SONARR";
		};

		const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
		const exportData = await bulkScoreManager.exportScores(userId, templateIds, serviceType);

		return reply.status(200).send({
			success: true,
			data: exportData,
		});
	});

	/**
	 * POST /api/trash-guides/bulk-scores/import
	 * Import scores from JSON
	 */
	app.post("/import", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
		const importData: BulkScoreImport = validateRequest(bulkScoreImportSchema, request.body);

		const bulkScoreManager = createBulkScoreManager(app.prisma, app.arrClientFactory);
		const result = await bulkScoreManager.importScores(userId, importData);

		return reply.status(200).send(result);
	});

	done();
};

export default bulkScoreRoutes;
