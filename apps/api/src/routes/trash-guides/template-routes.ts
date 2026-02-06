/**
 * TRaSH Guides Template API Routes
 *
 * Endpoints for template CRUD operations, import/export, and statistics
 */

import type { TemplateConfig } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { createDeploymentExecutorService } from "../../lib/trash-guides/deployment-executor.js";
import { createTemplateService } from "../../lib/trash-guides/template-service.js";
import { parseInstanceOverrides } from "../../lib/trash-guides/utils.js";

// ============================================================================
// Request Schemas
// ============================================================================

// Custom Format Specification schema (validates TRaSH CF structure)
const customFormatSpecificationSchema = z.object({
	name: z.string(),
	implementation: z.string(),
	negate: z.boolean(),
	required: z.boolean(),
	fields: z.record(z.string(), z.unknown()),
});

// TRaSH Custom Format schema (for originalConfig in template CFs)
const trashCustomFormatSchema = z.object({
	trash_id: z.string(),
	name: z.string(),
	score: z.number().optional(),
	trash_scores: z.record(z.string(), z.number()).optional(),
	trash_description: z.string().optional(),
	includeCustomFormatWhenRenaming: z.boolean().optional(),
	specifications: z.array(customFormatSpecificationSchema),
	// Optional metadata for instance-sourced CFs
	_source: z.enum(["instance", "trash"]).optional(),
	_instanceId: z.string().optional(),
	_instanceCFId: z.number().optional(),
});

// Group Custom Format schema (CFs within a group)
const groupCustomFormatSchema = z.union([
	z.object({
		name: z.string(),
		trash_id: z.string(),
		required: z.boolean(),
		default: z.union([z.string(), z.boolean()]).optional(),
	}),
	z.string(), // Can also be just a trash_id string
]);

// TRaSH Custom Format Group schema (for originalConfig in template groups)
const trashCustomFormatGroupSchema = z.object({
	trash_id: z.string(),
	name: z.string(),
	trash_description: z.string().optional(),
	default: z.union([z.string(), z.boolean()]).optional(),
	required: z.boolean().optional(),
	custom_formats: z.array(groupCustomFormatSchema),
	quality_profiles: z
		.object({
			exclude: z.record(z.string(), z.string()).optional(),
			include: z.record(z.string(), z.string()).optional(),
			score: z.number().optional(),
		})
		.optional(),
});

// TRaSH Quality Size schema
const trashQualitySizeSchema = z.object({
	type: z.string(),
	preferred: z.boolean().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
});

// TRaSH Naming Scheme schema
const trashNamingSchemeSchema = z.object({
	type: z.enum(["movie", "series"]),
	standard: z.string().optional(),
	folder: z.string().optional(),
	season_folder: z.string().optional(),
});

// CF Origin type
const cfOriginSchema = z.enum(["trash_sync", "user_added", "imported"]).optional();

// Sync settings schema
const templateSyncSettingsSchema = z.object({
	deleteRemovedCFs: z.boolean().optional(),
});

