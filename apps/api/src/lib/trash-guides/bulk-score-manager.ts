/**
 * Bulk Score Management Service
 *
 * Provides bulk operations for managing custom format scores across multiple templates
 */

import type {
	BulkScoreCopy,
	BulkScoreExport,
	BulkScoreFilters,
	BulkScoreImport,
	BulkScoreManagementResponse,
	BulkScoreReset,
	BulkScoreUpdate,
	CustomFormatScoreEntry,
	TemplateConfig,
	TemplateScore,
} from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { Prisma, PrismaClient } from "../../lib/prisma.js";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { readPersistedManagedCustomFormatIdentities } from "./deployment-managed-format-state.js";
import {
	assertNoLegacyDeploymentConnectionMappings,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionPersistenceBindings,
	getEquivalentServiceInstanceIds,
} from "./deployment-target.js";

const log = loggers.trashGuides;

// SDK type aliases
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

// ============================================================================
// Bulk Score Manager Class
// ============================================================================

export class BulkScoreManager {
	private prisma: PrismaClient;
	private clientFactory: ArrClientFactory;

	constructor(prisma: PrismaClient, clientFactory: ArrClientFactory) {
		this.prisma = prisma;
		this.clientFactory = clientFactory;
	}

	/**
	 * Get all custom format scores from a specific Radarr/Sonarr instance
	 * Shows all quality profiles from the instance with their defined scores
	 */
	async getAllScores(
		userId: string,
		filters: BulkScoreFilters = {},
	): Promise<CustomFormatScoreEntry[]> {
		// Require instanceId for this operation
		if (!filters.instanceId) {
			throw new Error("instanceId filter is required for bulk score management");
		}

		// Fetch the specific instance with ownership verification
		// Including userId in the where clause ensures only user-owned instances can be accessed
		const instance = await this.prisma.serviceInstance.findFirst({
			where: {
				id: filters.instanceId,
				userId, // Authorization check: ensures instance belongs to the requesting user
				enabled: true,
			},
			select: {
				id: true,
				label: true,
				service: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				connectionGeneration: true,
			},
		});

		if (!instance) {
			throw new Error("Instance not found, not enabled, or access denied");
		}

		const instances = [instance]; // Wrap in array to reuse existing logic

		// Step 1: Collect all quality profiles from all instances
		interface QualityProfileRef {
			instanceId: string;
			instanceLabel: string;
			profileId: number;
			profileName: string;
		}
		const allQualityProfiles: QualityProfileRef[] = [];
		const instanceClients = new Map<string, SonarrClient | RadarrClient>(); // Store clients for reuse

		for (const instance of instances) {
			// Create SDK client
			const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;
			instanceClients.set(instance.id, client);

			// Fetch quality profiles from this instance
			// Use any[] due to Sonarr/Radarr type union - we only read data, not write
			// biome-ignore lint/suspicious/noExplicitAny: SonarrClient | RadarrClient getAll() returns incompatible QualitySource union
			let qualityProfiles: any[];
			try {
				qualityProfiles = await client.qualityProfile.getAll();
			} catch (error) {
				log.error(
					{ err: error, instanceId: instance.id, instanceLabel: instance.label },
					"Failed to fetch quality profiles from instance",
				);
				continue; // Skip this instance if it fails
			}

			// Add all profiles to our collection
			for (const profile of qualityProfiles) {
				if (profile.id !== undefined && profile.name) {
					allQualityProfiles.push({
						instanceId: instance.id,
						instanceLabel: instance.label,
						profileId: profile.id,
						profileName: profile.name,
					});
				}
			}
		}

		const aliases = await this.prisma.serviceInstance.findMany({
			where: { userId, service: instance.service },
			select: {
				id: true,
				service: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				connectionGeneration: true,
			},
		});
		const credentialIdentity = this.clientFactory.createConnectionCredentialIdentity(instance);
		const equivalentInstanceIds = new Set(
			getEquivalentServiceInstanceIds(
				aliases.map((alias) => ({
					...alias,
					credentialIdentity: this.clientFactory.createConnectionCredentialIdentity(alias),
				})),
				{ ...instance, credentialIdentity },
			),
		);
		equivalentInstanceIds.add(instance.id);
		const connectionBindings = aliases
			.filter((alias) => equivalentInstanceIds.has(alias.id))
			.flatMap((alias) =>
				createDeploymentConnectionBindingCandidates(
					alias,
					this.clientFactory.createConnectionCredentialIdentity(alias),
				),
			);
		if (!connectionBindings.some((binding) => binding.instanceId === instance.id)) {
			connectionBindings.push(
				...createDeploymentConnectionBindingCandidates(instance, credentialIdentity),
			);
		}

		// Resolve management through every current alias for the physical ARR endpoint.
		const templateMappings = await this.prisma.templateQualityProfileMapping.findMany({
			where: {
				OR: createDeploymentConnectionPersistenceBindings(connectionBindings),
				template: { userId },
			},
			select: {
				instanceId: true,
				qualityProfileId: true,
				templateId: true,
				connectionGeneration: true,
				connectionStateToken: true,
				managedCustomFormatsCaptured: true,
				managedCustomFormats: true,
			},
		});
		assertNoLegacyDeploymentConnectionMappings(templateMappings);
		const templateIdsByProfile = new Map<number, Set<string>>();
		for (const mapping of templateMappings) {
			const ids = templateIdsByProfile.get(mapping.qualityProfileId) ?? new Set<string>();
			ids.add(mapping.templateId);
			templateIdsByProfile.set(mapping.qualityProfileId, ids);
		}
		if ([...templateIdsByProfile.values()].some((templateIds) => templateIds.size > 1)) {
			throw new Error(
				"Equivalent ARR service records have conflicting template mappings for one quality profile",
			);
		}
		const managedSnapshotsByProfile = new Map<
			number,
			{ captured: boolean; snapshot: string | null }
		>();
		for (const mapping of templateMappings) {
			const existing = managedSnapshotsByProfile.get(mapping.qualityProfileId);
			if (
				existing &&
				(existing.captured !== mapping.managedCustomFormatsCaptured ||
					existing.snapshot !== mapping.managedCustomFormats)
			) {
				throw new Error(
					"Equivalent ARR service records have conflicting managed Custom Format snapshots",
				);
			}
			managedSnapshotsByProfile.set(mapping.qualityProfileId, {
				captured: mapping.managedCustomFormatsCaptured,
				snapshot: mapping.managedCustomFormats,
			});
		}
		const templateMappingMap = new Map(
			templateMappings.map((mapping) => [mapping.qualityProfileId, mapping.templateId]),
		);
		const managedTrashIdsByProfile = new Map<number, Map<number, string>>();
		for (const mapping of templateMappings) {
			if (!mapping.managedCustomFormatsCaptured) continue;
			const byResourceId =
				managedTrashIdsByProfile.get(mapping.qualityProfileId) ?? new Map<number, string>();
			for (const managed of readPersistedManagedCustomFormatIdentities(mapping)) {
				if (managed.profileId !== mapping.qualityProfileId) {
					throw new Error(
						"A managed Custom Format identity is bound to a different quality profile",
					);
				}
				const existingTrashId = byResourceId.get(managed.resourceId);
				if (existingTrashId && existingTrashId !== managed.trashId) {
					throw new Error(
						"Equivalent ARR service records have conflicting managed Custom Format identities",
					);
				}
				byResourceId.set(managed.resourceId, managed.trashId);
			}
			managedTrashIdsByProfile.set(mapping.qualityProfileId, byResourceId);
		}

		// Fetch templates to get TRaSH default scores
		const templateIds = [...new Set(templateMappings.map((m) => m.templateId))];
		const templates =
			templateIds.length > 0
				? await this.prisma.trashTemplate.findMany({
						where: {
							id: { in: templateIds },
							userId,
						},
						select: {
							id: true,
							configData: true,
						},
					})
				: [];

		// Build template-specific score metadata keyed by durable TRaSH identity.
		// ARR names are display data and are not unique.
		interface TrashScoreInfo {
			scoreSetScores: Record<string, number>; // scoreSet → score (e.g., "anime" → 100, "default" → 0)
			fallbackScore: number; // score from originalConfig.score if no trash_scores
		}
		const trashScoreInfoByTemplate = new Map<string, Map<string, TrashScoreInfo>>();

		// Build a map of templateId → scoreSet for looking up the correct default per profile
		const templateScoreSetMap = new Map<string, string>();

		for (const template of templates) {
			try {
				const config = JSON.parse(template.configData) as TemplateConfig;
				const scoreSet = config.qualityProfile?.trash_score_set || "default";
				templateScoreSetMap.set(template.id, scoreSet);
				const scoreInfoByTrashId = new Map<string, TrashScoreInfo>();

				for (const cf of config.customFormats || []) {
					// Get the original config which may have trash_scores
					// Cast through unknown as TrashCustomFormat interface doesn't include trash_scores
					const originalConfig = cf.originalConfig as unknown as {
						trash_scores?: Record<string, number>;
						score?: number;
						[key: string]: unknown;
					};

					if (!scoreInfoByTrashId.has(cf.trashId)) {
						const scoreSetScores: Record<string, number> = {};
						let fallbackScore = 0;

						if (originalConfig?.trash_scores) {
							// Store all available score sets
							for (const [key, value] of Object.entries(originalConfig.trash_scores)) {
								if (typeof value === "number") {
									scoreSetScores[key] = value;
								}
							}
						}

						if (originalConfig?.score !== undefined) {
							fallbackScore = Number(originalConfig.score);
						}

						scoreInfoByTrashId.set(cf.trashId, {
							scoreSetScores,
							fallbackScore,
						});
					}
				}
				trashScoreInfoByTemplate.set(template.id, scoreInfoByTrashId);
			} catch (error) {
				log.error({ err: error, templateId: template.id }, "Failed to parse template config");
			}
		}

		// Helper function to calculate the correct default score for a CF given a score set
		const getDefaultScoreForScoreSet = (
			profileId: number,
			resourceId: number,
			scoreSet: string,
		): number => {
			const templateId = templateMappingMap.get(profileId);
			const trashId = managedTrashIdsByProfile.get(profileId)?.get(resourceId);
			const scoreInfo =
				templateId && trashId ? trashScoreInfoByTemplate.get(templateId)?.get(trashId) : undefined;
			if (!scoreInfo) return 0;

			// Priority: scoreSet score > default score > fallbackScore > 0
			if (scoreInfo.scoreSetScores[scoreSet] !== undefined) {
				return scoreInfo.scoreSetScores[scoreSet];
			}
			if (scoreInfo.scoreSetScores.default !== undefined) {
				return scoreInfo.scoreSetScores.default;
			}
			return scoreInfo.fallbackScore;
		};

		// Step 2: Collect exact Custom Format resources from the selected instance.
		// Names are display data and are not unique in ARR.
		const cfMap = new Map<string, CustomFormatScoreEntry>();

		for (const instance of instances) {
			const client = instanceClients.get(instance.id);
			if (!client) continue;

			// Fetch custom formats to get all possible CFs
			let customFormats: SdkCustomFormat[];
			try {
				customFormats = await client.customFormat.getAll();
			} catch (error) {
				log.error(
					{ err: error, instanceId: instance.id, instanceLabel: instance.label },
					"Failed to fetch custom formats from instance",
				);
				continue;
			}

			// Fetch quality profiles to get actual scores
			// Use any[] due to Sonarr/Radarr type union - we only read data, not write
			// biome-ignore lint/suspicious/noExplicitAny: SonarrClient | RadarrClient getAll() returns incompatible QualitySource union
			let qualityProfiles: any[];
			try {
				qualityProfiles = await client.qualityProfile.getAll();
			} catch (error) {
				log.error(
					{ err: error, instanceId: instance.id, instanceLabel: instance.label },
					"Failed to fetch quality profiles from instance",
				);
				continue;
			}

			// Build CF ID to name map
			const cfNameMap = new Map<number, string>();
			for (const cf of customFormats) {
				if (cf.id !== undefined && cf.name) {
					cfNameMap.set(cf.id, cf.name);
				}
			}

			// Build profile ID to formatItems map for quick lookup
			const profileFormatMap = new Map<number, Map<number, number>>(); // profileId -> (cfId -> score)
			for (const profile of qualityProfiles) {
				if (profile.id === undefined) continue;
				const formatScoreMap = new Map<number, number>();
				for (const formatItem of profile.formatItems || []) {
					if (formatItem.format !== undefined && formatItem.score !== undefined) {
						formatScoreMap.set(formatItem.format, formatItem.score);
					}
				}
				profileFormatMap.set(profile.id, formatScoreMap);
			}

			// Process each custom format
			for (const cf of customFormats) {
				if (cf.id === undefined || !cf.name) continue;

				const cfName = cf.name;
				const cfKey = String(cf.id);

				// Get or create CF entry
				let cfEntry = cfMap.get(cfKey);
				if (!cfEntry) {
					cfEntry = {
						trashId: `cf-${cf.id}`,
						name: cfName,
						serviceType: instance.service as "RADARR" | "SONARR",
						templateScores: [],
						hasAnyModifications: false,
					};
					cfMap.set(cfKey, cfEntry);

					// For newly created CF entries, add score entries for ALL quality profiles from ALL instances
					for (const profileRef of allQualityProfiles) {
						const isTemplateManaged = templateMappingMap.has(profileRef.profileId);

						// Get the correct default score based on the template's score set for this profile
						const templateId = templateMappingMap.get(profileRef.profileId);
						const profileScoreSet = templateId
							? templateScoreSetMap.get(templateId) || "default"
							: "default";
						const trashDefaultScore = getDefaultScoreForScoreSet(
							profileRef.profileId,
							cf.id,
							profileScoreSet,
						);

						const templateScore: TemplateScore = {
							templateId: `${profileRef.instanceId}-${profileRef.profileId}`,
							templateName: profileRef.instanceLabel,
							qualityProfileName: profileRef.profileName,
							scoreSet: profileScoreSet,
							currentScore: 0, // Will be updated if this profile has this CF
							defaultScore: trashDefaultScore, // TRaSH Guides default score for THIS profile's score set
							isModified: false,
							isTemplateManaged,
						};

						cfEntry.templateScores.push(templateScore);
					}
				}

				// Update scores for profiles in the current instance that have this CF
				for (const profileRef of allQualityProfiles) {
					// Only process profiles from the current instance
					if (profileRef.instanceId !== instance.id) continue;

					const formatScoreMap = profileFormatMap.get(profileRef.profileId);
					const score = formatScoreMap?.get(cf.id) || 0;

					// Find and update the existing template score entry
					const existingEntry = cfEntry.templateScores.find(
						(ts) => ts.templateId === `${profileRef.instanceId}-${profileRef.profileId}`,
					);
					if (existingEntry) {
						existingEntry.currentScore = score;
						// defaultScore is already set to TRaSH default; only update isModified
						existingEntry.isModified = score !== existingEntry.defaultScore;
						// Only mark hasAnyModifications for template-managed profiles
						// Non-template-managed profiles shouldn't contribute to the "modified" flag
						// since they were never expected to match template defaults
						if (existingEntry.isModified && existingEntry.isTemplateManaged) {
							cfEntry.hasAnyModifications = true;
						}
					}
				}
			}
		}

		// Convert map to array
		let allScores = Array.from(cfMap.values());

		// Apply search filter
		if (filters.search) {
			const searchLower = filters.search.toLowerCase();
			allScores = allScores.filter((cf) => cf.name.toLowerCase().includes(searchLower));
		}

		// Apply modifiedOnly filter
		if (filters.modifiedOnly) {
			allScores = allScores.filter((cf) => cf.hasAnyModifications);
		}

		// Apply sorting
		this.sortScores(allScores, filters.sortBy, filters.sortOrder);

		return allScores;
	}

