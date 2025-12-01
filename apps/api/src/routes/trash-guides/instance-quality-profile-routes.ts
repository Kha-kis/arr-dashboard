/**
 * Instance Quality Profile Routes
 *
 * Routes for managing quality profiles on specific Radarr/Sonarr instances
 */

import { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createArrApiClient } from "../../lib/trash-guides/arr-api-client.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const updateScoresSchema = z.object({
	scoreUpdates: z.array(
		z.object({
			customFormatId: z.number(),
			score: z.number(),
		})
	),
});

// ============================================================================
// Route Handlers
// ============================================================================

const registerInstanceQualityProfileRoutes: FastifyPluginCallback = (app, opts, done) => {
	/**
	 * PATCH /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/scores
	 * Update custom format scores for a quality profile
	 */
	app.patch<{
		Params: { instanceId: string; profileId: string };
		Body: z.infer<typeof updateScoresSchema>;
	}>("/:instanceId/quality-profiles/:profileId/scores", async (request, reply) => {
		// Check authentication
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const { instanceId, profileId} = request.params;
		const profileIdNum = parseInt(profileId);

		if (isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		try {
			// Validate request body
			const { scoreUpdates } = updateScoresSchema.parse(request.body);

			// Get the instance from database
			const instance = await request.server.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					service: {
						in: ["RADARR", "SONARR"],
					},
				},
				select: {
					id: true,
					baseUrl: true,
					service: true,
					encryptedApiKey: true,
					encryptionIv: true,
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found or not a Radarr/Sonarr instance",
				});
			}

			// Create API client using the helper function
			const apiClient = createArrApiClient(
				{
					id: instance.id,
					baseUrl: instance.baseUrl,
					encryptedApiKey: instance.encryptedApiKey,
					encryptionIv: instance.encryptionIv,
					service: instance.service,
				},
				request.server.encryptor
			);

			// Fetch current quality profile
			const profile = await apiClient.getQualityProfile(profileIdNum);

			// Update the formatItems with new scores
			const updatedFormatItems = profile.formatItems.map((item) => {
				const update = scoreUpdates.find((u) => u.customFormatId === item.format);
				if (update) {
					return {
						...item,
						score: update.score,
					};
				}
				return item;
			});

			// Add new format items for custom formats that don't exist yet
			for (const update of scoreUpdates) {
				const exists = profile.formatItems.some((item) => item.format === update.customFormatId);
				if (!exists) {
					updatedFormatItems.push({
						format: update.customFormatId,
						score: update.score,
					});
				}
			}

			// Update the quality profile
			const updatedProfile = {
				...profile,
				formatItems: updatedFormatItems,
			};

			await apiClient.updateQualityProfile(profileIdNum, updatedProfile);

			// Check if this quality profile is managed by a template
			const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
				where: {
					instanceId_qualityProfileId: {
						instanceId,
						qualityProfileId: profileIdNum,
					},
				},
			});

			// Only save instance-level overrides for template-managed profiles
			// Non-template profiles don't need override tracking since they have no template to sync from
			if (templateMapping) {
				for (const update of scoreUpdates) {
					await request.server.prisma.instanceQualityProfileOverride.upsert({
						where: {
							instanceId_qualityProfileId_customFormatId: {
								instanceId,
								qualityProfileId: profileIdNum,
								customFormatId: update.customFormatId,
							},
						},
						create: {
							instanceId,
							qualityProfileId: profileIdNum,
							customFormatId: update.customFormatId,
							score: update.score,
							userId,
						},
						update: {
							score: update.score,
							userId,
							updatedAt: new Date(),
						},
					});
				}

				request.server.log.info(
					{ instanceId, profileId: profileIdNum, scoreUpdates: scoreUpdates.length, templateId: templateMapping.templateId },
					"Saved instance-level score overrides for template-managed profile"
				);
			} else {
				request.server.log.info(
					{ instanceId, profileId: profileIdNum, scoreUpdates: scoreUpdates.length },
					"Skipped override tracking for non-template profile (scores updated in Radarr/Sonarr only)"
				);
			}

			const message = templateMapping
				? `Updated ${scoreUpdates.length} custom format score(s) in quality profile "${profile.name}". Override will persist across template syncs.`
				: `Updated ${scoreUpdates.length} custom format score(s) in quality profile "${profile.name}".`;

			return reply.status(200).send({
				success: true,
				message,
				profileId: profileIdNum,
				profileName: profile.name,
				updatedCount: scoreUpdates.length,
				isTemplateManaged: !!templateMapping,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileId }, "Failed to update quality profile scores");

			if (error instanceof z.ZodError) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Invalid request data",
					errors: error.errors,
				});
			}

			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: "Failed to update quality profile scores",
			});
		}
	});

	/**
	 * GET /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides
	 * Get instance-level score overrides with conflict detection
	 */
	app.get<{
		Params: { instanceId: string; profileId: string };
	}>("/:instanceId/quality-profiles/:profileId/overrides", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId, profileId } = request.params;
		const profileIdNum = parseInt(profileId);

		if (isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		try {
			// Get all overrides for this quality profile
			const overrides = await request.server.prisma.instanceQualityProfileOverride.findMany({
				where: {
					instanceId,
					qualityProfileId: profileIdNum,
				},
				orderBy: {
					updatedAt: "desc",
				},
			});

			return reply.status(200).send({
				success: true,
				overrides,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileId }, "Failed to get overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get overrides",
			});
		}
	});

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/promote-override
	 * Promote instance override to template (updates template for all instances)
	 */
	app.post<{
		Params: { instanceId: string; profileId: string };
		Body: { customFormatId: number; templateId: string };
	}>("/:instanceId/quality-profiles/:profileId/promote-override", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const { instanceId, profileId } = request.params;
		const profileIdNum = parseInt(profileId);
		const { customFormatId, templateId } = request.body;

		if (isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		try {
			// Get the instance override
			const override = await request.server.prisma.instanceQualityProfileOverride.findUnique({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId,
					},
				},
			});

			if (!override) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Override not found",
				});
			}

			// Get the template
			const template = await request.server.prisma.trashTemplate.findUnique({
				where: { id: templateId, userId },
			});

			if (!template) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Template not found or access denied",
				});
			}

			// Parse template config
			let configData: Record<string, any>;
			try {
				configData = JSON.parse(template.configData);
			} catch (parseError) {
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: `Template configData is invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				});
			}

			// Find and update the CF's scoreOverride in the template
			const customFormats = configData.customFormats || [];
			let cfUpdated = false;

			for (const cf of customFormats) {
				// Match by custom format ID (stored in originalConfig)
				if (cf.originalConfig?.id === customFormatId) {
					cf.scoreOverride = override.score;
					cfUpdated = true;
					request.server.log.info(
						{ cfName: cf.name, cfId: customFormatId, newScore: override.score },
						"Updated CF scoreOverride in template"
					);
					break;
				}
			}

			if (!cfUpdated) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Custom Format not found in template",
				});
			}

			// Update template with new scoreOverride
			await request.server.prisma.trashTemplate.update({
				where: { id: templateId },
				data: {
					configData: JSON.stringify(configData),
					hasUserModifications: true,
					lastModifiedAt: new Date(),
					lastModifiedBy: userId,
				},
			});

			// Delete the instance override (now it's in the template)
			await request.server.prisma.instanceQualityProfileOverride.delete({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId,
					},
				},
			});

			return reply.status(200).send({
				success: true,
				message: "Override promoted to template. All instances using this template will receive the updated score on next sync.",
				templateId,
				customFormatId,
				newScore: override.score,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileId, customFormatId }, "Failed to promote override");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to promote override",
			});
		}
	});

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/bulk-overrides
	 * Get overrides for multiple quality profiles in a single request
	 * This is more efficient than fetching overrides for each profile individually
	 */
	app.post<{
		Params: { instanceId: string };
		Body: { profileIds: number[] };
	}>("/:instanceId/quality-profiles/bulk-overrides", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId } = request.params;
		const { profileIds } = request.body;

		if (!Array.isArray(profileIds) || profileIds.length === 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileIds must be a non-empty array of numbers",
			});
		}

		// Validate all profileIds are numbers
		const invalidIds = profileIds.filter(id => typeof id !== 'number' || isNaN(id));
		if (invalidIds.length > 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "All profileIds must be valid numbers",
			});
		}

		try {
			// Fetch all overrides for the specified profiles in a single query
			const overrides = await request.server.prisma.instanceQualityProfileOverride.findMany({
				where: {
					instanceId,
					qualityProfileId: {
						in: profileIds,
					},
				},
				orderBy: {
					qualityProfileId: "asc",
				},
			});

			// Group overrides by profile ID for easier frontend consumption
			const overridesByProfile: Record<number, Array<{
				customFormatId: number;
				score: number;
				updatedAt: Date;
			}>> = {};

			for (const override of overrides) {
				const profileId = override.qualityProfileId;
				if (!overridesByProfile[profileId]) {
					overridesByProfile[profileId] = [];
				}
				overridesByProfile[profileId]!.push({
					customFormatId: override.customFormatId,
					score: override.score,
					updatedAt: override.updatedAt,
				});
			}

			return reply.status(200).send({
				success: true,
				overridesByProfile,
				totalOverrides: overrides.length,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileIds }, "Failed to get bulk overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get bulk overrides",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides/:customFormatId
	 * Delete an instance-level override (revert to template/default score)
	 */
	app.delete<{
		Params: { instanceId: string; profileId: string; customFormatId: string };
	}>("/:instanceId/quality-profiles/:profileId/overrides/:customFormatId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId, profileId, customFormatId } = request.params;
		const profileIdNum = parseInt(profileId);
		const customFormatIdNum = parseInt(customFormatId);

		if (isNaN(profileIdNum) || isNaN(customFormatIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId and customFormatId must be valid numbers",
			});
		}

		try {
			// Check if override exists
			const override = await request.server.prisma.instanceQualityProfileOverride.findUnique({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId: customFormatIdNum,
					},
				},
			});

			if (!override) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Override not found",
				});
			}

			// Get the template mapping to find the template score
			const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
				where: {
					instanceId_qualityProfileId: {
						instanceId,
						qualityProfileId: profileIdNum,
					},
				},
				include: {
					template: true,
				},
			});

			if (!templateMapping) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Quality profile is not managed by a template",
				});
			}

			// Parse template config to get the template score for this custom format
			let templateConfigReset: Record<string, any>;
			try {
				templateConfigReset = JSON.parse(templateMapping.template.configData);
			} catch (parseError) {
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: `Template configData is invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				});
			}
			const templateCf = templateConfigReset.customFormats?.find(
				(cf: any) => cf.originalConfig?.id === customFormatIdNum
			);

			// Calculate the template score (if CF not in template, default to 0)
			// This can happen if the CF was manually added or the template was updated
			let templateScore = 0;
			if (templateCf) {
				// Priority 1: User's score override from wizard
				if (templateCf.scoreOverride !== undefined) {
					templateScore = templateCf.scoreOverride;
				}
				// Priority 2: TRaSH Guides score from template's score set
				else if (templateConfigReset.scoreSet && templateCf.originalConfig?.trash_scores?.[templateConfigReset.scoreSet] !== undefined) {
					templateScore = templateCf.originalConfig.trash_scores[templateConfigReset.scoreSet];
				}
				// Priority 3: TRaSH Guides default score
				else if (templateCf.originalConfig?.trash_scores?.default !== undefined) {
					templateScore = templateCf.originalConfig.trash_scores.default;
				}
				// Priority 4: Explicit zero (CF exists in template but has no score)
				// remains 0
			}

			// Get the instance from database
			const instance = await request.server.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					service: {
						in: ["RADARR", "SONARR"],
					},
				},
				select: {
					id: true,
					baseUrl: true,
					service: true,
					encryptedApiKey: true,
					encryptionIv: true,
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found or not a Radarr/Sonarr instance",
				});
			}

			// Create API client
			const apiClient = createArrApiClient(
				{
					id: instance.id,
					baseUrl: instance.baseUrl,
					encryptedApiKey: instance.encryptedApiKey,
					encryptionIv: instance.encryptionIv,
					service: instance.service,
				},
				request.server.encryptor
			);

			// Fetch current quality profile
			const profile = await apiClient.getQualityProfile(profileIdNum);

			// Update the formatItems with the template score
			const updatedFormatItems = profile.formatItems.map((item) => {
				if (item.format === customFormatIdNum) {
					return {
						...item,
						score: templateScore,
					};
				}
				return item;
			});

			// Update the quality profile in Radarr/Sonarr
			const updatedProfile = {
				...profile,
				formatItems: updatedFormatItems,
			};

			await apiClient.updateQualityProfile(profileIdNum, updatedProfile);

			// Delete the override from database
			await request.server.prisma.instanceQualityProfileOverride.delete({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId,
						qualityProfileId: profileIdNum,
						customFormatId: customFormatIdNum,
					},
				},
			});

			request.server.log.info(
				{ instanceId, profileId: profileIdNum, customFormatId: customFormatIdNum, templateScore, cfInTemplate: !!templateCf },
				"Deleted instance-level score override and reverted to template score"
			);

			const message = templateCf
				? `Override removed. Score reverted to template value (${templateScore}).`
				: `Override removed. Score set to 0 (custom format not in template).`;

			return reply.status(200).send({
				success: true,
				message,
				customFormatId: customFormatIdNum,
				revertedScore: templateScore,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileId, customFormatId }, "Failed to delete override");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to delete override",
			});
		}
	});

	/**
	 * POST /api/trash-guides/instances/:instanceId/quality-profiles/:profileId/overrides/bulk-delete
	 * Delete multiple instance-level overrides in one operation
	 */
	app.post<{
		Params: { instanceId: string; profileId: string };
		Body: { customFormatIds: number[] };
	}>("/:instanceId/quality-profiles/:profileId/overrides/bulk-delete", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId, profileId } = request.params;
		const profileIdNum = parseInt(profileId);
		const { customFormatIds } = request.body;

		if (isNaN(profileIdNum)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "profileId must be a valid number",
			});
		}

		if (!Array.isArray(customFormatIds) || customFormatIds.length === 0) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "customFormatIds must be a non-empty array",
			});
		}

		try {
			// Get the template mapping to find template scores
			const templateMapping = await request.server.prisma.templateQualityProfileMapping.findUnique({
				where: {
					instanceId_qualityProfileId: {
						instanceId,
						qualityProfileId: profileIdNum,
					},
				},
				include: {
					template: true,
				},
			});

			if (!templateMapping) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message: "Quality profile is not managed by a template",
				});
			}

			// Parse template config
			let templateConfigParsed: Record<string, any>;
			try {
				templateConfigParsed = JSON.parse(templateMapping.template.configData);
			} catch (parseError) {
				return reply.status(500).send({
					statusCode: 500,
					error: "InternalServerError",
					message: `Template configData is invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				});
			}

			// Get the instance from database
			const instance = await request.server.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					service: {
						in: ["RADARR", "SONARR"],
					},
				},
				select: {
					id: true,
					baseUrl: true,
					service: true,
					encryptedApiKey: true,
					encryptionIv: true,
				},
			});

			if (!instance) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: "Instance not found or not a Radarr/Sonarr instance",
				});
			}

			// Create API client
			const apiClient = createArrApiClient(
				{
					id: instance.id,
					baseUrl: instance.baseUrl,
					encryptedApiKey: instance.encryptedApiKey,
					encryptionIv: instance.encryptionIv,
					service: instance.service,
				},
				request.server.encryptor
			);

			// Fetch current quality profile
			const profile = await apiClient.getQualityProfile(profileIdNum);

			// Build a map of customFormatId -> template score
			const templateScores = new Map<number, number>();
			for (const cfId of customFormatIds) {
				const templateCf = templateConfigParsed.customFormats?.find(
					(cf: any) => cf.originalConfig?.id === cfId
				);
				if (templateCf) {
					// Priority 1: User's score override from wizard
					let score = 0;
					if (templateCf.scoreOverride !== undefined) {
						score = templateCf.scoreOverride;
					}
					// Priority 2: TRaSH Guides score from template's score set
					else if (templateConfigParsed.scoreSet && templateCf.originalConfig?.trash_scores?.[templateConfigParsed.scoreSet] !== undefined) {
						score = templateCf.originalConfig.trash_scores[templateConfigParsed.scoreSet];
					}
					// Priority 3: TRaSH Guides default score
					else if (templateCf.originalConfig?.trash_scores?.default !== undefined) {
						score = templateCf.originalConfig.trash_scores.default;
					}
					// Priority 4: Explicit zero (remains 0)

					templateScores.set(cfId, score);
				}
			}

			// Update the formatItems with template scores for the specified CFs
			const updatedFormatItems = profile.formatItems.map((item) => {
				if (templateScores.has(item.format)) {
					return {
						...item,
						score: templateScores.get(item.format)!,
					};
				}
				return item;
			});

			// Update the quality profile in Radarr/Sonarr
			const updatedProfile = {
				...profile,
				formatItems: updatedFormatItems,
			};

			await apiClient.updateQualityProfile(profileIdNum, updatedProfile);

			// Delete all specified overrides from database
			const result = await request.server.prisma.instanceQualityProfileOverride.deleteMany({
				where: {
					instanceId,
					qualityProfileId: profileIdNum,
					customFormatId: {
						in: customFormatIds,
					},
				},
			});

			request.server.log.info(
				{ instanceId, profileId: profileIdNum, count: result.count },
				"Bulk deleted instance-level score overrides and reverted to template scores"
			);

			return reply.status(200).send({
				success: true,
				message: `Removed ${result.count} override(s). Scores reverted to template values.`,
				deletedCount: result.count,
			});
		} catch (error) {
			request.server.log.error({ err: error, instanceId, profileId }, "Failed to bulk delete overrides");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to bulk delete overrides",
			});
		}
	});

	done();
};

export default registerInstanceQualityProfileRoutes;
