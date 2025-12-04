/**
 * Bulk Score Management API Routes
 *
 * Routes for managing custom format scores across multiple templates
 */

import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createBulkScoreManager } from "../../lib/trash-guides/bulk-score-manager.js";
import type {
	BulkScoreFilters,
	BulkScoreUpdate,
	BulkScoreCopy,
	BulkScoreReset,
	BulkScoreImport,
} from "@arr/shared";

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
	templates: z.array(z.object({
		templateId: z.string(),
		templateName: z.string(),
		scores: z.record(z.string(), z.number()),
	})),
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

const bulkScoreRoutes: FastifyPluginCallback = (app, opts, done) => {
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
	 * GET /api/trash-guides/bulk-scores
	 * Get all custom format scores with filtering
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees authentication
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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Validate request body
		const parseResult = bulkScoreUpdateSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				message: "Invalid request body",
				errors: parseResult.error.errors.map((e) => ({
					path: e.path.join("."),
					message: e.message,
				})),
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}

		const update: BulkScoreUpdate = parseResult.data;

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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Validate request body
		const parseResult = bulkScoreCopySchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				message: "Invalid request body",
				errors: parseResult.error.errors.map((e) => ({
					path: e.path.join("."),
					message: e.message,
				})),
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}

		const copy: BulkScoreCopy = parseResult.data;

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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Validate request body
		const parseResult = bulkScoreResetSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				message: "Invalid request body",
				errors: parseResult.error.errors.map((e) => ({
					path: e.path.join("."),
					message: e.message,
				})),
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}

		const reset: BulkScoreReset = parseResult.data;

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
		const userId = request.currentUser!.id; // preHandler guarantees authentication
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
		const userId = request.currentUser!.id; // preHandler guarantees authentication

		// Validate request body
		const parseResult = bulkScoreImportSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				success: false,
				message: "Invalid import data",
				errors: parseResult.error.errors.map((e) => ({
					path: e.path.join("."),
					message: e.message,
				})),
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			});
		}

		const importData: BulkScoreImport = parseResult.data;

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