// Quality profile schema (TRaSH-style profile settings)
const qualityProfileSchema = z.object({
	upgradeAllowed: z.boolean().optional(),
	cutoff: z.string().optional(),
	items: z
		.array(
			z.object({
				name: z.string(),
				allowed: z.boolean(),
				items: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	minUpgradeFormatScore: z.number().optional(),
	trash_score_set: z.string().optional(),
	language: z.string().optional(),
});

// Quality item schema (single quality definition)
const templateQualityItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	allowed: z.boolean(),
	source: z.string().optional(),
	resolution: z.number().optional(),
});

// Quality group schema (group of equivalent qualities)
const templateQualityGroupSchema = z.object({
	id: z.string(),
	name: z.string(),
	allowed: z.boolean(),
	qualities: z.array(
		z.object({
			name: z.string(),
			source: z.string().optional(),
			resolution: z.number().optional(),
		}),
	),
});

// Quality entry schema (discriminated union of item or group)
const templateQualityEntrySchema = z.union([
	z.object({ type: z.literal("quality"), item: templateQualityItemSchema }),
	z.object({ type: z.literal("group"), group: templateQualityGroupSchema }),
]);

// Custom quality configuration schema
const customQualityConfigSchema = z.object({
	useCustomQualities: z.boolean(),
	items: z.array(templateQualityEntrySchema),
	cutoffId: z.string().optional(),
	customizedAt: z.string().optional(),
	origin: z.enum(["trash_profile", "instance_clone", "manual", "instance"]).optional(),
});

// Complete quality profile schema — permissive record for deeply nested external data
const completeQualityProfileSchema = z.record(z.string(), z.unknown());

const templateConfigSchema = z.object({
	customFormats: z.array(
		z.object({
			trashId: z.string(),
			name: z.string(),
			score: z.number().optional(), // Deprecated but still accepted
			scoreOverride: z.number().optional(),
			conditionsEnabled: z.record(z.string(), z.boolean()),
			originalConfig: trashCustomFormatSchema,
			origin: cfOriginSchema,
			addedAt: z.string().optional(),
			deprecated: z.boolean().optional(),
			deprecatedAt: z.string().optional(),
			deprecatedReason: z.string().optional(),
		}),
	),
	customFormatGroups: z.array(
		z.object({
			trashId: z.string(),
			name: z.string(),
			enabled: z.boolean(),
			originalConfig: trashCustomFormatGroupSchema,
			origin: cfOriginSchema,
			addedAt: z.string().optional(),
			deprecated: z.boolean().optional(),
			deprecatedAt: z.string().optional(),
			deprecatedReason: z.string().optional(),
		}),
	),
	qualityProfile: qualityProfileSchema.optional(),
	qualitySize: z.array(trashQualitySizeSchema).optional(),
	naming: z.array(trashNamingSchemeSchema).optional(),
	completeQualityProfile: completeQualityProfileSchema.optional(),
	syncSettings: templateSyncSettingsSchema.optional(),
	customQualityConfig: customQualityConfigSchema.optional(),
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
	includeDeleted: z
		.string()
		.optional()
		.transform((val) => val === "true"),
	active: z
		.string()
		.optional()
		.transform((val) => {
			if (val === "true") return true;
			if (val === "false") return false;
			return undefined;
		}),
	search: z.string().optional(),
	sortBy: z.enum(["name", "createdAt", "updatedAt", "usageCount"]).optional(),
	sortOrder: z.enum(["asc", "desc"]).optional(),
	limit: z
		.string()
		.optional()
		.transform((val) => {
			if (!val) return undefined;
			const parsed = Number.parseInt(val, 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
		}),
	offset: z
		.string()
		.optional()
		.transform((val) => {
			if (!val) return undefined;
			const parsed = Number.parseInt(val, 10);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
		}),
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

export async function registerTemplateRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	const templateService = createTemplateService(app.prisma);

	/**
	 * GET /api/trash-guides/templates
	 * List all templates for current user
	 */
	app.get<{
		Querystring: z.infer<typeof listTemplatesQuerySchema>;
	}>("/", async (request, reply) => {
		try {
			const query = listTemplatesQuerySchema.parse(request.query);

			const templates = await templateService.listTemplates({
				userId: request.currentUser!.id, // preHandler guarantees auth
				serviceType: query.serviceType,
				includeDeleted: query.includeDeleted,
				active: query.active,
				search: query.search,
				sortBy: query.sortBy,
				sortOrder: query.sortOrder,
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

			const template = await templateService.createTemplate(request.currentUser!.id, body);

			return reply.status(201).send({ template });
		} catch (error) {
			app.log.error({ err: error }, "Failed to create template");
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
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);

			const template = await templateService.getTemplate(templateId, request.currentUser!.id);

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
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);
			const body = updateTemplateSchema.parse(request.body);

			// Validate template configuration if provided
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
				request.currentUser!.id,
				body,
			);

			return reply.send({ template });
		} catch (error) {
			app.log.error({ err: error }, "Failed to update template");

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
				message: error instanceof Error ? error.message : "Failed to update template",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/templates/:templateId
	 * Delete template (soft delete)
	 */
	app.delete<{
		Params: z.infer<typeof getTemplateParamsSchema>;
	}>("/:templateId", async (request, reply) => {
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);

			await templateService.deleteTemplate(templateId, request.currentUser!.id);

			return reply.send({
				message: "Template deleted successfully",
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to delete template");

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
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);
			const { newName } = duplicateTemplateSchema.parse(request.body);

			const template = await templateService.duplicateTemplate(
				templateId,
				request.currentUser!.id,
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
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);

			const jsonData = await templateService.exportTemplate(templateId, request.currentUser!.id);

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
		try {
			const { jsonData } = importTemplateSchema.parse(request.body);

			const template = await templateService.importTemplate(request.currentUser!.id, jsonData);

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
		try {
			const { templateId } = getTemplateParamsSchema.parse(request.params);

			const stats = await templateService.getTemplateStats(templateId, request.currentUser!.id);

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

	// ============================================================================
	// Instance Override Management (Phase 4.2)
	// ============================================================================

	/**
	 * GET /api/trash-guides/templates/:templateId/instance-overrides/:instanceId
	 * Get instance-specific overrides for a template
	 */
	app.get<{
		Params: { templateId: string; instanceId: string };
	}>("/:templateId/instance-overrides/:instanceId", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.params;

			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found",
				});
			}

			const instanceOverrides = parseInstanceOverrides(
				template.instanceOverrides,
				{ templateId, operation: "get" },
				app.log,
			);
			const rawOverride = (instanceOverrides[instanceId] as Record<string, unknown>) || {};

			// Transform storage field names back to API field names for frontend consistency
			// Storage uses: cfScoreOverrides, cfSelectionOverrides
			// API uses: scoreOverrides, cfOverrides
			const transformedOverrides: Record<string, unknown> = {
				...rawOverride,
			};

			// Map cfScoreOverrides → scoreOverrides
			if ("cfScoreOverrides" in rawOverride) {
				transformedOverrides.scoreOverrides = rawOverride.cfScoreOverrides;
				transformedOverrides.cfScoreOverrides = undefined;
			}

			// Map cfSelectionOverrides → cfOverrides
			if ("cfSelectionOverrides" in rawOverride) {
				transformedOverrides.cfOverrides = rawOverride.cfSelectionOverrides;
				transformedOverrides.cfSelectionOverrides = undefined;
			}

			return reply.send({
				templateId,
				instanceId,
				overrides: transformedOverrides,
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to get instance overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get instance overrides",
			});
		}
	});

	/**
	 * PUT /api/trash-guides/templates/:templateId/instance-overrides/:instanceId
	 * Update instance-specific overrides for a template
	 * Supports: CF score overrides, CF selection overrides, and quality config override
	 */
	app.put<{
		Params: { templateId: string; instanceId: string };
		Body: {
			scoreOverrides?: Record<string, number>;
			cfOverrides?: Record<string, { enabled: boolean }>;
			qualityConfigOverride?: {
				useCustomQualities: boolean;
				items: Array<unknown>;
				cutoffId?: string;
				customizedAt?: string;
				origin?: string;
			} | null; // null to clear the override
		};
	}>("/:templateId/instance-overrides/:instanceId", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.params;
			const { scoreOverrides, cfOverrides, qualityConfigOverride } = request.body;

			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found",
				});
			}

			// Parse existing overrides with error handling for malformed JSON
			const instanceOverrides = parseInstanceOverrides(
				template.instanceOverrides,
				{ templateId, operation: "update" },
				app.log,
			);

			// Get existing override for this instance to preserve fields not being updated
			const existingOverride = (instanceOverrides[instanceId] as Record<string, unknown>) || {};

			// Update overrides for this instance (merge with existing)
			const updatedOverride: Record<string, unknown> = {
				...existingOverride,
				instanceId,
				lastModifiedAt: new Date().toISOString(),
				lastModifiedBy: request.currentUser!.id,
			};

			// Update score overrides if provided
			if (scoreOverrides !== undefined) {
				updatedOverride.cfScoreOverrides = scoreOverrides;
			}

			// Update CF selection overrides if provided
			if (cfOverrides !== undefined) {
				updatedOverride.cfSelectionOverrides = cfOverrides;
			}

			// Update quality config override if provided (null clears it)
			if (qualityConfigOverride !== undefined) {
				if (qualityConfigOverride === null) {
					updatedOverride.qualityConfigOverride = undefined;
				} else {
					updatedOverride.qualityConfigOverride = qualityConfigOverride;
				}
			}

			instanceOverrides[instanceId] = updatedOverride;

			// Save back to database
			await app.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					instanceOverrides: JSON.stringify(instanceOverrides),
					updatedAt: new Date(),
				},
			});

			return reply.send({
				success: true,
				message: "Instance overrides updated successfully",
				overrides: instanceOverrides[instanceId],
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to update instance overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to update instance overrides",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/templates/:templateId/instance-overrides/:instanceId
	 * Remove instance-specific overrides for a template
	 */
	app.delete<{
		Params: { templateId: string; instanceId: string };
	}>("/:templateId/instance-overrides/:instanceId", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.params;

			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found",
				});
			}

			// Parse existing overrides with error handling for malformed JSON
			let instanceOverrides: Record<string, unknown> = {};
			if (template.instanceOverrides) {
				try {
					instanceOverrides = JSON.parse(template.instanceOverrides);
				} catch {
					app.log.warn({ templateId }, "Malformed instanceOverrides JSON, clearing corrupted data");
					// Clear corrupted JSON data in database
					try {
						await app.prisma.trashTemplate.update({
							where: { id: templateId },
							data: {
								instanceOverrides: JSON.stringify({}),
								updatedAt: new Date(),
							},
						});
						return reply.send({
							success: true,
							message: "Corrupted instance overrides cleared successfully",
						});
					} catch (dbError) {
						app.log.error(
							{ err: dbError, templateId },
							"Failed to clear corrupted instanceOverrides",
						);
						return reply.status(500).send({
							statusCode: 500,
							error: "InternalServerError",
							message: "Failed to repair corrupted instance overrides",
						});
					}
				}
			}

			// Remove overrides for this instance
			delete instanceOverrides[instanceId];

			// Save back to database
			await app.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					instanceOverrides: JSON.stringify(instanceOverrides),
					updatedAt: new Date(),
				},
			});

			return reply.send({
				success: true,
				message: "Instance overrides removed successfully",
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to remove instance overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to remove instance overrides",
			});
		}
	});

	/**
	 * POST /api/trash-guides/templates/deployment/execute
	 * Execute deployment to a single instance
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceId: string;
		};
	}>("/deployment/execute", async (request, reply) => {
		try {
			const { templateId, instanceId } = request.body;

			if (!templateId || !instanceId) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "templateId and instanceId are required",
				});
			}

			// Verify template belongs to user
			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found",
				});
			}

			// Verify instance exists
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found",
				});
			}

			// Execute deployment
			const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.encryptor);
			const result = await deploymentExecutor.deploySingleInstance(
				templateId,
				instanceId,
				request.currentUser!.id,
			);

			return reply.send({
				success: result.success,
				result,
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to execute deployment");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to execute deployment",
			});
		}
	});

	/**
	 * POST /api/trash-guides/templates/deployment/bulk
	 * Execute bulk deployment to multiple instances
	 */
	app.post<{
		Body: {
			templateId: string;
			instanceIds: string[];
		};
	}>("/deployment/bulk", async (request, reply) => {
		try {
			const { templateId, instanceIds } = request.body;

			if (!templateId || !instanceIds || !Array.isArray(instanceIds)) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "templateId and instanceIds array are required",
				});
			}

			if (instanceIds.length === 0) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "At least one instance ID is required",
				});
			}

			// Verify template belongs to user
			const template = await app.prisma.trashTemplate.findFirst({
				where: {
					id: templateId,
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found",
				});
			}

			// Verify all instances exist
			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					id: { in: instanceIds },
					userId: request.currentUser!.id, // preHandler guarantees auth
				},
			});

			if (instances.length !== instanceIds.length) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "One or more instances not found or not owned by user",
				});
			}

			// Execute bulk deployment
			const deploymentExecutor = createDeploymentExecutorService(app.prisma, app.encryptor);
			const result = await deploymentExecutor.deployBulkInstances(
				templateId,
				instanceIds,
				request.currentUser!.id,
			);

			return reply.send({
				success: result.successfulInstances > 0,
				result,
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to execute bulk deployment");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to execute bulk deployment",
			});
		}
	});
}