	/**
	 * Update scores for multiple custom formats across templates
	 */
	async updateScores(
		userId: string,
		update: BulkScoreUpdate,
	): Promise<BulkScoreManagementResponse> {
		// Validate newScore is a finite number
		if (
			!update.resetToDefault &&
			(typeof update.newScore !== "number" || !Number.isFinite(update.newScore))
		) {
			return {
				success: false,
				message: "Invalid score value: must be a finite number",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			};
		}

		const affectedTemplateIds = new Set<string>();
		const affectedCfTrashIds = new Set<string>();
		const errors: string[] = [];

		// Determine which templates to update
		const whereClause: Prisma.TrashTemplateWhereInput = {
			userId,
			deletedAt: null,
		};

		if (update.targetTemplateIds && update.targetTemplateIds.length > 0) {
			whereClause.id = { in: update.targetTemplateIds };
		}

		const templates = await this.prisma.trashTemplate.findMany({
			where: whereClause,
		});

		// Update each template
		for (const template of templates) {
			try {
				const config = JSON.parse(template.configData) as TemplateConfig;
				let modified = false;

				// Update custom formats
				// Note: We use scoreOverride for user-set scores, which takes priority
				// in deployment over originalConfig.trash_scores
				for (const cf of config.customFormats) {
					if (update.targetTrashIds.includes(cf.trashId)) {
						if (update.resetToDefault) {
							// Reset: remove scoreOverride so deployment uses trash_scores
							cf.scoreOverride = undefined;
						} else {
							// Set new score as user override
							cf.scoreOverride = update.newScore;
						}
						modified = true;
						affectedCfTrashIds.add(cf.trashId);
					}
				}

				if (modified) {
					// Update template with modification tracking
					const now = new Date();
					await this.prisma.trashTemplate.update({
						where: { id: template.id },
						data: {
							configData: JSON.stringify(config),
							hasUserModifications: !update.resetToDefault,
							lastModifiedAt: now,
							lastModifiedBy: userId,
						},
					});

					affectedTemplateIds.add(template.id);
				}
			} catch (error) {
				errors.push(
					`Failed to update template ${template.id}: ${getErrorMessage(error, "Unknown error")}`,
				);
			}
		}

		return {
			success: errors.length === 0,
			message: `Updated ${affectedCfTrashIds.size} custom formats across ${affectedTemplateIds.size} templates`,
			affectedTemplates: affectedTemplateIds.size,
			affectedCustomFormats: affectedCfTrashIds.size,
			details: {
				templatesUpdated: Array.from(affectedTemplateIds),
				customFormatsUpdated: Array.from(affectedCfTrashIds),
				errors: errors.length > 0 ? errors : undefined,
			},
		};
	}

