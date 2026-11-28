/**
 * Quality profile creation strategies.
 *
 * Three standalone async functions that create quality profiles on ARR instances,
 * each handling a different source of quality configuration:
 * 1. Schema-based (TRaSH Guides profile definition)
 * 2. Cloned profile (from another instance)
 * 3. Custom config (user-defined quality item ordering)
 */

import type { CustomQualityConfig } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import { ConflictError } from "../errors.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	assertReviewedQualityPlan,
	buildCustomQualityPlan,
	buildImportedQualityPlan,
	type DeploymentQualityPlan,
} from "./deployment-quality-plan.js";
import {
	applyCustomFormatScores,
	extractQualitiesFromSchema,
	normalizeQualityName,
	submitNewProfile,
	type TemplateCF,
} from "./quality-profile-helpers.js";

const log = loggers.deployment;

/**
 * Creates a quality profile from schema with template configuration.
 * Supports both TRaSH Guides profiles (qualityProfile) and cloned instance profiles (completeQualityProfile).
 * @param effectiveQualityConfig - The quality config to use (may be instance override or template default)
 */
export async function createQualityProfileFromSchema(
	client: SonarrClient | RadarrClient,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR template config
	templateConfig: Record<string, any>,
	templateCFs: TemplateCF[],
	profileName: string,
	effectiveQualityConfig?: CustomQualityConfig,
	beforeCreate?: () => void | Promise<void>,
	qualityPlan?: DeploymentQualityPlan,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	try {
		const schema = await client.qualityProfile.getSchema();

		const customQualityConfig =
			effectiveQualityConfig ??
			(templateConfig.customQualityConfig as CustomQualityConfig | undefined);
		const customPlan =
			customQualityConfig?.useCustomQualities && customQualityConfig.items.length > 0
				? buildCustomQualityPlan(schema.items ?? [], customQualityConfig)
				: undefined;
		if (customPlan) assertReviewedQualityPlan(qualityPlan, customPlan);
		if (templateConfig.completeQualityProfile) {
			return await createQualityProfileFromClonedProfile(
				client,
				schema,
				templateConfig,
				templateCFs,
				profileName,
				beforeCreate,
				customPlan,
			);
		}

		if (customPlan) {
			return await createQualityProfileFromCustomConfig(
				client,
				schema,
				templateConfig,
				templateCFs,
				profileName,
				customPlan,
				beforeCreate,
			);
		}

		const importedPlan = buildImportedQualityPlan(
			schema.items ?? [],
			templateConfig.qualityProfile,
		);
		assertReviewedQualityPlan(qualityPlan, importedPlan);
		const scoreSet = templateConfig.qualityProfile?.trash_score_set;
		const { formatItemsWithScores } = await applyCustomFormatScores(
			client,
			schema.formatItems || [],
			templateCFs,
			scoreSet,
		);

		const hasDefinedScores = formatItemsWithScores.some(
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic formatItem
			(item: any) => item.score && item.score !== 0,
		);
		const templateMinScore = templateConfig.qualityProfile?.minFormatScore ?? 0;
		const effectiveMinScore = !hasDefinedScores && templateMinScore > 0 ? 0 : templateMinScore;

		const profileToCreate = {
			...schema,
			name: profileName,
			upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
			...importedPlan,
			minFormatScore: effectiveMinScore,
			cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
			minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
			formatItems: formatItemsWithScores,
			...(templateConfig.qualityProfile?.language
				? {
						language: {
							id:
								templateConfig.qualityProfile.language === "Original"
									? -2
									: templateConfig.qualityProfile.language === "Any"
										? -1
										: 1,
							name: templateConfig.qualityProfile.language,
						},
					}
				: {
						language: { id: -2, name: "Original" },
					}),
		};

		await beforeCreate?.();
		return await submitNewProfile(client, profileToCreate);
	} catch (createError) {
		if (createError instanceof ConflictError) throw createError;
		log.error({ err: createError }, "Failed to create quality profile");
		throw new Error(
			`Failed to create quality profile: ${getErrorMessage(createError, "Unknown error")}`,
		);
	}
}

/**
 * Creates a quality profile from a cloned instance profile (completeQualityProfile).
 * This preserves the exact quality item structure from the source instance.
 */
