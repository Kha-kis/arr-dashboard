/**
 * Template merge logic for TRaSH Guides synchronization.
 *
 * Pure functions that merge a user's template config with the latest TRaSH data,
 * preserving user customizations (score overrides, condition toggles) while
 * updating specifications and handling additions/removals.
 */

import type {
	TemplateConfig,
	TemplateCustomFormat,
	TemplateCustomFormatGroup,
	TrashCustomFormat,
	TrashCustomFormatGroup,
} from "@arr/shared";
import { dequal as deepEqual } from "dequal";
import { getRecommendedScore, type TrashCFWithScores } from "./template-score-utils.js";
import type { MergeResult, MergeStats, ScoreConflict } from "./template-updater-types.js";

/**
 * Merge current template config with latest TRaSH data.
 *
 * Merge strategy:
 * - For existing CFs: Preserve user's scoreOverride and conditionsEnabled, update originalConfig
 * - For new CFs: Add with TRaSH defaults (or recommended scores if applyScoreUpdates)
 * - For removed CFs: Behavior depends on deleteRemovedCFs option and CF origin
 *   - deleteRemovedCFs: false (default) → Mark as deprecated, keep in template
 *   - deleteRemovedCFs: true + origin="trash_sync" → Remove from template
 *   - origin="user_added" → Always keep (never delete user CFs)
 * - For groups: Same strategy - preserve enabled state, update originalConfig
 */