	/**
	 * Copy scores from one template to others
	 */
	async copyScores(userId: string, copy: BulkScoreCopy): Promise<BulkScoreManagementResponse> {
		// Get source template
		const sourceTemplate = await this.prisma.trashTemplate.findFirst({
			where: {
				id: copy.sourceTemplateId,
				userId,
				deletedAt: null,
			},
		});

		if (!sourceTemplate) {
			return {
				success: false,
				message: "Source template not found",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			};
		}

		const sourceConfig = safeJsonParse<TemplateConfig>(sourceTemplate.configData);
		if (!sourceConfig) {
			return {
				success: false,
				message: "Source template has invalid configuration data",
				affectedTemplates: 0,
				affectedCustomFormats: 0,
			};
		}

		// Build score map from source
		// Priority: scoreOverride > trash_scores[scoreSet] > trash_scores.default > 0
		const scoreSet = sourceConfig.qualityProfile?.trash_score_set || "default";
		const scoreMap = new Map<string, number>();
		for (const cf of sourceConfig.customFormats) {
			if (!copy.cfTrashIds || copy.cfTrashIds.includes(cf.trashId)) {
				let score = 0;
				if (cf.scoreOverride !== undefined) {
					score = cf.scoreOverride;
				} else if (cf.originalConfig?.trash_scores) {
					score =
						cf.originalConfig.trash_scores[scoreSet] ?? cf.originalConfig.trash_scores.default ?? 0;
				}
				scoreMap.set(cf.trashId, score);
			}
		}

		// Update target templates
		const affectedTemplateIds = new Set<string>();
		const affectedCfTrashIds = new Set<string>();
		const errors: string[] = [];

		const targetTemplates = await this.prisma.trashTemplate.findMany({
			where: {
				id: { in: copy.targetTemplateIds },
				userId,
				deletedAt: null,
			},
		});

		for (const template of targetTemplates) {
			try {
				const config = JSON.parse(template.configData) as TemplateConfig;
				let modified = false;

				for (const cf of config.customFormats) {
					const newScore = scoreMap.get(cf.trashId);
					if (newScore !== undefined) {
						// Check if we should overwrite
						if (!copy.overwriteModified && template.hasUserModifications) {
							continue;
						}

						// Set as user override (deployment reads scoreOverride first)
						cf.scoreOverride = newScore;
						modified = true;
						affectedCfTrashIds.add(cf.trashId);
					}
				}

				if (modified) {
					const now = new Date();
					await this.prisma.trashTemplate.update({
						where: { id: template.id },
						data: {
							configData: JSON.stringify(config),
							hasUserModifications: true,
							lastModifiedAt: now,
							lastModifiedBy: userId,
						},
					});

					affectedTemplateIds.add(template.id);
				}
			} catch (error) {
				errors.push(
					`Failed to copy to template ${template.id}: ${getErrorMessage(error, "Unknown error")}`,
				);
			}
		}

		return {
			success: errors.length === 0,
			message: `Copied ${affectedCfTrashIds.size} custom format scores to ${affectedTemplateIds.size} templates`,
			affectedTemplates: affectedTemplateIds.size,
			affectedCustomFormats: affectedCfTrashIds.size,
			details: {
				templatesUpdated: Array.from(affectedTemplateIds),
				customFormatsUpdated: Array.from(affectedCfTrashIds),
				errors: errors.length > 0 ? errors : undefined,
			},
		};
	}

