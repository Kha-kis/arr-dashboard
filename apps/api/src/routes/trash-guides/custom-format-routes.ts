/**
 * TRaSH Guides Custom Format API Routes
 *
 * Endpoints for deploying individual custom formats to instances
 * Deploys custom formats directly without affecting quality profiles
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { createArrApiClient } from "../../lib/trash-guides/arr-api-client.js";
import type { TrashCustomFormat, CustomFormatSpecification } from "@arr/shared";

// ============================================================================
// Validation Schemas
// ============================================================================

const deployMultipleSchema = z.object({
	trashIds: z.array(z.string()).min(1, "At least one trashId is required"),
	instanceId: z.string().min(1, "instanceId is required"),
	serviceType: z.enum(["RADARR", "SONARR"]),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Transform specification fields from object format to array format
 * This matches the format expected by Radarr/Sonarr API
 */
function transformFieldsToArray(fields: Record<string, unknown> | Array<{ name: string; value: unknown }> | null | undefined): Array<{ name: string; value: unknown }> {
	// If fields is already an array, return it as-is
	if (Array.isArray(fields)) {
		return fields;
	}

	// If fields is undefined or null, return empty array
	if (!fields) {
		return [];
	}

	// Convert object format to array format
	const result = Object.entries(fields).map(([name, value]) => ({
		name,
		value,
	}));
	return result;
}

// ============================================================================
// Route Handlers
// ============================================================================

export async function registerCustomFormatRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				error: "UNAUTHORIZED",
				message: "Authentication required",
			});
		}
	});

	const cacheManager = createCacheManager(app.prisma);
	const fetcher = createTrashFetcher();

	/**
	 * POST /api/trash-guides/custom-formats/deploy-multiple
	 * Deploy multiple custom formats to an instance
	 * Deploys custom formats directly without affecting quality profiles
	 */
	app.post<{
		Body: z.infer<typeof deployMultipleSchema>;
	}>("/deploy-multiple", async (request, reply) => {
		// Validate request body
		const bodyResult = deployMultipleSchema.safeParse(request.body);
		if (!bodyResult.success) {
			return reply.status(400).send({
				error: "VALIDATION_ERROR",
				message: "Invalid request body",
				details: bodyResult.error.errors,
			});
		}

		const { trashIds, instanceId, serviceType } = bodyResult.data;

		try {
			// Get instance - verify ownership by including userId in where clause
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { 
					id: instanceId, 
					userId: request.currentUser!.id 
				},
			});

			if (!instance) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Instance not found",
				});
			}

			// Verify service type matches (case-insensitive)
			if (instance.service.toUpperCase() !== serviceType) {
				return reply.status(400).send({
					error: "SERVICE_MISMATCH",
					message: `Instance is ${instance.service}, but trying to deploy ${serviceType} custom formats`,
				});
			}

			// Get custom formats from cache
			const isFresh = await cacheManager.isFresh(serviceType, "CUSTOM_FORMATS");
			let allCustomFormats: TrashCustomFormat[];

			if (!isFresh) {
				const data = await fetcher.fetchConfigs(serviceType, "CUSTOM_FORMATS");
				await cacheManager.set(serviceType, "CUSTOM_FORMATS", data);
				allCustomFormats = data as TrashCustomFormat[];
			} else {
				const data = await cacheManager.get<TrashCustomFormat[]>(serviceType, "CUSTOM_FORMATS");
				allCustomFormats = data || [];
			}

			// Filter to only requested custom formats
			const customFormats = allCustomFormats.filter((cf) =>
				trashIds.includes(cf.trash_id)
			);

			if (customFormats.length === 0) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "No matching custom formats found",
				});
			}

			// Create Arr API client (matches deployment-executor pattern)
			const arrClient = createArrApiClient(instance, app.encryptor);

			// Get existing Custom Formats from instance
			const existingFormats = await arrClient.getCustomFormats();
			const existingByName = new Map<string, (typeof existingFormats)[number]>();
			for (const cf of existingFormats) {
				existingByName.set(cf.name, cf);
			}

			// Deploy each custom format
			const results = {
				created: [] as string[],
				updated: [] as string[],
				failed: [] as Array<{ name: string; error: string }>,
			};

			for (const customFormat of customFormats) {
				try {
					// Check if custom format already exists by name
					const existing = existingByName.get(customFormat.name);

					// Transform specifications: convert fields from object to array format
					const specifications = (customFormat.specifications || []).map((spec: CustomFormatSpecification) => {
						const transformedFields = transformFieldsToArray(spec.fields);
						return {
							...spec,
							fields: transformedFields,
						};
					});

					if (existing?.id) {
						// Update existing custom format
						// Note: The ARR API expects fields as array, but CustomFormat type uses Record
						// Using type assertion to bridge the gap
						const updatedCF = {
							...existing,
							name: customFormat.name,
							specifications: specifications as unknown as CustomFormatSpecification[],
						};
						await arrClient.updateCustomFormat(existing.id, updatedCF);
						results.updated.push(customFormat.name);
					} else {
						// Create new custom format
						// Note: The ARR API expects fields as array, but CustomFormat type uses Record
						// Using type assertion to bridge the gap
						const newCF = {
							name: customFormat.name,
							includeCustomFormatWhenRenaming: customFormat.includeCustomFormatWhenRenaming ?? false,
							specifications: specifications as unknown as CustomFormatSpecification[],
						};
						await arrClient.createCustomFormat(newCF);
						results.created.push(customFormat.name);
					}
				} catch (error) {
					results.failed.push({
						name: customFormat.name,
						error: error instanceof Error ? error.message : "Unknown error",
					});
				}
			}

			const success = results.failed.length === 0;

			if (success) {
				return reply.send({
					success: true,
					created: results.created,
					updated: results.updated,
					failed: results.failed,
				});
			}
				return reply.status(400).send({
					success: false,
					created: results.created,
					updated: results.updated,
					failed: results.failed,
				});
		} catch (error) {
			app.log.error({ err: error, trashIds, instanceId, serviceType }, "Failed to deploy custom formats");
			return reply.status(500).send({
				error: "DEPLOYMENT_FAILED",
				message: error instanceof Error ? error.message : "Failed to deploy custom formats",
			});
		}
	});
}
