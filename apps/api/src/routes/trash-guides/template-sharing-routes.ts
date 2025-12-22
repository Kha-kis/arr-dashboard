/**
 * Template Sharing API Routes
 *
 * Enhanced template export/import with validation and metadata
 */

import type { TemplateExportOptions, TemplateImportOptions } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { createEnhancedTemplateService } from "../../lib/trash-guides/enhanced-template-service.js";

// ============================================================================
// Routes
// ============================================================================

const templateSharingRoutes: FastifyPluginCallback = (app, opts, done) => {
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
	 * POST /api/trash-guides/sharing/export
	 * Export template with enhanced options
	 */
	app.post("/export", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { templateId, options } = request.body as {
			templateId: string;
			options?: TemplateExportOptions;
		};

		try {
			const service = createEnhancedTemplateService(app.prisma);
			const jsonData = await service.exportTemplateEnhanced(templateId, userId, options || {});

			// Parse to get template name for filename
			let data: { template: { name?: string } };
			try {
				data = JSON.parse(jsonData);
			} catch (parseError) {
				return reply.status(400).send({
					success: false,
					error: `Template export returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
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
		} catch (error) {
			app.log.error(`Failed to export template: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to export template",
			});
		}
	});

	/**
	 * POST /api/trash-guides/sharing/validate
	 * Validate template before import
	 */
	app.post("/validate", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { jsonData } = request.body as { jsonData: string };

		try {
			const service = createEnhancedTemplateService(app.prisma);
			const result = await service.validateTemplateImport(userId, jsonData);

			return reply.status(200).send({
				success: true,
				data: result,
			});
		} catch (error) {
			app.log.error(`Failed to validate template: ${error}`);
			return reply.status(400).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to validate template",
			});
		}
	});

	/**
	 * POST /api/trash-guides/sharing/import
	 * Import template with validation and conflict resolution
	 */
	app.post("/import", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { jsonData, options } = request.body as {
			jsonData: string;
			options?: TemplateImportOptions;
		};

		try {
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
		} catch (error) {
			app.log.error(`Failed to import template: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to import template",
			});
		}
	});

	/**
	 * POST /api/trash-guides/sharing/preview
	 * Preview template import without saving
	 */
	app.post("/preview", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { jsonData } = request.body as { jsonData: string };

		try {
			// Parse JSON data
			let data: unknown;
			try {
				data = JSON.parse(jsonData);
			} catch (parseError) {
				return reply.status(400).send({
					success: false,
					error: `Invalid JSON format: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
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
		} catch (error) {
			app.log.error(`Failed to preview template import: ${error}`);
			return reply.status(400).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to preview template",
			});
		}
	});

	done();
};

export default templateSharingRoutes;
