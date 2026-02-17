/**
 * Quality profile creation strategies.
 *
 * Three standalone async functions that create quality profiles on ARR instances,
 * each handling a different source of quality configuration:
 * 1. Schema-based (TRaSH Guides profile definition)
 * 2. Cloned profile (from another instance)
 * 3. Custom config (user-defined quality item ordering)
 */

import type { SonarrClient, RadarrClient } from "arr-sdk";
import type { CustomQualityConfig } from "@arr/shared";
import {
	normalizeQualityName,
	extractQualitiesFromSchema,
	applyCustomFormatScores,
	submitNewProfile,
	reverseQualityItemsIfNeeded,
	type TemplateCF,
} from "./quality-profile-helpers.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";

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
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	try {
		const schema = await client.qualityProfile.getSchema();

		if (templateConfig.completeQualityProfile) {
			return await createQualityProfileFromClonedProfile(
				client,
				schema,
				templateConfig,
				templateCFs,
				profileName,
			);
		}

		const customQualityConfig =
			effectiveQualityConfig ??
			(templateConfig.customQualityConfig as CustomQualityConfig | undefined);
		if (customQualityConfig?.useCustomQualities && customQualityConfig.items.length > 0) {
			return await createQualityProfileFromCustomConfig(
				client,
				schema,
				templateConfig,
				templateCFs,
				profileName,
				customQualityConfig,
			);
		}

		const { byName: allAvailableQualities } = extractQualitiesFromSchema(schema.items || []);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item structure
		const qualityItems: any[] = [];
		let customGroupId = 1000;

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item structure
		const templateQualityItems: any[] = reverseQualityItemsIfNeeded(
			templateConfig.qualityProfile?.items || [],
		);

		for (const templateItem of templateQualityItems) {
			if (
				templateItem.items &&
				Array.isArray(templateItem.items) &&
				templateItem.items.length > 0
			) {
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
				const groupQualities: any[] = [];
				for (const qualityName of templateItem.items) {
					const quality = allAvailableQualities.get(normalizeQualityName(qualityName));
					if (quality) {
						groupQualities.push({
							...quality,
							allowed: false,
						});
					}
				}

				if (groupQualities.length > 0) {
					qualityItems.push({
						name: templateItem.name,
						items: groupQualities,
						allowed: templateItem.allowed,
						id: customGroupId++,
					});
				}
			} else {
				const quality = allAvailableQualities.get(normalizeQualityName(templateItem.name));
				if (quality) {
					qualityItems.push({
						...quality,
						allowed: templateItem.allowed,
					});
				}
			}
		}

		const scoreSet = templateConfig.qualityProfile?.trash_score_set;
		const { formatItemsWithScores } = await applyCustomFormatScores(
			client,
			schema.formatItems || [],
			templateCFs,
			scoreSet,
		);

		let cutoffId: number | null = null;
		if (templateConfig.qualityProfile?.cutoff) {
			const cutoffName = templateConfig.qualityProfile.cutoff;

			// biome-ignore lint/suspicious/noExplicitAny: Dynamic quality item tree
			const findQualityId = (items: any[], name: string): number | null => {
				const normalizedSearchName = normalizeQualityName(name);

				for (const item of items) {
					const itemName = item.quality?.name || item.name;
					if (itemName && normalizeQualityName(itemName) === normalizedSearchName) {
						return item.quality?.id || item.id;
					}
					if (item.items && Array.isArray(item.items)) {
						for (const subItem of item.items) {
							const subItemName = subItem.quality?.name || subItem.name;
							if (subItemName && normalizeQualityName(subItemName) === normalizedSearchName) {
								return item.id;
							}
						}
					}
				}
				return null;
			};

			const foundCutoffId = findQualityId(qualityItems, cutoffName);
			if (foundCutoffId) {
				cutoffId = foundCutoffId;
			}
		}

		if (cutoffId === null && qualityItems.length > 0) {
			const lastItem = qualityItems[qualityItems.length - 1];
			cutoffId = lastItem.id ?? lastItem.quality?.id ?? 1;
			log.warn({ cutoffId }, "Could not resolve cutoff, using fallback");
		}

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
			cutoff: cutoffId ?? 1,
			items: qualityItems,
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

		return await submitNewProfile(client, profileToCreate);
	} catch (createError) {
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
		minFormatScore: clonedProfile.minFormatScore ?? 0,
		cutoffFormatScore: clonedProfile.cutoffFormatScore ?? 10000,
		minUpgradeFormatScore: clonedProfile.minUpgradeFormatScore ?? 1,
		formatItems: formatItemsWithScores,
		...(clonedProfile.language && {
			language: clonedProfile.language,
		}),
	};

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
	customQualityConfig: CustomQualityConfig,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	const { byName: qualitiesByName } = extractQualitiesFromSchema(schema.items);

	let customGroupId = 1000;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	const qualityItems: any[] = [];
	const itemIdMap = new Map<string, number>();

	for (const entry of customQualityConfig.items) {
		if (entry.type === "group") {
			const group = entry.group;
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
			const groupQualities: any[] = [];

			for (const quality of group.qualities) {
				const targetQuality = qualitiesByName.get(normalizeQualityName(quality.name));
				if (targetQuality) {
					groupQualities.push({
						quality: targetQuality.quality,
						items: [],
						allowed: false,
					});
				}
			}

			if (groupQualities.length > 0) {
				const newGroupId = customGroupId++;
				itemIdMap.set(group.id, newGroupId);
				qualityItems.push({
					name: group.name,
					items: groupQualities,
					allowed: group.allowed,
					id: newGroupId,
				});
			}
		} else {
			const item = entry.item;
			const targetQuality = qualitiesByName.get(normalizeQualityName(item.name));
			if (targetQuality) {
				const qualityId = targetQuality.quality?.id;
				if (qualityId !== undefined) {
					itemIdMap.set(item.id, qualityId);
				}
				qualityItems.push({
					...targetQuality,
					allowed: item.allowed,
				});
			}
		}
	}

	let cutoffId: number | null = null;
	if (customQualityConfig.cutoffId) {
		const mappedId = itemIdMap.get(customQualityConfig.cutoffId);
		if (mappedId !== undefined) {
			cutoffId = mappedId;
		}
	}

	if (cutoffId === null && qualityItems.length > 0) {
		const lastItem = qualityItems[qualityItems.length - 1];
		cutoffId = lastItem.id ?? lastItem.quality?.id ?? 1;
		log.warn({ cutoffId }, "Custom quality cutoff not resolved, using fallback");
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
		upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
		cutoff: cutoffId ?? 1,
		items: qualityItems,
		minFormatScore: templateConfig.qualityProfile?.minFormatScore ?? 0,
		cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
		minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
		formatItems: formatItemsWithScores,
	};

	return await submitNewProfile(client, profileToCreate);
}