export function mergeTemplateConfig(
	currentConfig: TemplateConfig,
	latestCustomFormats: TrashCustomFormat[],
	latestCustomFormatGroups: TrashCustomFormatGroup[],
	scoreOptions?: {
		applyScoreUpdates?: boolean;
		scoreSet?: string;
		deleteRemovedCFs?: boolean;
		targetCommitHash?: string;
	},
): MergeResult {
	const stats: MergeStats = {
		customFormatsAdded: 0,
		customFormatsRemoved: 0,
		customFormatsUpdated: 0,
		customFormatsPreserved: 0,
		customFormatsDeprecated: 0,
		customFormatGroupsAdded: 0,
		customFormatGroupsRemoved: 0,
		customFormatGroupsUpdated: 0,
		customFormatGroupsPreserved: 0,
		customFormatGroupsDeprecated: 0,
		userCustomizationsPreserved: [],
		scoresUpdated: 0,
		scoresSkippedDueToOverride: 0,
		addedCFDetails: [],
		removedCFDetails: [],
		updatedCFDetails: [],
		deprecatedCFDetails: [],
		scoreChangeDetails: [],
	};
	const warnings: string[] = [];
	const scoreConflicts: ScoreConflict[] = [];

	const scoreSet = scoreOptions?.scoreSet || "default";

	// Build lookup maps for current config
	const currentCFMap = new Map<string, TemplateCustomFormat>(
		(currentConfig.customFormats || []).map((cf) => [cf.trashId, cf]),
	);
	const currentGroupMap = new Map<string, TemplateCustomFormatGroup>(
		(currentConfig.customFormatGroups || []).map((g) => [g.trashId, g]),
	);

	// Build lookup for latest TRaSH data
	const latestCFMap = new Map<string, TrashCustomFormat>(
		latestCustomFormats.map((cf) => [cf.trash_id, cf]),
	);
	const latestGroupMap = new Map<string, TrashCustomFormatGroup>(
		latestCustomFormatGroups.map((g) => [g.trash_id, g]),
	);

	// Merge Custom Formats
	const mergedCustomFormats: TemplateCustomFormat[] = [];

	for (const [trashId, latestCF] of latestCFMap) {
		const currentCF = currentCFMap.get(trashId);
		const latestCFWithScores = latestCF as TrashCFWithScores;
		const recommendedScore = getRecommendedScore(latestCFWithScores, scoreSet);

		if (currentCF) {
			// Existing CF - preserve user customizations, update specifications
			const hasScoreOverride = currentCF.scoreOverride !== undefined;
			// Get current score using correct priority: scoreOverride > trash_scores > fallback
			const cfWithScores = currentCF.originalConfig as TrashCFWithScores | undefined;
			let currentScore: number;
			if (currentCF.scoreOverride !== undefined) {
				currentScore = currentCF.scoreOverride;
			} else if (cfWithScores?.trash_scores) {
				currentScore =
					cfWithScores.trash_scores[scoreSet] ?? cfWithScores.trash_scores.default ?? 0;
			} else {
				currentScore = 0;
			}
			const hasCustomConditions = Object.values(currentCF.conditionsEnabled || {}).some(
				(enabled) => !enabled,
			);

			// Determine final score based on applyScoreUpdates option
			const finalScoreOverride: number | undefined = currentCF.scoreOverride;
			const userOverrideScore = currentCF.scoreOverride;

			if (scoreOptions?.applyScoreUpdates) {
				if (hasScoreOverride && userOverrideScore !== undefined) {
					if (userOverrideScore !== recommendedScore) {
						stats.scoresSkippedDueToOverride++;
						scoreConflicts.push({
							trashId,
							name: latestCF.name,
							currentScore: userOverrideScore,
							recommendedScore,
							userHasOverride: true,
						});
					}
				} else {
					if (currentScore !== recommendedScore) {
						stats.scoresUpdated++;
						stats.scoreChangeDetails.push({
							trashId,
							name: latestCF.name,
							oldScore: currentScore,
							newScore: recommendedScore,
						});
					}
				}
			}

			if (hasScoreOverride) {
				stats.userCustomizationsPreserved.push(`${latestCF.name}: custom score`);
			}
			if (hasCustomConditions) {
				stats.userCustomizationsPreserved.push(`${latestCF.name}: custom conditions`);
			}

			// Check if specifications changed
			const specsChanged = !deepEqual(
				currentCF.originalConfig?.specifications ?? null,
				latestCF.specifications ?? null,
			);

			if (specsChanged) {
				stats.customFormatsUpdated++;
				stats.updatedCFDetails.push({
					trashId,
					name: latestCF.name,
				});
			} else {
				stats.customFormatsPreserved++;
			}

			// Rebuild conditionsEnabled based on new specifications
			const newConditionsEnabled: Record<string, boolean> = {};
			for (const spec of latestCF.specifications || []) {
				newConditionsEnabled[spec.name] = currentCF.conditionsEnabled?.[spec.name] ?? true;
			}

			mergedCustomFormats.push({
				trashId: latestCF.trash_id,
				name: latestCF.name,
				scoreOverride: finalScoreOverride,
				conditionsEnabled: newConditionsEnabled,
				originalConfig: latestCF,
				origin: currentCF.origin || "trash_sync",
				addedAt: currentCF.addedAt,
				deprecated: undefined,
				deprecatedAt: undefined,
				deprecatedReason: undefined,
			});
		} else {
			// New CF from TRaSH Guides
			stats.customFormatsAdded++;

			const conditionsEnabled: Record<string, boolean> = {};
			for (const spec of latestCF.specifications || []) {
				conditionsEnabled[spec.name] = true;
			}

			const changelogScore = recommendedScore;

			stats.addedCFDetails.push({
				trashId: latestCF.trash_id,
				name: latestCF.name,
				score: changelogScore,
			});

			mergedCustomFormats.push({
				trashId: latestCF.trash_id,
				name: latestCF.name,
				scoreOverride: undefined,
				conditionsEnabled,
				originalConfig: latestCF,
				origin: "trash_sync",
				addedAt: new Date().toISOString(),
			});
		}
	}

	// Handle CFs no longer in TRaSH Guides
	const deleteRemovedCFs = scoreOptions?.deleteRemovedCFs ?? false;
	const commitHash = scoreOptions?.targetCommitHash || "unknown";

	for (const [trashId, currentCF] of currentCFMap) {
		if (!latestCFMap.has(trashId)) {
			const cfOrigin = currentCF.origin || "trash_sync";
			const isUserAdded = cfOrigin === "user_added";
			const deprecationReason = `No longer in TRaSH Guides as of commit ${commitHash}`;

			if (isUserAdded || !deleteRemovedCFs) {
				stats.customFormatsDeprecated++;
				stats.deprecatedCFDetails.push({
					trashId,
					name: currentCF.name,
					reason: deprecationReason,
				});

				if (!currentCF.deprecated) {
					warnings.push(
						`Custom format "${currentCF.name}" (${trashId}) marked deprecated - ${deprecationReason}`,
					);
				}

				mergedCustomFormats.push({
					...currentCF,
					deprecated: true,
					deprecatedAt: currentCF.deprecatedAt || new Date().toISOString(),
					deprecatedReason: deprecationReason,
				});
			} else {
				stats.customFormatsRemoved++;
				stats.removedCFDetails.push({
					trashId,
					name: currentCF.name,
				});
				warnings.push(
					`Custom format "${currentCF.name}" (${trashId}) removed - ${deprecationReason}`,
				);
			}
		}
	}

	// Merge Custom Format Groups
	const mergedCustomFormatGroups: TemplateCustomFormatGroup[] = [];

	for (const [trashId, latestGroup] of latestGroupMap) {
		const currentGroup = currentGroupMap.get(trashId);

		if (currentGroup) {
			const specsChanged = !deepEqual(currentGroup.originalConfig ?? null, latestGroup ?? null);

			if (specsChanged) {
				stats.customFormatGroupsUpdated++;
			} else {
				stats.customFormatGroupsPreserved++;
			}

			mergedCustomFormatGroups.push({
				trashId: latestGroup.trash_id,
				name: latestGroup.name,
				enabled: currentGroup.enabled,
				originalConfig: latestGroup,
				origin: currentGroup.origin || "trash_sync",
				addedAt: currentGroup.addedAt,
				deprecated: undefined,
				deprecatedAt: undefined,
				deprecatedReason: undefined,
			});
		} else {
			stats.customFormatGroupsAdded++;

			const defaultEnabled = latestGroup.default === true || latestGroup.default === "true";

			mergedCustomFormatGroups.push({
				trashId: latestGroup.trash_id,
				name: latestGroup.name,
				enabled: defaultEnabled,
				originalConfig: latestGroup,
				origin: "trash_sync",
				addedAt: new Date().toISOString(),
			});
		}
	}

	// Handle groups no longer in TRaSH Guides
	for (const [trashId, currentGroup] of currentGroupMap) {
		if (!latestGroupMap.has(trashId)) {
			const groupOrigin = currentGroup.origin || "trash_sync";
			const isUserAdded = groupOrigin === "user_added";
			const deprecationReason = `No longer in TRaSH Guides as of commit ${commitHash}`;

			if (isUserAdded || !deleteRemovedCFs) {
				stats.customFormatGroupsDeprecated++;

				if (!currentGroup.deprecated) {
					warnings.push(
						`Custom format group "${currentGroup.name}" (${trashId}) marked deprecated - ${deprecationReason}`,
					);
				}

				mergedCustomFormatGroups.push({
					...currentGroup,
					deprecated: true,
					deprecatedAt: currentGroup.deprecatedAt || new Date().toISOString(),
					deprecatedReason: deprecationReason,
				});
			} else {
				stats.customFormatGroupsRemoved++;
				warnings.push(
					`Custom format group "${currentGroup.name}" (${trashId}) removed - ${deprecationReason}`,
				);
			}
		}
	}

	// Build merged config, preserving other settings
	const mergedConfig: TemplateConfig = {
		...currentConfig,
		customFormats: mergedCustomFormats,
		customFormatGroups: mergedCustomFormatGroups,
	};

	return {
		success: true,
		mergedConfig,
		stats,
		warnings,
		scoreConflicts,
	};
}