	/**
	 * Reset scores to TRaSH Guides defaults
	 */
	async resetScores(userId: string, reset: BulkScoreReset): Promise<BulkScoreManagementResponse> {
		const affectedTemplateIds = new Set<string>();
		const affectedCfTrashIds = new Set<string>();
		const errors: string[] = [];

		const templates = await this.prisma.trashTemplate.findMany({
			where: {
				id: { in: reset.templateIds },
				userId,
				deletedAt: null,
			},
		});

		for (const template of templates) {
			try {
				const config = JSON.parse(template.configData) as TemplateConfig;
				let modified = false;

				for (const cf of config.customFormats) {
					// Check if we should reset this CF
					if (reset.cfTrashIds && !reset.cfTrashIds.includes(cf.trashId)) {
						continue;
					}

					// Reset: remove scoreOverride so deployment uses trash_scores
					// (the authoritative TRaSH Guides scores stored in originalConfig.trash_scores)
					if (cf.scoreOverride !== undefined) {
						cf.scoreOverride = undefined;
						modified = true;
						affectedCfTrashIds.add(cf.trashId);
					}
				}

				if (modified) {
					const now = new Date();
					await this.prisma.trashTemplate.update({
						where: { id: template.id },
						data: {
							configData: JSON.stringify(config),
							hasUserModifications: !reset.resetModificationsFlag,
							lastModifiedAt: now,
							lastModifiedBy: userId,
						},
					});

					affectedTemplateIds.add(template.id);
				}
			} catch (error) {
				errors.push(
					`Failed to reset template ${template.id}: ${getErrorMessage(error, "Unknown error")}`,
				);
			}
		}

		return {
			success: errors.length === 0,
			message: `Reset ${affectedCfTrashIds.size} custom formats across ${affectedTemplateIds.size} templates`,
			affectedTemplates: affectedTemplateIds.size,
			affectedCustomFormats: affectedCfTrashIds.size,
			details: {
				templatesUpdated: Array.from(affectedTemplateIds),
				customFormatsUpdated: Array.from(affectedCfTrashIds),
				errors: errors.length > 0 ? errors : undefined,
			},
		};
	}

