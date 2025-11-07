/**
 * TRaSH Guides Template API Routes
 *
 * Endpoints for template CRUD operations, import/export, and statistics
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { createTemplateService } from "../../lib/trash-guides/template-service.js";
import type {
	CreateTemplateRequest,
	UpdateTemplateRequest,
	TemplateConfig,
} from "@arr/shared";

// ============================================================================
// Request Schemas
// ============================================================================

const templateConfigSchema = z.object({
	customFormats: z.array(
		z.object({
			trashId: z.string(),
			name: z.string(),
			scoreOverride: z.number().optional(),
			conditionsEnabled: z.record(z.boolean()),
			originalConfig: z.any(),
		}),
	),
	customFormatGroups: z.array(
		z.object({
			trashId: z.string(),
			name: z.string(),
			enabled: z.boolean(),
			originalConfig: z.any(),
		}),
	),
	qualitySize: z.array(z.any()).optional(),
	naming: z.array(z.any()).optional(),
}) as z.ZodType<TemplateConfig>;

const createTemplateSchema = z.object({
	name: z.string().min(1).max(100),
	description: z.string().max(500).optional(),
	serviceType: z.enum(["RADARR", "SONARR"]),
	config: templateConfigSchema,
});

const updateTemplateSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(500).optional(),
	config: templateConfigSchema.optional(),
});

const listTemplatesQuerySchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]).optional(),
	includeDeleted: z.string().optional().transform((val) => val === "true"),
	active: z.string().optional().transform((val) => {
		if (val === "true") return true;
		if (val === "false") return false;
		return undefined;
	}),
	limit: z.string().optional().transform((val) => (val ? Number.parseInt(val, 10) : undefined)),
	offset: z.string().optional().transform((val) => (val ? Number.parseInt(val, 10) : undefined)),
});

const duplicateTemplateSchema = z.object({
	newName: z.string().min(1).max(100),
});

const importTemplateSchema = z.object({
	jsonData: z.string(),
});

const getTemplateParamsSchema = z.object({
	templateId: z.string(),
});

// ============================================================================
// Route Handlers
// ============================================================================

export const registerTemplateRoutes = fp(
	async (app: FastifyInstance, _opts: FastifyPluginOptions) => {
		const templateService = createTemplateService(app.prisma);

		/**
		 * GET /api/trash-guides/templates
		 * List all templates for current user
		 */
		app.get<{
			Querystring: z.infer<typeof listTemplatesQuerySchema>;
		}>("/", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const query = listTemplatesQuerySchema.parse(request.query);

				const templates = await templateService.listTemplates({
					userId: request.currentUser.id,
					serviceType: query.serviceType,
					includeDeleted: query.includeDeleted,
					active: query.active,
					limit: query.limit,
					offset: query.offset,
				});

				return reply.send({
					templates,
					count: templates.length,
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to list templates");
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to list templates",
				});
			}
		});

		/**
		 * POST /api/trash-guides/templates
		 * Create a new template
		 */
		app.post<{
			Body: z.infer<typeof createTemplateSchema>;
		}>("/", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const body = createTemplateSchema.parse(request.body);

				// Validate template configuration
				const validation = templateService.validateTemplateConfig(body.config);
				if (!validation.valid) {
					return reply.status(400).send({
						statusCode: 400,
						error: "ValidationError",
						message: "Invalid template configuration",
						errors: validation.errors,
					});
				}

				const template = await templateService.createTemplate(request.currentUser.id, body);

				return reply.status(201).send({
					template,
					message: "Template created successfully",
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to create template");

				if (error instanceof Error && error.message.includes("already exists")) {
					return reply.status(409).send({
						statusCode: 409,
						error: "Conflict",
						message: error.message,
					});
				}

				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to create template",
				});
			}
		});

		/**
		 * GET /api/trash-guides/templates/:templateId
		 * Get template by ID
		 */
		app.get<{
			Params: z.infer<typeof getTemplateParamsSchema>;
		}>("/:templateId", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);

				const template = await templateService.getTemplate(templateId, request.currentUser.id);

				if (!template) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: "Template not found",
					});
				}

				return reply.send({ template });
			} catch (error) {
				app.log.error({ err: error }, "Failed to get template");
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to get template",
				});
			}
		});

		/**
		 * PUT /api/trash-guides/templates/:templateId
		 * Update template
		 */
		app.put<{
			Params: z.infer<typeof getTemplateParamsSchema>;
			Body: z.infer<typeof updateTemplateSchema>;
		}>("/:templateId", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);
				const body = updateTemplateSchema.parse(request.body);

				// Validate config if provided
				if (body.config) {
					const validation = templateService.validateTemplateConfig(body.config);
					if (!validation.valid) {
						return reply.status(400).send({
							statusCode: 400,
							error: "ValidationError",
							message: "Invalid template configuration",
							errors: validation.errors,
						});
					}
				}

				const template = await templateService.updateTemplate(
					templateId,
					request.currentUser.id,
					body,
				);

				return reply.send({
					template,
					message: "Template updated successfully",
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to update template");

				if (error instanceof Error && error.message.includes("not found")) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: error.message,
					});
				}

				if (error instanceof Error && error.message.includes("already exists")) {
					return reply.status(409).send({
						statusCode: 409,
						error: "Conflict",
						message: error.message,
					});
				}

				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to update template",
				});
			}
		});

		/**
		 * DELETE /api/trash-guides/templates/:templateId
		 * Delete template
		 */
		app.delete<{
			Params: z.infer<typeof getTemplateParamsSchema>;
		}>("/:templateId", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);

				const deleted = await templateService.deleteTemplate(templateId, request.currentUser.id);

				if (!deleted) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: "Template not found",
					});
				}

				return reply.send({
					message: "Template deleted successfully",
					templateId,
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to delete template");
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to delete template",
				});
			}
		});

		/**
		 * POST /api/trash-guides/templates/:templateId/duplicate
		 * Duplicate template
		 */
		app.post<{
			Params: z.infer<typeof getTemplateParamsSchema>;
			Body: z.infer<typeof duplicateTemplateSchema>;
		}>("/:templateId/duplicate", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);
				const { newName } = duplicateTemplateSchema.parse(request.body);

				const template = await templateService.duplicateTemplate(
					templateId,
					request.currentUser.id,
					newName,
				);

				return reply.status(201).send({
					template,
					message: "Template duplicated successfully",
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to duplicate template");

				if (error instanceof Error && error.message.includes("not found")) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: error.message,
					});
				}

				if (error instanceof Error && error.message.includes("already exists")) {
					return reply.status(409).send({
						statusCode: 409,
						error: "Conflict",
						message: error.message,
					});
				}

				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to duplicate template",
				});
			}
		});

		/**
		 * GET /api/trash-guides/templates/:templateId/export
		 * Export template as JSON
		 */
		app.get<{
			Params: z.infer<typeof getTemplateParamsSchema>;
		}>("/:templateId/export", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);

				const jsonData = await templateService.exportTemplate(templateId, request.currentUser.id);

				reply.header("Content-Type", "application/json");
				reply.header("Content-Disposition", `attachment; filename="template-${templateId}.json"`);

				return reply.send(jsonData);
			} catch (error) {
				app.log.error({ err: error }, "Failed to export template");

				if (error instanceof Error && error.message.includes("not found")) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: error.message,
					});
				}

				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to export template",
				});
			}
		});

		/**
		 * POST /api/trash-guides/templates/import
		 * Import template from JSON
		 */
		app.post<{
			Body: z.infer<typeof importTemplateSchema>;
		}>("/import", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { jsonData } = importTemplateSchema.parse(request.body);

				const template = await templateService.importTemplate(request.currentUser.id, jsonData);

				return reply.status(201).send({
					template,
					message: "Template imported successfully",
				});
			} catch (error) {
				app.log.error({ err: error }, "Failed to import template");

				if (error instanceof SyntaxError) {
					return reply.status(400).send({
						statusCode: 400,
						error: "ValidationError",
						message: "Invalid JSON format",
					});
				}

				if (error instanceof Error && error.message.includes("Invalid template")) {
					return reply.status(400).send({
						statusCode: 400,
						error: "ValidationError",
						message: error.message,
					});
				}

				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to import template",
				});
			}
		});

		/**
		 * GET /api/trash-guides/templates/:templateId/stats
		 * Get template usage statistics
		 */
		app.get<{
			Params: z.infer<typeof getTemplateParamsSchema>;
		}>("/:templateId/stats", async (request, reply) => {
			if (!request.currentUser) {
				return reply.status(401).send({
					statusCode: 401,
					error: "Unauthorized",
					message: "Authentication required",
				});
			}

			try {
				const { templateId } = getTemplateParamsSchema.parse(request.params);

				const stats = await templateService.getTemplateStats(templateId, request.currentUser.id);

				if (!stats) {
					return reply.status(404).send({
						statusCode: 404,
						error: "NotFound",
						message: "Template not found",
					});
				}

				return reply.send({ stats });
			} catch (error) {
				app.log.error({ err: error }, "Failed to get template stats");
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: error instanceof Error ? error.message : "Failed to get template stats",
				});
			}
		});
	},
	{
		name: "trash-template-routes",
	},
);