/**
 * Validate merged configuration meets schema requirements.
 */
export function validateMergedConfig(config: TemplateConfig): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!Array.isArray(config.customFormats)) {
		errors.push("customFormats must be an array");
	} else {
		for (const [index, cf] of config.customFormats.entries()) {
			if (!cf.trashId) {
				errors.push(`customFormats[${index}]: trashId is required`);
			}
			if (!cf.name) {
				errors.push(`customFormats[${index}]: name is required`);
			}
			if (!cf.conditionsEnabled || typeof cf.conditionsEnabled !== "object") {
				errors.push(`customFormats[${index}]: conditionsEnabled must be an object`);
			}
			if (!cf.originalConfig) {
				errors.push(`customFormats[${index}]: originalConfig is required`);
			}
		}
	}

	if (config.customFormatGroups && !Array.isArray(config.customFormatGroups)) {
		errors.push("customFormatGroups must be an array");
	} else if (config.customFormatGroups) {
		for (const [index, group] of config.customFormatGroups.entries()) {
			if (!group.trashId) {
				errors.push(`customFormatGroups[${index}]: trashId is required`);
			}
			if (!group.name) {
				errors.push(`customFormatGroups[${index}]: name is required`);
			}
			if (typeof group.enabled !== "boolean") {
				errors.push(`customFormatGroups[${index}]: enabled must be a boolean`);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