	/**
	 * Export scores to JSON format
	 */
	async exportScores(
		userId: string,
		templateIds: string[],
		serviceType?: "RADARR" | "SONARR",
	): Promise<BulkScoreExport> {
		const whereClause: Prisma.TrashTemplateWhereInput = {
			id: { in: templateIds },
			userId,
			deletedAt: null,
			...(serviceType && { serviceType }),
		};

		const templates = await this.prisma.trashTemplate.findMany({
			where: whereClause,
		});

		if (templates.length === 0) {
			throw new Error("No templates found to export");
		}

		// Ensure all templates are same service type
		const firstServiceType = templates[0]?.serviceType as "RADARR" | "SONARR";
		if (templates.some((t) => t.serviceType !== firstServiceType)) {
			throw new Error("All templates must be the same service type for export");
		}

		const exportTemplates = templates
			.map((template) => {
				const config = safeJsonParse<TemplateConfig>(template.configData);
				if (!config) {
					return null; // Skip templates with invalid config
				}
				const scores: Record<string, number> = {};
				const scoreSet = config.qualityProfile?.trash_score_set || "default";

				// Export effective scores using deployment priority order
				for (const cf of config.customFormats) {
					let score = 0;
					if (cf.scoreOverride !== undefined) {
						score = cf.scoreOverride;
					} else if (cf.originalConfig?.trash_scores) {
						score =
							cf.originalConfig.trash_scores[scoreSet] ??
							cf.originalConfig.trash_scores.default ??
							0;
					}
					scores[cf.trashId] = score;
				}

				return {
					templateId: template.id,
					templateName: template.name,
					scores,
				};
			})
			.filter((t): t is NonNullable<typeof t> => t !== null);

		return {
			version: "1.0",
			exportedAt: new Date().toISOString(),
			serviceType: firstServiceType,
			templates: exportTemplates,
		};
	}

