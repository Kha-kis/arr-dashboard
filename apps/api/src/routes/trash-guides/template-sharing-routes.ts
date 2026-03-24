/**
 * Template Sharing API Routes
 *
 * Enhanced template export/import with validation and metadata
 */

import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createEnhancedTemplateService } from "../../lib/trash-guides/enhanced-template-service.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const templateExportBodySchema = z.object({
	templateId: z.string().min(1),
	options: z
		.object({
			includeQualitySettings: z.boolean().optional(),
			includeCustomConditions: z.boolean().optional(),
			includeMetadata: z.boolean().optional(),
			author: z.string().optional(),
			tags: z.array(z.string()).optional(),
			category: z.enum(["anime", "movies", "tv", "remux", "web", "general"]).optional(),
			notes: z.string().optional(),
		})
		.optional(),
});

const templateJsonBodySchema = z.object({
	jsonData: z.string().min(1, "JSON data is required"),
});

const templateImportBodySchema = z.object({
	jsonData: z.string().min(1, "JSON data is required"),
	options: z
		.object({
			onNameConflict: z.enum(["rename", "replace", "cancel"]).optional(),
			onCustomFormatConflict: z.enum(["merge", "replace", "skip"]).optional(),
			onQualityProfileConflict: z.enum(["merge", "replace", "skip"]).optional(),
			includeQualitySettings: z.boolean().optional(),
			includeCustomConditions: z.boolean().optional(),
			includeMetadata: z.boolean().optional(),
			strictValidation: z.boolean().optional(),
			allowPartialImport: z.boolean().optional(),
		})
		.optional(),
});

// ============================================================================
// Routes
// ============================================================================

const templateSharingRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /api/trash-guides/sharing/export
	 * Export template with enhanced options
	 */
	app.post("/export", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { templateId, options } = validateRequest(templateExportBodySchema, request.body);

		const service = createEnhancedTemplateService(app.prisma);
		const jsonData = await service.exportTemplateEnhanced(templateId, userId, options || {});

		// Parse to get template name for filename
		let data: { template: { name?: string } };
		try {
			data = JSON.parse(jsonData);
		} catch (parseError) {
			return reply.status(400).send({
				success: false,
				error: `Template export returned invalid JSON: ${getErrorMessage(parseError)}`,
			});
		}
		// Guard against missing or empty template name
		const templateName =
			data.template?.name && typeof data.template.name === "string" && data.template.name.trim()
				? data.template.name
				: "template";
		const filename = `${templateName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.json`;

		reply.header("Content-Type", "application/json");
		reply.header("Content-Disposition", `attachment; filename="${filename}"`);

		return reply.send(jsonData);
	});

	/**
	 * POST /api/trash-guides/sharing/validate
	 * Validate template before import
	 */
	app.post("/validate", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { jsonData } = validateRequest(templateJsonBodySchema, request.body);

		const service = createEnhancedTemplateService(app.prisma);
		const result = await service.validateTemplateImport(userId, jsonData);

		return reply.status(200).send({
			success: true,
			data: result,
		});
	});

	/**
	 * POST /api/trash-guides/sharing/import
	 * Import template with validation and conflict resolution
	 */
	app.post("/import", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { jsonData, options } = validateRequest(templateImportBodySchema, request.body);

		const service = createEnhancedTemplateService(app.prisma);
		const result = await service.importTemplateEnhanced(userId, jsonData, options || {});

		if (!result.success) {
			return reply.status(400).send({
				success: false,
				error: result.error,
				validation: result.validation,
			});
		}

		return reply.status(201).send({
			success: true,
			data: {
				template: result.template,
				validation: result.validation,
			},
		});
	});

	/**
	 * POST /api/trash-guides/sharing/preview
	 * Preview template import without saving
	 */
	app.post("/preview", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { jsonData } = validateRequest(templateJsonBodySchema, request.body);

		// Parse JSON data
		let data: unknown;
		try {
			data = JSON.parse(jsonData);
		} catch (parseError) {
			return reply.status(400).send({
				success: false,
				error: `Invalid JSON format: ${getErrorMessage(parseError)}`,
			});
		}

		// Validate required structure
		if (
			typeof data !== "object" ||
			data === null ||
			!("template" in data) ||
			typeof (data as { template: unknown }).template !== "object" ||
			(data as { template: unknown }).template === null
		) {
			return reply.status(400).send({
				success: false,
				error: "Invalid template format: missing or invalid 'template' property",
			});
		}

		const templateData = data as { template: Record<string, unknown> };
		const service = createEnhancedTemplateService(app.prisma);
		const validation = await service.validateTemplateImport(userId, jsonData);

		return reply.status(200).send({
			success: true,
			data: {
				template: templateData.template,
				validation: validation.validation,
				compatibility: validation.compatibility,
			},
		});
	});

	done();
};

export default templateSharingRoutes;
