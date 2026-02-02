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
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import type { TrashCustomFormat, CustomFormatSpecification } from "@arr/shared";
import type { SonarrClient, RadarrClient } from "arr-sdk";

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
function transformFieldsToArray(
	fields: Record<string, unknown> | Array<{ name: string; value: unknown }> | null | undefined,
): Array<{ name: string; value: unknown }> {
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

	/** Create a fetcher configured for the current user's repo settings */
	async function getFetcher(userId: string) {
		const repoConfig = await getRepoConfig(app.prisma, userId);
		return createTrashFetcher({ repoConfig, logger: app.log });
	}

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
				details: bodyResult.error.issues,
			});
		}

		const { trashIds, instanceId, serviceType } = bodyResult.data;

		try {
			// Get instance - verify ownership by including userId in where clause
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					userId: request.currentUser?.id,
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
				const fetcher = await getFetcher(request.currentUser!.id);
				const data = await fetcher.fetchConfigs(serviceType, "CUSTOM_FORMATS");
				await cacheManager.set(serviceType, "CUSTOM_FORMATS", data);
				allCustomFormats = data as TrashCustomFormat[];
			} else {
				const data = await cacheManager.get<TrashCustomFormat[]>(serviceType, "CUSTOM_FORMATS");
				allCustomFormats = data || [];
			}

			// Filter to only requested custom formats
			const customFormats = allCustomFormats.filter((cf) => trashIds.includes(cf.trash_id));

			if (customFormats.length === 0) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "No matching custom formats found",
				});
			}

			// Create SDK client using factory
			const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;

			// Get existing Custom Formats from instance
			const existingFormats = await client.customFormat.getAll();
			const existingByName = new Map<string, (typeof existingFormats)[number]>();
			for (const cf of existingFormats) {
				if (cf.name) {
					existingByName.set(cf.name, cf);
				}
			}

			// Get the commit hash from cache for tracking
			const cacheEntry = await app.prisma.trashCache.findFirst({
				where: {
					serviceType,
					configType: "CUSTOM_FORMATS",
				},
				select: { commitHash: true },
			});
			const commitHash = cacheEntry?.commitHash ?? "unknown";

			// Deploy each custom format
			const results = {
				created: [] as string[],
				updated: [] as string[],
				failed: [] as Array<{ name: string; error: string }>,
			};

			// Track successful deployments for recording
			const successfulDeployments: Array<{ trashId: string; name: string }> = [];

			for (const customFormat of customFormats) {
				try {
					// Check if custom format already exists by name
					const existing = existingByName.get(customFormat.name);

					// Transform specifications: convert fields from object to array format
					const specifications = (customFormat.specifications || []).map(
						(spec: CustomFormatSpecification) => {
							const transformedFields = transformFieldsToArray(spec.fields);
							return {
								...spec,
								fields: transformedFields,
							};
						},
					);

					if (existing?.id) {
						// Update existing custom format
						// Note: The ARR API expects fields as array, but TRaSH format uses object
						// Using double type assertion to bridge the gap between TRaSH format and SDK types
						const updatedCF = {
							...existing,
							name: customFormat.name,
							specifications,
						};
						await client.customFormat.update(
							existing.id,
							updatedCF as unknown as Parameters<typeof client.customFormat.update>[1],
						);
						results.updated.push(customFormat.name);
						successfulDeployments.push({ trashId: customFormat.trash_id, name: customFormat.name });
					} else {
						// Create new custom format
						// Note: The ARR API expects fields as array, but TRaSH format uses object
						// Using double type assertion to bridge the gap between TRaSH format and SDK types
						const newCF = {
							name: customFormat.name,
							includeCustomFormatWhenRenaming:
								customFormat.includeCustomFormatWhenRenaming ?? false,
							specifications,
						};
						await client.customFormat.create(
							newCF as unknown as Parameters<typeof client.customFormat.create>[0],
						);
						results.created.push(customFormat.name);
						successfulDeployments.push({ trashId: customFormat.trash_id, name: customFormat.name });
					}
				} catch (error) {
					results.failed.push({
						name: customFormat.name,
						error: error instanceof Error ? error.message : "Unknown error",
					});
				}
			}

			// Record successful deployments for update tracking
			if (successfulDeployments.length > 0) {
				const userId = request.currentUser!.id; // preHandler guarantees auth
				await Promise.all(
					successfulDeployments.map((deployment) =>
						app.prisma.standaloneCFDeployment.upsert({
							where: {
								instanceId_cfTrashId: {
									instanceId,
									cfTrashId: deployment.trashId,
								},
							},
							update: {
								cfName: deployment.name,
								commitHash,
								deployedAt: new Date(),
							},
							create: {
								userId,
								instanceId,
								cfTrashId: deployment.trashId,
								cfName: deployment.name,
								serviceType,
								commitHash,
							},
						}),
					),
				);
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
			app.log.error(
				{ err: error, trashIds, instanceId, serviceType },
				"Failed to deploy custom formats",
			);
			return reply.status(500).send({
				error: "DEPLOYMENT_FAILED",
				message: error instanceof Error ? error.message : "Failed to deploy custom formats",
			});
		}
	});

	/**
	 * GET /api/trash-guides/custom-formats/standalone-updates
	 * Check for updates to standalone deployed custom formats
	 * Compares deployed commit hashes against current cache commit hash
	 */
	app.get<{
		Querystring: {
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		};
	}>("/standalone-updates", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, serviceType } = request.query;

		try {
			// Build query filter
			const where: {
				userId: string;
				instanceId?: string;
				serviceType?: "RADARR" | "SONARR";
			} = { userId };

			if (instanceId) {
				where.instanceId = instanceId;
			}
			if (serviceType) {
				where.serviceType = serviceType;
			}

			// Get all standalone deployments for this user
			const deployments = await app.prisma.standaloneCFDeployment.findMany({
				where,
				include: {
					instance: {
						select: {
							label: true,
							service: true,
						},
					},
				},
			});

			if (deployments.length === 0) {
				return reply.send({
					success: true,
					hasUpdates: false,
					updates: [],
					message: "No standalone custom format deployments found",
				});
			}

			// Get current cache commit hashes for each service type
			const serviceTypes = [...new Set(deployments.map((d) => d.serviceType))];
			const cacheCommitHashes = new Map<string, string>();

			for (const svc of serviceTypes) {
				const cache = await app.prisma.trashCache.findFirst({
					where: {
						serviceType: svc,
						configType: "CUSTOM_FORMATS",
					},
					select: { commitHash: true },
				});
				if (cache?.commitHash) {
					cacheCommitHashes.set(svc, cache.commitHash);
				}
			}

			// Compare deployments to current cache
			const updates: Array<{
				cfTrashId: string;
				cfName: string;
				instanceId: string;
				instanceLabel: string;
				serviceType: string;
				deployedCommitHash: string;
				currentCommitHash: string;
			}> = [];

			for (const deployment of deployments) {
				const currentHash = cacheCommitHashes.get(deployment.serviceType);
				if (currentHash && currentHash !== deployment.commitHash) {
					updates.push({
						cfTrashId: deployment.cfTrashId,
						cfName: deployment.cfName,
						instanceId: deployment.instanceId,
						instanceLabel: deployment.instance.label,
						serviceType: deployment.serviceType,
						deployedCommitHash: deployment.commitHash,
						currentCommitHash: currentHash,
					});
				}
			}

			return reply.send({
				success: true,
				hasUpdates: updates.length > 0,
				updates,
				totalDeployed: deployments.length,
				outdatedCount: updates.length,
			});
		} catch (error) {
			app.log.error(
				{ err: error, instanceId, serviceType },
				"Failed to check standalone CF updates",
			);
			return reply.status(500).send({
				error: "CHECK_FAILED",
				message: error instanceof Error ? error.message : "Failed to check for updates",
			});
		}
	});

	/**
	 * GET /api/trash-guides/custom-formats/standalone-deployments
	 * List all standalone CF deployments for the current user
	 */
	app.get<{
		Querystring: {
			instanceId?: string;
			serviceType?: "RADARR" | "SONARR";
		};
	}>("/standalone-deployments", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, serviceType } = request.query;

		try {
			const where: {
				userId: string;
				instanceId?: string;
				serviceType?: "RADARR" | "SONARR";
			} = { userId };

			if (instanceId) {
				where.instanceId = instanceId;
			}
			if (serviceType) {
				where.serviceType = serviceType;
			}

			const deployments = await app.prisma.standaloneCFDeployment.findMany({
				where,
				include: {
					instance: {
						select: {
							label: true,
							service: true,
						},
					},
				},
				orderBy: [{ instanceId: "asc" }, { cfName: "asc" }],
			});

			return reply.send({
				success: true,
				deployments: deployments.map((d) => ({
					id: d.id,
					cfTrashId: d.cfTrashId,
					cfName: d.cfName,
					instanceId: d.instanceId,
					instanceLabel: d.instance.label,
					serviceType: d.serviceType,
					commitHash: d.commitHash,
					deployedAt: d.deployedAt,
				})),
				count: deployments.length,
			});
		} catch (error) {
			app.log.error(
				{ err: error, instanceId, serviceType },
				"Failed to list standalone CF deployments",
			);
			return reply.status(500).send({
				error: "LIST_FAILED",
				message: error instanceof Error ? error.message : "Failed to list deployments",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/custom-formats/standalone-deployments/:id
	 * Remove tracking for a standalone CF deployment (does not remove CF from instance)
	 */
	app.delete<{
		Params: { id: string };
	}>("/standalone-deployments/:id", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { id } = request.params;

		try {
			// Verify ownership
			const deployment = await app.prisma.standaloneCFDeployment.findFirst({
				where: { id, userId },
			});

			if (!deployment) {
				return reply.status(404).send({
					error: "NOT_FOUND",
					message: "Deployment record not found",
				});
			}

			await app.prisma.standaloneCFDeployment.delete({
				where: { id },
			});

			return reply.send({
				success: true,
				message: `Stopped tracking updates for ${deployment.cfName}`,
			});
		} catch (error) {
			app.log.error({ err: error, id }, "Failed to delete standalone CF deployment");
			return reply.status(500).send({
				error: "DELETE_FAILED",
				message: error instanceof Error ? error.message : "Failed to delete deployment record",
			});
		}
	});
}