	/**
	 * Import scores from JSON format
	 */
	async importScores(
		userId: string,
		importData: BulkScoreImport,
	): Promise<BulkScoreManagementResponse> {
		const affectedTemplateIds = new Set<string>();
		const affectedCfTrashIds = new Set<string>();
		const errors: string[] = [];

		for (const importTemplate of importData.data.templates) {
			try {
				// Find matching template
				let template = await this.prisma.trashTemplate.findFirst({
					where: {
						id: importTemplate.templateId,
						userId,
						deletedAt: null,
					},
				});

				// If not found by ID, try by name
				if (!template && importData.createMissing) {
					template = await this.prisma.trashTemplate.findFirst({
						where: {
							name: importTemplate.templateName,
							userId,
							serviceType: importData.data.serviceType,
							deletedAt: null,
						},
					});
				}

				if (!template) {
					if (importData.createMissing) {
						errors.push(
							`Cannot create template "${importTemplate.templateName}" - template creation from import not yet implemented`,
						);
					}
					continue;
				}

				const config = safeJsonParse<TemplateConfig>(template.configData);
				if (!config) {
					errors.push(`Template "${template.name}" has invalid configuration data`);
					continue;
				}
				let modified = false;

				// Update scores
				for (const cf of config.customFormats) {
					const importedScore = importTemplate.scores[cf.trashId];
					if (importedScore !== undefined) {
						if (!importData.overwriteExisting && template.hasUserModifications) {
							continue;
						}

						// Set as user override (deployment reads scoreOverride first)
						cf.scoreOverride = importedScore;
						modified = true;
						affectedCfTrashIds.add(cf.trashId);
					}
				}

				if (modified) {
					const now = new Date();
					await this.prisma.trashTemplate.update({
						where: { id: template.id },
						data: {
							configData: JSON.stringify(config),
							hasUserModifications: true,
							lastModifiedAt: now,
							lastModifiedBy: userId,
						},
					});

					affectedTemplateIds.add(template.id);
				}
			} catch (error) {
				errors.push(
					`Failed to import scores for "${importTemplate.templateName}": ${getErrorMessage(error, "Unknown error")}`,
				);
			}
		}

		return {
			success: errors.length === 0,
			message: `Imported scores for ${affectedCfTrashIds.size} custom formats across ${affectedTemplateIds.size} templates`,
			affectedTemplates: affectedTemplateIds.size,
			affectedCustomFormats: affectedCfTrashIds.size,
			details: {
				templatesUpdated: Array.from(affectedTemplateIds),
				customFormatsUpdated: Array.from(affectedCfTrashIds),
				errors: errors.length > 0 ? errors : undefined,
			},
		};
	}