export async function createQualityProfileFromClonedProfile(
	client: SonarrClient | RadarrClient,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema
	schema: any,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR template config
	templateConfig: Record<string, any>,
	templateCFs: TemplateCF[],
	profileName: string,
	beforeCreate?: () => void | Promise<void>,
	qualityPlan?: DeploymentQualityPlan,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	const clonedProfile = templateConfig.completeQualityProfile;

	const { byId: allAvailableQualities, byName: qualitiesByName } = extractQualitiesFromSchema(
		schema.items,
	);

	let customGroupId = 1000;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	const qualityItems: any[] = [];
	const sourceIdToNewId = new Map<number, number>();

	for (const sourceItem of clonedProfile.items || []) {
		if (sourceItem.items && Array.isArray(sourceItem.items) && sourceItem.items.length > 0) {
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
			const groupQualities: any[] = [];

			for (const subItem of sourceItem.items) {
				let targetQuality = allAvailableQualities.get(subItem.id);
				if (!targetQuality && subItem.name) {
					targetQuality = qualitiesByName.get(normalizeQualityName(subItem.name));
				}

				if (targetQuality) {
					groupQualities.push({
						quality: targetQuality.quality,
						items: [],
						allowed: subItem.allowed,
					});
				}
			}

			if (groupQualities.length > 0) {
				const newGroupId = customGroupId++;
				if (sourceItem.id !== undefined) {
					sourceIdToNewId.set(sourceItem.id, newGroupId);
				}
				qualityItems.push({
					name: sourceItem.name,
					items: groupQualities,
					allowed: sourceItem.allowed,
					id: newGroupId,
				});
			}
		} else if (sourceItem.quality) {
			let targetQuality = allAvailableQualities.get(sourceItem.quality.id);
			if (!targetQuality && sourceItem.quality.name) {
				targetQuality = qualitiesByName.get(normalizeQualityName(sourceItem.quality.name));
			}

			if (targetQuality) {
				const newId = targetQuality.quality?.id ?? sourceItem.quality.id;
				if (sourceItem.quality.id !== undefined) {
					sourceIdToNewId.set(sourceItem.quality.id, newId);
				}
				qualityItems.push({
					...targetQuality,
					allowed: sourceItem.allowed,
				});
			}
		}
	}

	let remappedCutoff = clonedProfile.cutoff;
	if (sourceIdToNewId.has(clonedProfile.cutoff)) {
		remappedCutoff = sourceIdToNewId.get(clonedProfile.cutoff)!;
	} else {
		if (qualityItems.length > 0) {
			const lastItem = qualityItems[qualityItems.length - 1];
			remappedCutoff = lastItem.id ?? lastItem.quality?.id ?? 1;
			log.warn(
				{ sourceCutoff: clonedProfile.cutoff, fallbackCutoff: remappedCutoff },
				"Cutoff ID not found in remapped items, using fallback",
			);
		}
	}

	const scoreSet = templateConfig.qualityProfile?.trash_score_set;
	const { formatItemsWithScores } = await applyCustomFormatScores(
		client,
		schema.formatItems || [],
		templateCFs,
		scoreSet,
	);

	const profileToCreate = {
		...schema,
		name: profileName,
		upgradeAllowed: clonedProfile.upgradeAllowed,
		cutoff: remappedCutoff,
		items: qualityItems,
		...qualityPlan,
		minFormatScore: clonedProfile.minFormatScore ?? 0,
		cutoffFormatScore: clonedProfile.cutoffFormatScore ?? 10000,
		minUpgradeFormatScore: clonedProfile.minUpgradeFormatScore ?? 1,
		formatItems: formatItemsWithScores,
		...(clonedProfile.language && {
			language: clonedProfile.language,
		}),
	};

	await beforeCreate?.();
	return await submitNewProfile(client, profileToCreate);
}

/**
 * Creates a quality profile from custom quality configuration.
 * This uses the user's customized quality items (order, groups, enabled state).
 */
export async function createQualityProfileFromCustomConfig(
	client: SonarrClient | RadarrClient,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema
	schema: any,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR template config
	templateConfig: Record<string, any>,
	templateCFs: TemplateCF[],
	profileName: string,
	qualityPlan: DeploymentQualityPlan,
	beforeCreate?: () => void | Promise<void>,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	const scoreSet = templateConfig.qualityProfile?.trash_score_set;
	const { formatItemsWithScores } = await applyCustomFormatScores(
		client,
		schema.formatItems || [],
		templateCFs,
		scoreSet,
	);

	const profileToCreate = {
		...schema,
		name: profileName,
		upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
		...qualityPlan,
		minFormatScore: templateConfig.qualityProfile?.minFormatScore ?? 0,
		cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
		minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
		formatItems: formatItemsWithScores,
	};

	await beforeCreate?.();
	return await submitNewProfile(client, profileToCreate);
}
