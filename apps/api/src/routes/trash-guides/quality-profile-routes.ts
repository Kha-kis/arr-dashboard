/**
 * TRaSH Guides Quality Profile Routes
 *
 * API endpoints for browsing and importing TRaSH Guides quality profiles
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTemplateService } from "../../lib/trash-guides/template-service.js";
import { createVersionTracker } from "../../lib/trash-guides/version-tracker.js";
import type { TrashQualityProfile, TemplateConfig, GroupCustomFormat, TrashCustomFormat } from "@arr/shared";

// ============================================================================
// Request Schemas
// ============================================================================

const getQualityProfilesSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
});

const importQualityProfileSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
	trashId: z.string(),
	templateName: z.string().min(1).max(100),
	templateDescription: z.string().max(500).optional(),
	// Wizard selections (REQUIRED - legacy mode removed)
	selectedCFGroups: z.array(z.string()),
	customFormatSelections: z.record(z.object({
		selected: z.boolean(),
		scoreOverride: z.number().optional(),
		conditionsEnabled: z.record(z.boolean()),
	})),
});

const updateQualityProfileTemplateSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
	trashId: z.string().optional(), // Optional - not needed when updating existing template
	templateName: z.string().min(1).max(100),
	templateDescription: z.string().max(500).optional(),
	// Wizard selections (REQUIRED - legacy mode removed)
	selectedCFGroups: z.array(z.string()),
	customFormatSelections: z.record(z.object({
		selected: z.boolean(),
		scoreOverride: z.number().optional(),
		conditionsEnabled: z.record(z.boolean()),
	})),
});

// ============================================================================
// Route Handlers
// ============================================================================

export async function registerQualityProfileRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	const fetcher = createTrashFetcher();
	const cacheManager = createCacheManager(app.prisma);
	const templateService = createTemplateService(app.prisma);
	const versionTracker = createVersionTracker();

	/**
	 * GET /api/trash-guides/quality-profiles/:serviceType
	 * List available quality profiles from TRaSH Guides
	 */
	app.get<{
		Params: z.infer<typeof getQualityProfilesSchema>;
	}>("/:serviceType", async (request, reply) => {
		const { serviceType } = getQualityProfilesSchema.parse(request.params);

		try {
			// Try to get from cache first
			let profiles = (await cacheManager.get(
				serviceType,
				"QUALITY_PROFILES",
			)) as TrashQualityProfile[] | null;

			// If cache miss or stale, fetch fresh data
			if (!profiles || !(await cacheManager.isFresh(serviceType, "QUALITY_PROFILES"))) {
				app.log.info({ serviceType }, "Fetching quality profiles from GitHub");
				profiles = await fetcher.fetchQualityProfiles(serviceType);
				await cacheManager.set(serviceType, "QUALITY_PROFILES", profiles);
			}

			// Transform profiles for UI display
			const profilesWithMeta = profiles.map((profile) => ({
				trashId: profile.trash_id,
				name: profile.name,
				description: profile.trash_description,
				scoreSet: profile.trash_score_set,
				upgradeAllowed: profile.upgradeAllowed,
				cutoff: profile.cutoff,
				language: profile.language,
				customFormatCount: Object.keys(profile.formatItems || {}).length,
				qualityCount: profile.items.length,
			}));

			return reply.send({
				profiles: profilesWithMeta,
				count: profilesWithMeta.length,
			});
		} catch (error) {
			app.log.error({ err: error, serviceType }, "Failed to fetch quality profiles");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to fetch quality profiles",
			});
		}
	});

	/**
	 * GET /api/trash-guides/quality-profiles/:serviceType/:trashId
	 * Get detailed quality profile information with applicable CF Groups and Custom Formats
	 */
	app.get<{
		Params: { serviceType: string; trashId: string };
	}>("/:serviceType/:trashId", async (request, reply) => {
		const { serviceType, trashId } = request.params;

		if (!["RADARR", "SONARR"].includes(serviceType)) {
			return reply.status(400).send({
				statusCode: 400,
				error: "BadRequest",
				message: "serviceType must be RADARR or SONARR",
			});
		}

		try {
			// Get quality profile from cache
			const profiles = (await cacheManager.get(
				serviceType as "RADARR" | "SONARR",
				"QUALITY_PROFILES",
			)) as TrashQualityProfile[] | null;

			if (!profiles) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message:
						"Quality profiles not cached. Please refresh cache first at /:serviceType endpoint.",
				});
			}

			const profile = profiles.find((p) => p.trash_id === trashId);

			if (!profile) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: `Quality profile with trash_id ${trashId} not found`,
				});
			}

			// Get CF Groups from cache
			const cfGroups = (await cacheManager.get(
				serviceType as "RADARR" | "SONARR",
				"CF_GROUPS",
			)) as any[] | null;

			// Get Custom Formats from cache
			const customFormats = (await cacheManager.get(
				serviceType as "RADARR" | "SONARR",
				"CUSTOM_FORMATS",
			)) as any[] | null;

			// Get CF Descriptions from cache
			const cfDescriptions = (await cacheManager.get(
				serviceType as "RADARR" | "SONARR",
				"CF_DESCRIPTIONS",
			)) as any[] | null;

			// Build description lookup by CF name (slug format)
			const descriptionMap = new Map<string, any>();
			if (cfDescriptions) {
				for (const desc of cfDescriptions) {
					descriptionMap.set(desc.cfName, desc);
				}
			}

			// Filter CF Groups that apply to this quality profile (not in exclude list)
			// and enrich with full CF details
			const applicableCFGroups = cfGroups?.filter((group) => {
				const isExcluded =
					group.quality_profiles?.exclude &&
					Object.values(group.quality_profiles.exclude).includes(profile.trash_id);
				return !isExcluded;
			}).map((group) => {
				// Enrich each CF in the group with full details
				const enrichedCFs = group.custom_formats?.map((cf: GroupCustomFormat | string) => {
					const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
					const cfName = typeof cf === 'string' ? cf : cf.name;

					// Find the full CF definition
					const fullCF = customFormats?.find((f: TrashCustomFormat) => f.trash_id === cfTrashId);

					// Find description
					let description = null;
					let displayName = cfName;
					if (fullCF) {
						// Try to find description by CF name slug
						const slug = fullCF.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
						const desc = descriptionMap.get(slug);
						if (desc) {
							description = desc.description;
							displayName = desc.displayName || fullCF.name;
						}
					}

					// Get score from CF's trash_scores using profile's trash_score_set
					let score = 0; // Default to 0 for zero-score CFs
					if (fullCF?.trash_scores) {
						const scoreSet = profile.trash_score_set;
						if (scoreSet && fullCF.trash_scores[scoreSet] !== undefined) {
							score = fullCF.trash_scores[scoreSet];
						} else if (fullCF.trash_scores.default !== undefined) {
							score = fullCF.trash_scores.default;
						}
						// else remains 0 (explicit zero for CFs with no scores)
					}

					return {
						trash_id: cfTrashId,
						name: cfName,
						displayName,
						description,
						score,
						required: typeof cf === 'object' ? cf.required === true : false,
						defaultChecked: typeof cf === 'object' && (cf.default === true || cf.default === "true"),
						source: "group" as const, // NEW: Mark as optional (from CF Group)
						...(fullCF && { specifications: fullCF.specifications }),
					};
				}) || [];

				return {
					...group,
					custom_formats: enrichedCFs,
					defaultEnabled: group.default === "true" || group.default === true,
					required: group.required === true,
				};
			}) || [];

			// Get Mandatory Custom Formats directly referenced in the profile (formatItems)
			const mandatoryCFs = [];
			if (profile.formatItems && customFormats) {
				for (const [cfName, cfTrashId] of Object.entries(profile.formatItems)) {
					const customFormat = customFormats.find((cf) => cf.trash_id === cfTrashId);
					if (customFormat) {
						// Try to find description by converting CF name to slug format
						const slug = cfName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
						const description = descriptionMap.get(slug);

						// Get score from CF's trash_scores using profile's trash_score_set
						let score = 0; // Default to 0 for zero-score CFs
						if (customFormat.trash_scores) {
							const scoreSet = profile.trash_score_set;
							if (scoreSet && customFormat.trash_scores[scoreSet] !== undefined) {
								score = customFormat.trash_scores[scoreSet];
							} else if (customFormat.trash_scores.default !== undefined) {
								score = customFormat.trash_scores.default;
							}
							// else remains 0 (explicit zero for CFs with no scores)
						}

						mandatoryCFs.push({
							...customFormat,
							description: description?.description,
							displayName: description?.displayName,
							score,
							source: "profile" as const, // NEW: Mark as mandatory
							locked: true, // NEW: Indicates this CF is mandatory
						});
					}
				}
			}

			// Build a Set of all CF trash_ids from applicable CF Groups
			const cfGroupCFTrashIds = new Set<string>();
			for (const group of applicableCFGroups) {
				if (group.custom_formats && Array.isArray(group.custom_formats)) {
					for (const cf of group.custom_formats) {
						const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
						cfGroupCFTrashIds.add(cfTrashId);
					}
				}
			}

			return reply.send({
				profile,
				mandatoryCFs, // NEW: Separated mandatory CFs
				cfGroups: applicableCFGroups,
				stats: {
					mandatoryCount: mandatoryCFs.length,
					optionalGroupCount: applicableCFGroups.length,
					totalOptionalCFs: cfGroupCFTrashIds.size,
				},
			});
		} catch (error) {
			app.log.error({ err: error, serviceType, trashId }, "Failed to get quality profile");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get quality profile",
			});
		}
	});

	/**
	 * POST /api/trash-guides/quality-profiles/import
	 * Import a quality profile as a template
	 */
	app.post<{
		Body: z.infer<typeof importQualityProfileSchema>;
	}>("/import", async (request, reply) => {
		try {
			const { serviceType, trashId, templateName, templateDescription, selectedCFGroups, customFormatSelections } =
				importQualityProfileSchema.parse(request.body);

			// Get quality profile from cache
			const profiles = (await cacheManager.get(
				serviceType,
				"QUALITY_PROFILES",
			)) as TrashQualityProfile[] | null;

			if (!profiles) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message:
						"Quality profiles not cached. Please browse quality profiles first to populate cache.",
				});
			}

			const profile = profiles.find((p) => p.trash_id === trashId);

			if (!profile) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: `Quality profile with trash_id ${trashId} not found`,
				});
			}

			// Get Custom Formats referenced in the quality profile
			const customFormats = (await cacheManager.get(
				serviceType,
				"CUSTOM_FORMATS",
			)) as any[] | null;

			if (!customFormats) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message:
						"Custom Formats not cached. Please refresh Custom Formats cache first before importing quality profiles.",
				});
			}

			// Build template config from quality profile using wizard selections
			const templateConfig: TemplateConfig = {
				customFormats: [],
				customFormatGroups: [],
				qualityProfile: {
					upgradeAllowed: profile.upgradeAllowed,
					cutoff: profile.cutoff,
					items: profile.items as Array<{
						name: string;
						allowed: boolean;
						items?: string[];
					}>,
					minFormatScore: profile.minFormatScore,
					cutoffFormatScore: profile.cutoffFormatScore,
					minUpgradeFormatScore: profile.minUpgradeFormatScore,
					trash_score_set: profile.trash_score_set, // Store the score set from TRaSH Guides
					language: profile.language, // Store language from TRaSH Guides
				},
			};

			// Get CF Groups for reference storage
			const cfGroups = (await cacheManager.get(
				serviceType,
				"CF_GROUPS",
			)) as any[] | null;

			// Add selected CF Groups
			if (cfGroups) {
				for (const groupTrashId of selectedCFGroups) {
					const group = cfGroups.find((g) => g.trash_id === groupTrashId);
					if (group) {
						templateConfig.customFormatGroups.push({
							trashId: group.trash_id,
							name: group.name,
							enabled: true,
							originalConfig: group,
						});
					}
				}
			}

			// Add selected Custom Formats with user customizations
			for (const [cfTrashId, selection] of Object.entries(customFormatSelections)) {
				if (!selection.selected) continue;

				const customFormat = customFormats.find((cf) => cf.trash_id === cfTrashId);
				if (customFormat) {
					templateConfig.customFormats.push({
						trashId: customFormat.trash_id,
						name: customFormat.name,
						scoreOverride: selection.scoreOverride,
						conditionsEnabled: selection.conditionsEnabled,
						originalConfig: customFormat,
					});
				}
			}

			// Fetch latest TRaSH Guides commit hash for version tracking
			let latestCommitHash: string | undefined;
			try {
				const latestCommit = await versionTracker.getLatestCommit();
				latestCommitHash = latestCommit?.commitHash;
				app.log.info({ commitHash: latestCommitHash }, "Fetched TRaSH Guides commit hash for template import");
			} catch (error) {
				app.log.warn({ err: error }, "Failed to fetch TRaSH Guides commit hash, template will be created without version tracking");
			}

			// Create template
			const template = await templateService.createTemplate(request.currentUser!.id, {
				name: templateName,
				description:
					templateDescription ||
					`Imported from TRaSH Guides: ${profile.name}${profile.trash_description ? ` - ${profile.trash_description}` : ""}`,
				serviceType,
				config: templateConfig,
				sourceQualityProfileTrashId: profile.trash_id,
				sourceQualityProfileName: profile.name,
				trashGuidesCommitHash: latestCommitHash,
			});

			return reply.status(201).send({
				template,
				message: `Successfully imported quality profile "${profile.name}" as template`,
				customFormatsIncluded: templateConfig.customFormats.length,
				customFormatGroupsIncluded: templateConfig.customFormatGroups.length,
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to import quality profile");

			if (error instanceof z.ZodError) {
				return reply.status(400).send({
					statusCode: 400,
					error: "ValidationError",
					message: "Invalid request data",
					errors: error.errors,
				});
			}

			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to import quality profile",
			});
		}
	});

	/**
	 * PUT /api/trash-guides/quality-profiles/update/:templateId
	 * Update an existing quality profile template
	 */
	app.put<{
		Params: { templateId: string };
		Body: z.infer<typeof updateQualityProfileTemplateSchema>;
	}>("/update/:templateId", async (request, reply) => {
		try {
			const { templateId } = request.params;
			const { serviceType, templateName, templateDescription, selectedCFGroups, customFormatSelections } =
				updateQualityProfileTemplateSchema.parse(request.body);

			// Get existing template to preserve quality profile settings
			const existingTemplate = await templateService.getTemplate(
				templateId,
				request.currentUser!.id,
			);

			if (!existingTemplate) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: `Template with ID ${templateId} not found`,
				});
			}

			// Get Custom Formats from cache
			const customFormats = (await cacheManager.get(
				serviceType,
				"CUSTOM_FORMATS",
			)) as any[] | null;

			if (!customFormats) {
				return reply.status(400).send({
					statusCode: 400,
					error: "BadRequest",
					message:
						"Custom Formats not cached. Please refresh Custom Formats cache first before updating templates.",
				});
			}

			// Build template config from quality profile using wizard selections
			// Preserve existing quality profile settings
			const existingConfig = existingTemplate.config;
			const templateConfig: TemplateConfig = {
				customFormats: [],
				customFormatGroups: [],
				qualityProfile: existingConfig.qualityProfile,
			};

			// Get CF Groups for reference storage
			const cfGroups = (await cacheManager.get(
				serviceType,
				"CF_GROUPS",
			)) as any[] | null;

			// Add selected CF Groups
			if (cfGroups) {
				for (const groupTrashId of selectedCFGroups) {
					const group = cfGroups.find((g) => g.trash_id === groupTrashId);
					if (group) {
						templateConfig.customFormatGroups.push({
							trashId: group.trash_id,
							name: group.name,
							enabled: true,
							originalConfig: group,
						});
					}
				}
			}

			// Add selected Custom Formats with user customizations
			for (const [cfTrashId, selection] of Object.entries(customFormatSelections)) {
				if (!selection.selected) continue;

				const customFormat = customFormats.find((cf) => cf.trash_id === cfTrashId);
				if (customFormat) {
					templateConfig.customFormats.push({
						trashId: customFormat.trash_id,
						name: customFormat.name,
						scoreOverride: selection.scoreOverride,
						conditionsEnabled: selection.conditionsEnabled,
						originalConfig: customFormat,
					});
				}
			}

			// Update template
			const template = await templateService.updateTemplate(
				templateId,
				request.currentUser!.id,
				{
					name: templateName,
					description: templateDescription,
					config: templateConfig,
				},
			);

			return reply.send({
				template,
				message: `Successfully updated quality profile template "${templateName}"`,
				customFormatsIncluded: templateConfig.customFormats.length,
				customFormatGroupsIncluded: templateConfig.customFormatGroups.length,
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to update quality profile template");

			if (error instanceof z.ZodError) {
				return reply.status(400).send({
					statusCode: 400,
					error: "ValidationError",
					message: "Invalid request data",
					errors: error.errors,
				});
			}

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
				message: error instanceof Error ? error.message : "Failed to update quality profile template",
			});
		}
	});
}
