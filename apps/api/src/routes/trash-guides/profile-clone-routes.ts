/**
 * Quality Profile Clone API Routes
 *
 * Routes for importing complete quality profiles from *arr instances
 */

import { FastifyPluginCallback } from "fastify";
import { createProfileCloner } from "../../lib/trash-guides/profile-cloner.js";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { createCFMatcher, type InstanceCustomFormat } from "../../lib/trash-guides/cf-matcher.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTemplateService } from "../../lib/trash-guides/template-service.js";
import type { CompleteQualityProfile, TrashQualityProfile, TrashCustomFormatGroup, TrashCustomFormat, TemplateConfig } from "@arr/shared";

// ============================================================================
// Routes
// ============================================================================

const profileCloneRoutes: FastifyPluginCallback = (app, opts, done) => {
	/**
	 * POST /api/trash-guides/profile-clone/import
	 * Import complete quality profile from *arr instance
	 */
	app.post("/import", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const {
			instanceId,
			profileId,
		} = request.body as {
			instanceId: string;
			profileId: number;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.importQualityProfile({
				instanceId,
				profileId,
				userId,
			});

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: {
					profile: result.profile,
				},
			});
		} catch (error) {
			app.log.error(`Failed to import quality profile: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to import profile",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/preview
	 * Preview deployment of complete quality profile
	 */
	app.post("/preview", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const {
			instanceId,
			profile,
			customFormats,
		} = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.previewProfileDeployment(
				instanceId,
				userId,
				profile,
				customFormats,
			);

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: result.preview,
			});
		} catch (error) {
			app.log.error(`Failed to preview profile deployment: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to preview deployment",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/deploy
	 * Deploy complete quality profile to *arr instance
	 */
	app.post("/deploy", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const {
			instanceId,
			profile,
			customFormats,
			profileName,
			existingProfileId,
		} = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
			profileName: string;
			existingProfileId?: number;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.deployCompleteProfile(
				instanceId,
				userId,
				profile,
				customFormats,
				{
					profileName,
					existingProfileId,
				},
			);

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: {
					profileId: result.profileId,
				},
			});
		} catch (error) {
			app.log.error(`Failed to deploy complete profile: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to deploy profile",
			});
		}
	});

	/**
	 * GET /api/trash-guides/profile-clone/profiles/:instanceId
	 * Get list of quality profiles from an instance
	 */
	app.get("/profiles/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const { instanceId } = request.params as { instanceId: string };

		try {
			// Get instance - ServiceInstances are shared across all authenticated users
			// (no per-user ownership model; security is at the authentication layer)
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.status(404).send({
					success: false,
					error: "Instance not found",
				});
			}

			// Create instance fetcher and fetch quality profiles
			const fetcher = createInstanceFetcher(app, instance);
			const response = await fetcher("/api/v3/qualityprofile");

			const profiles = await response.json();

			// Helper to find cutoff quality name from profile items
			// The cutoff ID can match:
			// 1. A single quality item (item.quality.id)
			// 2. A quality group (item.id with item.name, has item.items)
			// 3. A quality inside a group (subItem.quality.id or subItem.id)
			const findCutoffQualityName = (items: any[], cutoffId: number): string | undefined => {
				for (const item of items) {
					// Check if this is a single quality item matching the cutoff
					if (item.quality?.id === cutoffId) {
						return item.quality.name;
					}
					// Check if this is a quality GROUP matching the cutoff (group has id + name + items)
					if (item.id === cutoffId && item.name && item.items) {
						return item.name;
					}
					// Check if this is a group containing the cutoff quality
					if (item.items && Array.isArray(item.items)) {
						for (const subItem of item.items) {
							// Sub-items can have quality wrapper or direct id/name
							if (subItem.quality?.id === cutoffId) {
								return subItem.quality.name;
							}
							if (subItem.id === cutoffId && subItem.name) {
								return subItem.name;
							}
						}
					}
				}
				return undefined;
			};

			return reply.status(200).send({
				success: true,
				data: {
					profiles: profiles.map((p: any) => {
						// Resolve cutoff ID to quality name from profile items
						const cutoffName = p.cutoff ? findCutoffQualityName(p.items || [], p.cutoff) : undefined;
						return {
							id: p.id,
							name: p.name,
							upgradeAllowed: p.upgradeAllowed,
							cutoff: p.cutoff,
							cutoffQuality: cutoffName ? { id: p.cutoff, name: cutoffName } : undefined,
							minFormatScore: p.minFormatScore,
							formatItemsCount: p.formatItems?.length || 0,
						};
					}),
				},
			});
		} catch (error) {
			app.log.error(`Failed to fetch quality profiles: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to fetch profiles",
			});
		}
	});

	/**
	 * GET /api/trash-guides/profile-clone/profile-details/:instanceId/:profileId
	 * Get detailed quality profile with custom formats from an instance
	 */
	app.get("/profile-details/:instanceId/:profileId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId, profileId } = request.params as {
			instanceId: string;
			profileId: string;
		};

		try {
			// Get instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.status(404).send({
					success: false,
					error: "Instance not found",
				});
			}

			// Create instance fetcher
			const fetcher = createInstanceFetcher(app, instance);

			// Fetch the quality profile
			const profileResponse = await fetcher(`/api/v3/qualityprofile/${profileId}`);
			const profile = await profileResponse.json();

			// Fetch all custom formats from the instance
			const cfResponse = await fetcher("/api/v3/customformat");
			const allCustomFormats = await cfResponse.json();

			// Get the CFs used in this profile (from formatItems)
			const profileCFIds = new Set(
				(profile.formatItems || []).map((item: { format: number }) => item.format)
			);

			// Filter to only CFs used in the profile and include score
			const profileCustomFormats = allCustomFormats
				.filter((cf: { id: number }) => profileCFIds.has(cf.id))
				.map((cf: { id: number; name: string; specifications?: unknown[]; includeCustomFormatWhenRenaming?: boolean }) => {
					const formatItem = profile.formatItems?.find(
						(item: { format: number; score: number }) => item.format === cf.id
					);
					return {
						id: cf.id,
						name: cf.name,
						trash_id: `instance-cf-${cf.id}`, // Placeholder trash_id for instance CFs
						score: formatItem?.score ?? 0,
						specifications: cf.specifications,
						includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
					};
				});

			return reply.status(200).send({
				success: true,
				data: {
					profile: {
						id: profile.id,
						name: profile.name,
						upgradeAllowed: profile.upgradeAllowed,
						cutoff: profile.cutoff,
						minFormatScore: profile.minFormatScore,
						cutoffFormatScore: profile.cutoffFormatScore,
						items: profile.items,
					},
					customFormats: profileCustomFormats,
					// Include all CFs for browse section (adds trash_id placeholder for template creation)
					allCustomFormats: allCustomFormats.map((cf: { id: number; name: string; specifications?: unknown[]; includeCustomFormatWhenRenaming?: boolean }) => ({
						id: cf.id,
						name: cf.name,
						trash_id: `instance-cf-${cf.id}`, // Placeholder trash_id for instance CFs
						specifications: cf.specifications,
						includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
					})),
				},
			});
		} catch (error) {
			app.log.error(`Failed to fetch profile details: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to fetch profile details",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/validate-cfs
	 * Validate Custom Formats from instance profile against TRaSH Guides cache
	 * Used when cloning a profile to identify which CFs match TRaSH Guides
	 */
	app.post("/validate-cfs", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { instanceId, profileId, serviceType } = request.body as {
			instanceId: string;
			profileId: number;
			serviceType: "RADARR" | "SONARR";
		};

		if (!instanceId || profileId === undefined || !serviceType) {
			return reply.status(400).send({
				success: false,
				error: "Missing required fields: instanceId, profileId, serviceType",
			});
		}

		try {
			// Get instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.status(404).send({
					success: false,
					error: "Instance not found",
				});
			}

			// Create instance fetcher
			const fetcher = createInstanceFetcher(app, instance);

			// Fetch the quality profile
			const profileResponse = await fetcher(`/api/v3/qualityprofile/${profileId}`);
			const profile = await profileResponse.json();

			// Fetch all custom formats from the instance
			const cfResponse = await fetcher("/api/v3/customformat");
			const allCustomFormats = await cfResponse.json();

			// Get the CFs used in this profile (from formatItems)
			// Include all CFs in the profile, even those with score 0
			// (score 0 is meaningful - it means "track but don't affect ranking")
			const profileCFIds = new Set(
				(profile.formatItems || [])
					.map((item: { format: number; score: number }) => item.format)
			);

			// Filter to only CFs used in the profile
			const profileCFs: InstanceCustomFormat[] = allCustomFormats
				.filter((cf: { id: number }) => profileCFIds.has(cf.id))
				.map((cf: { id: number; name: string; specifications?: unknown[]; includeCustomFormatWhenRenaming?: boolean }) => {
					// Find the score for this CF in the profile
					const formatItem = profile.formatItems?.find(
						(item: { format: number; score: number }) => item.format === cf.id
					);
					return {
						id: cf.id,
						name: cf.name,
						specifications: cf.specifications || [],
						includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
						score: formatItem?.score,
					} as InstanceCustomFormat;
				});

			// Debug: Log instance CF names
			app.log.info(`[validate-cfs] Instance CFs (${profileCFs.length}): ${profileCFs.map(cf => `"${cf.name}"`).join(', ')}`);

			// Create matcher and match CFs
			const cfMatcher = createCFMatcher(app.prisma);
			const matchResults = await cfMatcher.matchMultipleCFs(profileCFs, serviceType);

			// Transform results to match frontend expected format with full specs for comparison
			const results = matchResults.results.map((result) => ({
				instanceCF: {
					id: result.instanceCF.id,
					name: result.instanceCF.name,
					trash_id: result.instanceCF.trash_id,
					score: result.instanceCF.score,
					// Include full specifications for comparison view
					specifications: result.instanceCF.specifications,
					includeCustomFormatWhenRenaming: result.instanceCF.includeCustomFormatWhenRenaming,
				},
				trashCF: result.trashCF
					? {
							trash_id: result.trashCF.trash_id,
							name: result.trashCF.name,
							score: result.trashCF.score,
							// Include full specifications for comparison view
							specifications: result.trashCF.specifications,
							// Include all trash_scores for score comparison
							trash_scores: (result.trashCF as any).trash_scores,
						}
					: null,
				confidence: result.confidence,
				matchDetails: result.matchDetails,
				recommendedScore: result.recommendedScore,
				scoreSet: result.scoreSet,
			}));

			// Return flat response (not wrapped in data) to match frontend type
			return reply.status(200).send({
				success: true,
				profileName: profile.name,
				summary: {
					total: matchResults.total,
					exactMatches: matchResults.exactMatches,
					nameMatches: matchResults.nameMatches,
					specsSimilar: matchResults.specsSimilar,
					noMatch: matchResults.noMatch,
				},
				results,
			});
		} catch (error) {
			app.log.error(`Failed to validate Custom Formats: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to validate Custom Formats",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/match-profile
	 * Match instance profile name to TRaSH Guides quality profiles and return CF recommendations
	 * This helps users identify which CFs are expected to be in a profile based on TRaSH Guides
	 */
	app.post("/match-profile", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const { profileName, serviceType } = request.body as {
			profileName: string;
			serviceType: "RADARR" | "SONARR";
		};

		if (!profileName || !serviceType) {
			return reply.status(400).send({
				success: false,
				error: "Missing required fields: profileName, serviceType",
			});
		}

		try {
			const cacheManager = createCacheManager(app.prisma);

			// Get quality profiles from cache
			const qualityProfiles = (await cacheManager.get(
				serviceType,
				"QUALITY_PROFILES",
			)) as TrashQualityProfile[] | null;

			if (!qualityProfiles || qualityProfiles.length === 0) {
				return reply.status(200).send({
					success: true,
					matched: false,
					reason: "Quality profiles cache is empty. Please refresh TRaSH Guides cache first.",
				});
			}

			// Get CF groups from cache
			const cfGroups = (await cacheManager.get(
				serviceType,
				"CF_GROUPS",
			)) as TrashCustomFormatGroup[] | null;

			// Get all custom formats from cache
			const customFormats = (await cacheManager.get(
				serviceType,
				"CUSTOM_FORMATS",
			)) as TrashCustomFormat[] | null;

			// Normalize profile name for matching
			const normalizedInput = normalizeProfileName(profileName);
			app.log.info(`[match-profile] Searching for profile "${profileName}" (normalized: "${normalizedInput}")`);

			// Try to find a matching TRaSH quality profile
			let matchedProfile: TrashQualityProfile | null = null;
			let matchType: "exact" | "fuzzy" | "partial" = "exact";

			// 1. First try exact match (case-insensitive)
			matchedProfile = qualityProfiles.find(
				(p) => normalizeProfileName(p.name) === normalizedInput
			) || null;

			// 2. Try fuzzy matching (remove common prefixes/suffixes)
			if (!matchedProfile) {
				matchType = "fuzzy";
				matchedProfile = qualityProfiles.find((p) => {
					const normalizedTrash = normalizeProfileName(p.name);
					// Check if either contains the other (handles prefixes like "TRaSH - " or suffixes like " v4")
					return normalizedTrash.includes(normalizedInput) || normalizedInput.includes(normalizedTrash);
				}) || null;
			}

			// 3. Try partial word matching (at least 2 significant words match)
			if (!matchedProfile) {
				matchType = "partial";
				const inputWords = extractSignificantWords(normalizedInput);
				if (inputWords.length >= 2) {
					let bestMatch: { profile: TrashQualityProfile; score: number } | null = null;
					for (const profile of qualityProfiles) {
						const profileWords = extractSignificantWords(normalizeProfileName(profile.name));
						const matchingWords = inputWords.filter((w) => profileWords.includes(w));
						const score = matchingWords.length / Math.max(inputWords.length, profileWords.length);
						if (score >= 0.5 && (!bestMatch || score > bestMatch.score)) {
							bestMatch = { profile, score };
						}
					}
					matchedProfile = bestMatch?.profile || null;
				}
			}

			if (!matchedProfile) {
				app.log.info(`[match-profile] No match found for "${profileName}"`);
				return reply.status(200).send({
					success: true,
					matched: false,
					reason: `No TRaSH Guides quality profile matches "${profileName}"`,
					availableProfiles: qualityProfiles.map((p) => p.name),
				});
			}

			app.log.info(`[match-profile] Matched "${profileName}" to "${matchedProfile.name}" (trash_id: ${matchedProfile.trash_id}) (${matchType})`);
			app.log.info(`[match-profile] customFormats count: ${customFormats?.length ?? 0}`);
			app.log.info(`[match-profile] cfGroups count: ${cfGroups?.length ?? 0}`);

			// Build list of recommended CFs based on the matched profile
			const recommendedCFs: Array<{
				trash_id: string;
				name: string;
				score: number;
				source: "profile" | "group";
				groupName?: string;
				required: boolean;
			}> = [];

			// Build CF lookup for scores
			const cfLookup = new Map<string, TrashCustomFormat>();
			if (customFormats) {
				for (const cf of customFormats) {
					cfLookup.set(cf.trash_id, cf);
				}
			}

			// Helper to get score for a CF based on the profile's score set
			// Note: trash_scores is a dynamic property from the cache data, not in the base type
			const getScoreForCF = (cf: TrashCustomFormat): number => {
				const cfWithScores = cf as TrashCustomFormat & { trash_scores?: Record<string, number> };
				if (!cfWithScores.trash_scores) return cf.score ?? 0;
				const scoreSet = matchedProfile!.trash_score_set;
				if (scoreSet && cfWithScores.trash_scores[scoreSet] !== undefined) {
					return cfWithScores.trash_scores[scoreSet];
				}
				if (cfWithScores.trash_scores.default !== undefined) {
					return cfWithScores.trash_scores.default;
				}
				return cf.score ?? 0;
			};

			// 1. Add mandatory CFs from the profile's formatItems
			if (matchedProfile.formatItems) {
				for (const [cfName, cfTrashId] of Object.entries(matchedProfile.formatItems)) {
					const cf = cfLookup.get(cfTrashId);
					if (cf) {
						recommendedCFs.push({
							trash_id: cfTrashId,
							name: cf.name || cfName,
							score: getScoreForCF(cf),
							source: "profile",
							required: true,
						});
					}
				}
			}

			// 2. Add CFs from applicable CF groups
			app.log.info(`[match-profile] CF Groups count: ${cfGroups?.length ?? 0}`);
			if (cfGroups) {
				for (const group of cfGroups) {
					// Check if this group is excluded for the matched profile
					const isExcluded =
						group.quality_profiles?.exclude &&
						Object.values(group.quality_profiles.exclude).includes(matchedProfile.trash_id);

					if (isExcluded) continue;

					// Process each CF in the group
					if (group.custom_formats) {
						for (const groupCF of group.custom_formats) {
							const cfTrashId = typeof groupCF === "string" ? groupCF : groupCF.trash_id;
							const cfRequired = typeof groupCF === "object" ? groupCF.required === true : false;
							const cfDefault = typeof groupCF === "object" ? (groupCF.default === true || groupCF.default === "true") : false;

							// Skip if already added from profile
							if (recommendedCFs.some((r) => r.trash_id === cfTrashId)) continue;

							const cf = cfLookup.get(cfTrashId);
							if (cf) {
								// Use group score if specified, otherwise use CF's score for the profile's score set
								const score = group.quality_profiles?.score ?? getScoreForCF(cf);
								recommendedCFs.push({
									trash_id: cfTrashId,
									name: cf.name,
									score,
									source: "group",
									groupName: group.name,
									// Required if CF is required in group, or group itself is required
									required: cfRequired || group.required === true,
								});
							}
						}
					}
				}
			}

			// Build set of recommended trash_ids for quick lookup
			const recommendedTrashIds = new Set(recommendedCFs.map((cf) => cf.trash_id));

			return reply.status(200).send({
				success: true,
				matched: true,
				matchType,
				matchedProfile: {
					trash_id: matchedProfile.trash_id,
					name: matchedProfile.name,
					description: matchedProfile.trash_description,
					scoreSet: matchedProfile.trash_score_set,
				},
				recommendations: {
					total: recommendedCFs.length,
					mandatory: recommendedCFs.filter((cf) => cf.source === "profile").length,
					fromGroups: recommendedCFs.filter((cf) => cf.source === "group").length,
					customFormats: recommendedCFs,
					recommendedTrashIds: Array.from(recommendedTrashIds),
				},
			});
		} catch (error) {
			app.log.error(`Failed to match profile: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to match profile",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/create-template
	 * Create a template from a cloned instance profile with resolved CF mappings
	 */
	app.post("/create-template", async (request, reply) => {
		if (!request.currentUser) {
			return reply.status(401).send({
				statusCode: 401,
				error: "Unauthorized",
				message: "Authentication required",
			});
		}

		const userId = request.currentUser.id;
		const {
			serviceType,
			trashId,
			templateName,
			templateDescription,
			customFormatSelections,
			sourceInstanceId,
			sourceProfileId,
			sourceProfileName,
			sourceInstanceLabel,
			profileConfig,
		} = request.body as {
			serviceType: "RADARR" | "SONARR";
			trashId: string;
			templateName: string;
			templateDescription?: string;
			customFormatSelections: Record<string, {
				selected: boolean;
				scoreOverride?: number;
				conditionsEnabled: Record<string, boolean>;
			}>;
			sourceInstanceId: string;
			sourceProfileId: number;
			sourceProfileName: string;
			sourceInstanceLabel: string;
			profileConfig: {
				upgradeAllowed: boolean;
				cutoff: number;
				minFormatScore: number;
				cutoffFormatScore?: number;
				items?: unknown[];
				language?: unknown;
			};
		};

		if (!serviceType || !templateName || !sourceInstanceId || !sourceProfileId) {
			return reply.status(400).send({
				success: false,
				error: "Missing required fields: serviceType, templateName, sourceInstanceId, sourceProfileId",
			});
		}

		try {
			// Get instance to fetch the actual CFs
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: sourceInstanceId },
			});

			if (!instance) {
				return reply.status(404).send({
					success: false,
					error: "Source instance not found",
				});
			}

			// Create instance fetcher and get the profile and CFs
			const fetcher = createInstanceFetcher(app, instance);

			// Fetch the full quality profile to get quality items
			const profileResponse = await fetcher(`/api/v3/qualityprofile/${sourceProfileId}`);
			const fullProfile = await profileResponse.json();

			const cfResponse = await fetcher("/api/v3/customformat");
			const allCustomFormats = await cfResponse.json();

			// Build a lookup map for instance CFs
			const cfLookup = new Map<number, { id: number; name: string; specifications?: unknown[] }>();
			for (const cf of allCustomFormats) {
				cfLookup.set(cf.id, cf);
			}

			// Get TRaSH cache for matching
			const cacheManager = createCacheManager(app.prisma);
			const trashCFs = (await cacheManager.get(serviceType, "CUSTOM_FORMATS")) as TrashCustomFormat[] | null;
			const trashCFLookup = new Map<string, TrashCustomFormat>();
			if (trashCFs) {
				for (const cf of trashCFs) {
					trashCFLookup.set(cf.trash_id, cf);
				}
			}

			// Build the template config from selections
			const customFormatsConfig: TemplateConfig["customFormats"] = [];

			for (const [cfKey, selection] of Object.entries(customFormatSelections)) {
				if (!selection.selected) continue;

				// Check if this is a TRaSH CF (has a valid trash_id) or an instance CF
				const trashCF = trashCFLookup.get(cfKey);

				if (trashCF) {
					// This is a TRaSH-linked CF
					customFormatsConfig.push({
						trashId: cfKey,
						name: trashCF.name,
						scoreOverride: selection.scoreOverride,
						conditionsEnabled: selection.conditionsEnabled || {},
						originalConfig: trashCF,
					});
				} else if (cfKey.startsWith("instance-")) {
					// This is an instance-only CF (not linked to TRaSH)
					// Extract the instance CF id from the key format "instance-{id}"
					const instanceCFId = parseInt(cfKey.replace("instance-", ""), 10);
					const instanceCF = cfLookup.get(instanceCFId);

					if (instanceCF) {
						customFormatsConfig.push({
							trashId: cfKey, // Keep the instance-prefixed ID
							name: instanceCF.name,
							scoreOverride: selection.scoreOverride,
							conditionsEnabled: selection.conditionsEnabled || {},
							originalConfig: {
								name: instanceCF.name,
								specifications: instanceCF.specifications,
								// Mark as instance-sourced for future reference
								_source: "instance",
								_instanceId: sourceInstanceId,
								_instanceCFId: instanceCFId,
							},
						});
					}
				}
			}

			// Helper function to find cutoff quality name from profile items
			// The cutoff ID can match:
			// 1. A single quality item (item.quality.id)
			// 2. A quality group (item.id with item.name, has item.items)
			// 3. A quality inside a group (subItem.quality.id or subItem.id)
			const findCutoffQualityName = (items: any[], cutoffId: number): string => {
				for (const item of items) {
					// Check if this is a single quality item matching the cutoff
					if (item.quality?.id === cutoffId) {
						return item.quality.name;
					}
					// Check if this is a quality GROUP matching the cutoff (group has id + name + items)
					if (item.id === cutoffId && item.name && item.items) {
						return item.name;
					}
					// Check if this is a group containing the cutoff quality
					if (item.items && Array.isArray(item.items)) {
						for (const subItem of item.items) {
							// Sub-items can have quality wrapper or direct id/name
							if (subItem.quality?.id === cutoffId) {
								return subItem.quality.name;
							}
							if (subItem.id === cutoffId && subItem.name) {
								return subItem.name;
							}
						}
					}
				}
				return "Unknown";
			};

			// Build the CompleteQualityProfile from the fetched profile
			const cutoffId = fullProfile.cutoff ?? profileConfig?.cutoff ?? 0;
			const cutoffQualityName = cutoffId ? findCutoffQualityName(fullProfile.items || [], cutoffId) : undefined;

			const completeQualityProfile: CompleteQualityProfile = {
				// Source information
				sourceInstanceId,
				sourceInstanceLabel,
				sourceProfileId,
				sourceProfileName,
				importedAt: new Date().toISOString(),

				// Quality settings from the instance profile
				upgradeAllowed: fullProfile.upgradeAllowed ?? profileConfig?.upgradeAllowed ?? true,
				cutoff: cutoffId,
				cutoffQuality: cutoffId ? {
					id: cutoffId,
					name: cutoffQualityName || "Unknown",
				} : undefined,

				// Quality items with full structure
				items: (fullProfile.items || []).map((item: any) => ({
					quality: item.quality ? {
						id: item.quality.id,
						name: item.quality.name,
						source: item.quality.source,
						resolution: item.quality.resolution,
					} : undefined,
					items: item.items?.map((subItem: any) => ({
						id: subItem.id ?? subItem.quality?.id,
						name: subItem.name ?? subItem.quality?.name,
						source: subItem.source ?? subItem.quality?.source,
						resolution: subItem.resolution ?? subItem.quality?.resolution,
						allowed: subItem.allowed,
					})),
					allowed: item.allowed,
					id: item.id,
					name: item.name,
				})),

				// Format scores
				minFormatScore: fullProfile.minFormatScore ?? profileConfig?.minFormatScore ?? 0,
				cutoffFormatScore: fullProfile.cutoffFormatScore ?? profileConfig?.cutoffFormatScore ?? 0,
				minUpgradeFormatScore: fullProfile.minUpgradeFormatScore,

				// Language settings
				language: fullProfile.language ? {
					id: fullProfile.language.id,
					name: fullProfile.language.name,
				} : undefined,
			};

			// Debug: Log the built completeQualityProfile items
			app.log.info(`[create-template] Built completeQualityProfile items count: ${completeQualityProfile.items?.length || 0}`);
			const allowedItems = completeQualityProfile.items?.filter((item: any) => item.allowed);
			app.log.info(`[create-template] Allowed quality items: ${allowedItems?.map((item: any) => item.quality?.name || item.name || 'group').join(', ')}`);

			// Build qualityProfile metadata for template card badges
			// This provides display info (language, cutoff) for the template list
			const qualityProfileMetadata = {
				language: completeQualityProfile.language?.name,
				cutoff: completeQualityProfile.cutoffQuality?.name,
				// Cloned profiles don't have a TRaSH score set
				trash_score_set: undefined,
			};

			// Build the template config
			const templateConfig: TemplateConfig = {
				customFormats: customFormatsConfig,
				customFormatGroups: [], // Cloned profiles don't use CF groups
				qualitySize: [],
				naming: [],
				qualityProfile: qualityProfileMetadata, // Add metadata for template card badges
				completeQualityProfile, // Include the full quality profile settings
			};

			// Create the template using the template service
			const templateService = createTemplateService(app.prisma);
			const template = await templateService.createTemplate(userId, {
				name: templateName,
				description: templateDescription || `Cloned from ${sourceInstanceLabel}: ${sourceProfileName}`,
				serviceType,
				config: templateConfig,
				// Store source information for reference
				sourceQualityProfileTrashId: trashId,
				sourceQualityProfileName: sourceProfileName,
			});

			app.log.info(`Created template "${templateName}" from cloned profile ${sourceProfileName} (${customFormatsConfig.length} CFs)`);

			return reply.status(201).send({
				success: true,
				data: {
					template,
					stats: {
						customFormatsCount: customFormatsConfig.length,
						trashLinkedCount: customFormatsConfig.filter(cf => !cf.trashId.startsWith("instance-")).length,
						instanceOnlyCount: customFormatsConfig.filter(cf => cf.trashId.startsWith("instance-")).length,
					},
				},
			});
		} catch (error) {
			app.log.error(`Failed to create template from cloned profile: ${error}`);

			// Handle duplicate name error
			if (error instanceof Error && error.message.includes("already exists")) {
				return reply.status(409).send({
					success: false,
					error: error.message,
				});
			}

			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to create template",
			});
		}
	});

	done();
};

/**
 * Normalize profile name for matching
 * Removes common prefixes, suffixes, and normalizes whitespace
 */
function normalizeProfileName(name: string): string {
	return name
		.toLowerCase()
		.replace(/^trash\s*[-:]\s*/i, "") // Remove "TRaSH - " or "TRaSH:" prefix
		.replace(/\s*v\d+(\.\d+)?\s*$/i, "") // Remove version suffix like " v4" or " v4.0"
		.replace(/\s*\(.*\)\s*$/i, "") // Remove parenthetical suffixes
		.replace(/[-_]/g, " ") // Normalize separators to spaces
		.replace(/\s+/g, " ") // Normalize multiple spaces
		.trim();
}

/**
 * Extract significant words from a profile name (for fuzzy matching)
 * Filters out common words and short words
 */
function extractSignificantWords(normalized: string): string[] {
	const stopWords = new Set(["the", "and", "or", "for", "with", "hd", "uhd", "web", "dl"]);
	return normalized
		.split(/\s+/)
		.filter((w) => w.length >= 2 && !stopWords.has(w));
}

export default profileCloneRoutes;
