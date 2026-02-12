/**
 * Quality Profile Clone API Routes
 *
 * Routes for importing complete quality profiles from *arr instances
 */

import type { FastifyPluginCallback } from "fastify";
import { createProfileCloner } from "../../lib/trash-guides/profile-cloner.js";
import { SonarrClient, RadarrClient } from "arr-sdk";
import { createCFMatcher, type InstanceCustomFormat } from "../../lib/trash-guides/cf-matcher.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTemplateService } from "../../lib/trash-guides/template-service.js";
import { findCutoffQualityName } from "../../lib/utils/quality-utils.js";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import {
	matchProfileToTrash,
	buildCFRecommendations,
	buildCustomFormatsConfig,
	buildCompleteQualityProfile,
	type ArrQualityProfileResponse,
} from "../../lib/trash-guides/profile-matcher.js";
import type { TrashCFWithScores } from "../../lib/trash-guides/template-score-utils.js";
import type {
	CompleteQualityProfile,
	TrashQualityProfile,
	TrashCustomFormatGroup,
	TrashCustomFormat,
	TemplateConfig,
} from "@arr/shared";
// ============================================================================
// Routes
// ============================================================================

const profileCloneRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /api/trash-guides/profile-clone/import
	 * Import complete quality profile from *arr instance
	 */
	app.post("/import", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profileId } = request.body as {
			instanceId: string;
			profileId: number;
		};

		const profileCloner = createProfileCloner(app.prisma, app.arrClientFactory);
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
	});

	/**
	 * POST /api/trash-guides/profile-clone/preview
	 * Preview deployment of complete quality profile
	 */
	app.post("/preview", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profile, customFormats } = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
		};

		const profileCloner = createProfileCloner(app.prisma, app.arrClientFactory);
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
	});

	/**
	 * POST /api/trash-guides/profile-clone/deploy
	 * Deploy complete quality profile to *arr instance
	 */
	app.post("/deploy", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId, profile, customFormats, profileName, existingProfileId } = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
			profileName: string;
			existingProfileId?: number;
		};

		const profileCloner = createProfileCloner(app.prisma, app.arrClientFactory);
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
	});

	/**
	 * GET /api/trash-guides/profile-clone/profiles/:instanceId
	 * Get list of quality profiles from an instance
	 */
	app.get("/profiles/:instanceId", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
		const { instanceId } = request.params as { instanceId: string };

		// Get instance - verify ownership by including userId in where clause.
		const instance = await requireInstance(app, userId, instanceId);

		// Create SDK client and fetch quality profiles
		const client = app.arrClientFactory.create(instance);

		// Both SonarrClient and RadarrClient have the qualityProfile API
		if (!(client instanceof SonarrClient) && !(client instanceof RadarrClient)) {
			return reply.status(400).send({
				success: false,
				error: "Invalid client type for quality profiles",
			});
		}

		const profiles = (await client.qualityProfile.getAll()) as ArrQualityProfileResponse[];

		return reply.status(200).send({
			success: true,
			data: {
				profiles: profiles.map((p) => {
					// Resolve cutoff ID to quality name from profile items
					const cutoffName = p.cutoff ? findCutoffQualityName(p.items || [], p.cutoff) : null;
					return {
						id: p.id,
						name: p.name,
						upgradeAllowed: p.upgradeAllowed,
						cutoff: p.cutoff,
						cutoffQuality:
							cutoffName && cutoffName !== "Unknown"
								? { id: p.cutoff, name: cutoffName }
								: undefined,
						minFormatScore: p.minFormatScore,
						formatItemsCount: p.formatItems?.length || 0,
					};
				}),
			},
		});
	});

	/**
	 * GET /api/trash-guides/profile-clone/profile-details/:instanceId/:profileId
	 * Get detailed quality profile with custom formats from an instance
	 */
	app.get("/profile-details/:instanceId/:profileId", async (request, reply) => {
		const { instanceId, profileId } = request.params as {
			instanceId: string;
			profileId: string;
		};

		const instance = await requireInstance(app, request.currentUser!.id, instanceId);

		// Create SDK client
		const client = app.arrClientFactory.create(instance);

		// Validate client type
		if (!(client instanceof SonarrClient) && !(client instanceof RadarrClient)) {
			return reply.status(400).send({
				success: false,
				error: "Invalid client type for profile details",
			});
		}

		// Fetch the quality profile and all custom formats in parallel
		const [profile, allCustomFormats] = await Promise.all([
			client.qualityProfile.getById(Number(profileId)),
			client.customFormat.getAll(),
		]);

		// Get the CFs used in this profile (from formatItems)
		const profileCFIds = new Set(
			((profile as ArrQualityProfileResponse).formatItems || []).map(
				(item: { format: number }) => item.format,
			),
		);

		// Filter to only CFs used in the profile and include score
		// Use type guard to filter out CFs with undefined id or name
		const validCustomFormats = allCustomFormats.filter(
			(cf): cf is typeof cf & { id: number; name: string } =>
				cf.id !== undefined && cf.name !== undefined && cf.name !== null,
		);

		const profileCustomFormats = validCustomFormats
			.filter((cf) => profileCFIds.has(cf.id))
			.map((cf) => {
				const formatItem = (profile as ArrQualityProfileResponse).formatItems?.find(
					(item) => item.format === cf.id,
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
				allCustomFormats: validCustomFormats.map((cf) => ({
					id: cf.id,
					name: cf.name,
					trash_id: `instance-cf-${cf.id}`, // Placeholder trash_id for instance CFs
					specifications: cf.specifications,
					includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
				})),
			},
		});
	});

	/**
	 * POST /api/trash-guides/profile-clone/validate-cfs
	 * Validate Custom Formats from instance profile against TRaSH Guides cache
	 * Used when cloning a profile to identify which CFs match TRaSH Guides
	 */
	app.post("/validate-cfs", async (request, reply) => {
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

		const instance = await requireInstance(app, request.currentUser!.id, instanceId);

		// Create SDK client
		const client = app.arrClientFactory.create(instance);

		// Validate client type
		if (!(client instanceof SonarrClient) && !(client instanceof RadarrClient)) {
			return reply.status(400).send({
				success: false,
				error: "Invalid client type for CF validation",
			});
		}

		// Fetch the quality profile and all custom formats in parallel
		const [profile, allCustomFormats] = await Promise.all([
			client.qualityProfile.getById(profileId),
			client.customFormat.getAll(),
		]);

		// Get the CFs used in this profile (from formatItems)
		// Include all CFs in the profile, even those with score 0
		// (score 0 is meaningful - it means "track but don't affect ranking")
		const profileCFIds = new Set(
			((profile as ArrQualityProfileResponse).formatItems || []).map(
				(item: { format: number; score: number }) => item.format,
			),
		);

		// Filter out CFs with undefined id or name
		const validCustomFormats = allCustomFormats.filter(
			(cf): cf is typeof cf & { id: number; name: string } =>
				cf.id !== undefined && cf.name !== undefined && cf.name !== null,
		);

		// Filter to only CFs used in the profile
		const profileCFs: InstanceCustomFormat[] = validCustomFormats
			.filter((cf) => profileCFIds.has(cf.id))
			.map((cf) => {
				// Find the score for this CF in the profile
				const formatItem = (profile as ArrQualityProfileResponse).formatItems?.find(
					(item) => item.format === cf.id,
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
		app.log.info(
			`[validate-cfs] Instance CFs (${profileCFs.length}): ${profileCFs.map((cf) => `"${cf.name}"`).join(", ")}`,
		);

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
						trash_scores: (result.trashCF as TrashCFWithScores).trash_scores,
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
	});

	/**
	 * POST /api/trash-guides/profile-clone/match-profile
	 * Match instance profile name to TRaSH Guides quality profiles and return CF recommendations
	 * This helps users identify which CFs are expected to be in a profile based on TRaSH Guides
	 */
	app.post("/match-profile", async (request, reply) => {
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

		const cacheManager = createCacheManager(app.prisma);

		// Get quality profiles from cache
		const qualityProfiles = (await cacheManager.get(serviceType, "QUALITY_PROFILES")) as
			| TrashQualityProfile[]
			| null;

		if (!qualityProfiles || qualityProfiles.length === 0) {
			return reply.status(200).send({
				success: true,
				matched: false,
				reason: "Quality profiles cache is empty. Please refresh TRaSH Guides cache first.",
			});
		}

		// Get CF groups and custom formats from cache
		const cfGroups = (await cacheManager.get(serviceType, "CF_GROUPS")) as
			| TrashCustomFormatGroup[]
			| null;
		const customFormats = (await cacheManager.get(serviceType, "CUSTOM_FORMATS")) as
			| TrashCustomFormat[]
			| null;

		// Match profile name to TRaSH quality profiles
		const matchResult = matchProfileToTrash(profileName, qualityProfiles);

		if (!matchResult.matched) {
			app.log.info(`[match-profile] No match found for "${profileName}"`);
			return reply.status(200).send({
				success: true,
				...matchResult,
			});
		}

		const { matchedProfile, matchType } = matchResult;
		app.log.info(
			`[match-profile] Matched "${profileName}" to "${matchedProfile.name}" (trash_id: ${matchedProfile.trash_id}) (${matchType})`,
		);
		app.log.info(`[match-profile] customFormats count: ${customFormats?.length ?? 0}`);
		app.log.info(`[match-profile] cfGroups count: ${cfGroups?.length ?? 0}`);

		// Build CF recommendations from the matched profile
		const { recommendedCFs, recommendedTrashIds } = buildCFRecommendations(
			matchedProfile,
			customFormats,
			cfGroups,
		);

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
	});

	/**
	 * POST /api/trash-guides/profile-clone/create-template
	 * Create a template from a cloned instance profile with resolved CF mappings
	 */
	app.post("/create-template", async (request, reply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth
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
			customFormatSelections: Record<
				string,
				{
					selected: boolean;
					scoreOverride?: number;
					conditionsEnabled: Record<string, boolean>;
				}
			>;
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
				error:
					"Missing required fields: serviceType, templateName, sourceInstanceId, sourceProfileId",
			});
		}

		const instance = await requireInstance(app, userId, sourceInstanceId);

		// Create SDK client
		const client = app.arrClientFactory.create(instance);

		// Validate client type
		if (!(client instanceof SonarrClient) && !(client instanceof RadarrClient)) {
			return reply.status(400).send({
				success: false,
				error: "Invalid client type for template creation",
			});
		}

		// Fetch the full quality profile and all custom formats in parallel
		const [fullProfile, allCustomFormats] = await Promise.all([
			client.qualityProfile.getById(sourceProfileId) as Promise<ArrQualityProfileResponse>,
			client.customFormat.getAll(),
		]);

		// Build a lookup map for instance CFs (filter out CFs with undefined id or name)
		const cfLookup = new Map<number, { id: number; name: string; specifications?: unknown[] }>();
		for (const cf of allCustomFormats) {
			if (cf.id !== undefined && cf.name !== undefined && cf.name !== null) {
				cfLookup.set(cf.id, {
					id: cf.id,
					name: cf.name,
					specifications: cf.specifications ?? undefined,
				});
			}
		}

		// Get TRaSH cache for matching
		const cacheManager = createCacheManager(app.prisma);
		const trashCFs = (await cacheManager.get(serviceType, "CUSTOM_FORMATS")) as
			| TrashCustomFormat[]
			| null;

		// Get current commit hash to enable TRaSH Guides sync for cloned templates
		const currentCommitHash = await cacheManager.getCommitHash(serviceType, "CUSTOM_FORMATS");

		const trashCFLookup = new Map<string, TrashCustomFormat>();
		if (trashCFs) {
			for (const cf of trashCFs) {
				trashCFLookup.set(cf.trash_id, cf);
			}
		}

		// Build template config from selections using extracted helpers
		const customFormatsConfig = buildCustomFormatsConfig(
			customFormatSelections,
			cfLookup,
			trashCFLookup,
			sourceInstanceId,
		);

		const completeQualityProfile = buildCompleteQualityProfile(
			fullProfile,
			profileConfig,
			{ sourceInstanceId, sourceInstanceLabel, sourceProfileId, sourceProfileName },
		);

		// Debug: Log the built completeQualityProfile items
		app.log.info(
			`[create-template] Built completeQualityProfile items count: ${completeQualityProfile.items?.length || 0}`,
		);
		const allowedItems = completeQualityProfile.items?.filter((item) => item.allowed);
		app.log.info(
			`[create-template] Allowed quality items: ${allowedItems?.map((item) => item.quality?.name || item.name || "group").join(", ")}`,
		);

		// Build qualityProfile metadata for template card badges
		const qualityProfileMetadata = {
			language: completeQualityProfile.language?.name,
			cutoff: completeQualityProfile.cutoffQuality?.name,
			trash_score_set: undefined,
		};

		// Build the template config
		const templateConfig: TemplateConfig = {
			customFormats: customFormatsConfig,
			customFormatGroups: [], // Cloned profiles don't use CF groups
			qualitySize: [],
			naming: [],
			qualityProfile: qualityProfileMetadata,
			completeQualityProfile,
		};

		// Create the template using the template service
		const templateService = createTemplateService(app.prisma, app.dbProvider);
		const template = await templateService.createTemplate(userId, {
			name: templateName,
			description:
				templateDescription || `Cloned from ${sourceInstanceLabel}: ${sourceProfileName}`,
			serviceType,
			config: templateConfig,
			sourceQualityProfileTrashId: trashId,
			sourceQualityProfileName: sourceProfileName,
			trashGuidesCommitHash: currentCommitHash || undefined,
		});

		app.log.info(
			`Created template "${templateName}" from cloned profile ${sourceProfileName} (${customFormatsConfig.length} CFs)`,
		);

		return reply.status(201).send({
			success: true,
			data: {
				template,
				stats: {
					customFormatsCount: customFormatsConfig.length,
					trashLinkedCount: customFormatsConfig.filter(
						(cf) => !cf.trashId.startsWith("instance-"),
					).length,
					instanceOnlyCount: customFormatsConfig.filter((cf) =>
						cf.trashId.startsWith("instance-"),
					).length,
				},
			},
		});
	});

	done();
};

export default profileCloneRoutes;