	/**
	 * Helper: Sort score entries
	 */
	private sortScores(
		scores: CustomFormatScoreEntry[],
		sortBy: BulkScoreFilters["sortBy"] = "name",
		sortOrder: BulkScoreFilters["sortOrder"] = "asc",
	): void {
		scores.sort((a, b) => {
			let comparison = 0;

			switch (sortBy) {
				case "name":
					comparison = a.name.localeCompare(b.name);
					break;
				case "score":
					// Use first template's score for comparison, or 0 if no templates
					comparison =
						(a.templateScores[0]?.currentScore ?? 0) - (b.templateScores[0]?.currentScore ?? 0);
					break;
				case "templateName":
					// Use first template's name for comparison, or empty string if no templates
					comparison = (a.templateScores[0]?.templateName ?? "").localeCompare(
						b.templateScores[0]?.templateName ?? "",
					);
					break;
				case "groupName":
					comparison = (a.groupName || "").localeCompare(b.groupName || "");
					break;
			}

			return sortOrder === "asc" ? comparison : -comparison;
		});
	}
}

// ============================================================================
// Export Factory Function
// ============================================================================

export function createBulkScoreManager(
	prisma: PrismaClient,
	clientFactory: ArrClientFactory,
): BulkScoreManager {
	return new BulkScoreManager(prisma, clientFactory);
}
