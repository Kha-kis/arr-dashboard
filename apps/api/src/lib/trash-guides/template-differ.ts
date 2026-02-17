/**
 * Template diff computation for TRaSH Guides synchronization.
 *
 * Computes a detailed diff between a template's current config and the latest
 * TRaSH data, including suggested CF additions and score changes.
 * Also handles historical diff reconstruction from changelog entries.
 */

import type {
	AutoSyncChangeLogEntry,
	CustomFormatDiff,
	CustomFormatGroupDiff,
	GroupCustomFormat,
	SuggestedCFAddition,
	SuggestedScoreChange,
	TemplateCustomFormat,
	TemplateCustomFormatGroup,
	TemplateDiffResult,
	TrashConfigType,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashQualityProfile,
} from "@arr/shared";
import { dequal as deepEqual } from "dequal";
import type { TrashCacheManager } from "./cache-manager.js";
import type { TrashGitHubFetcher } from "./github-fetcher.js";
import {
	getCurrentScore,
	getRecommendedScore,
	type TrashCFWithScores,
} from "./template-score-utils.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.trashGuides;

// ============================================================================
// Types
// ============================================================================

/** Minimal template shape needed by the diff computation. */
export interface DiffTemplateInput {
	id: string;
	name: string;
	serviceType: string;
	configData: string;
	trashGuidesCommitHash: string | null;
	hasUserModifications: boolean;
	changeLog: string | null;
	sourceQualityProfileTrashId: string | null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a diff between a template's current config and the latest TRaSH data.
 *
 * If the template is already at the target version, returns a historical diff
 * reconstructed from the most recent auto-sync changelog entry.
 */
export async function computeTemplateDiff(
	template: DiffTemplateInput,
	targetCommitHash: string,
	cacheManager: TrashCacheManager,
	githubFetcher: TrashGitHubFetcher,
): Promise<TemplateDiffResult> {
	const serviceType = template.serviceType as "RADARR" | "SONARR";

	// If template is already at target, return historical diff from changelog
	if (template.trashGuidesCommitHash === targetCommitHash) {
		const recentAutoSync = getRecentAutoSyncEntry(template.changeLog, targetCommitHash);

		if (recentAutoSync) {
			return transformAutoSyncToHistoricalDiff(template, targetCommitHash, recentAutoSync);
		}

		// No changelog entry — return empty diff with metadata
		return {
			templateId: template.id,
			templateName: template.name,
			currentCommit: template.trashGuidesCommitHash,
			latestCommit: targetCommitHash,
			summary: {
				totalChanges: 0,
				addedCFs: 0,
				removedCFs: 0,
				modifiedCFs: 0,
				unchangedCFs: 0,
			},
			customFormatDiffs: [],
			customFormatGroupDiffs: [],
			hasUserModifications: template.hasUserModifications,
			isHistorical: true,
		};
	}

	// Validate cache commit matches target; auto-refresh if stale
	const cacheCommitHash = await cacheManager.getCommitHash(serviceType, "CUSTOM_FORMATS");
	if (!cacheCommitHash || cacheCommitHash !== targetCommitHash) {
		const requiredCacheTypes: TrashConfigType[] = [
			"CUSTOM_FORMATS",
			"CF_GROUPS",
			"QUALITY_PROFILES",
		];

		for (const configType of requiredCacheTypes) {
			try {
				const data = await githubFetcher.fetchConfigs(serviceType, configType);
				await cacheManager.set(serviceType, configType, data, targetCommitHash);
			} catch (fetchError) {
				const errorMsg = getErrorMessage(fetchError);
				throw new Error(`Failed to refresh ${configType} cache for ${serviceType}: ${errorMsg}`);
			}
		}
	}

	// Get latest cache data for comparison
	const customFormatsCache = await cacheManager.get(serviceType, "CUSTOM_FORMATS");
	const cfGroupsCache = await cacheManager.get(serviceType, "CF_GROUPS");
	const qualityProfilesCache = await cacheManager.get(serviceType, "QUALITY_PROFILES");

	// Parse template config — throw on corruption so callers get a clear error
	// instead of silently returning an empty diff
	let templateConfig: {
		customFormats?: TemplateCustomFormat[];
		customFormatGroups?: TemplateCustomFormatGroup[];
		qualityProfile?: { trash_score_set?: string };
	};
	try {
		templateConfig = JSON.parse(template.configData) as typeof templateConfig;
	} catch (parseError) {
		throw new Error(
			`Template "${template.name}" (id: ${template.id}) has corrupt configData: ${getErrorMessage(parseError, "Unknown error")}`,
		);
	}

	const currentCFs = new Map<string, TemplateCustomFormat>(
		templateConfig.customFormats?.map((cf) => [cf.trashId, cf]) || [],
	);
	const currentGroups = new Map<string, TemplateCustomFormatGroup>(
		templateConfig.customFormatGroups?.map((g) => [g.trashId, g]) || [],
	);

	const scoreSet = templateConfig.qualityProfile?.trash_score_set || "default";

	// Parse latest cache data
	const latestCFsData = (customFormatsCache as TrashCustomFormat[] | null) ?? [];
	const latestCFs = new Map<string, TrashCustomFormat>(
		latestCFsData.map((cf) => [cf.trash_id, cf]),
	);
	const latestGroupsData = (cfGroupsCache as TrashCustomFormatGroup[] | null) ?? [];
	const latestGroups = new Map<string, TrashCustomFormatGroup>(
		latestGroupsData.map((g) => [g.trash_id, g]),
	);

	// ── Compare Custom Formats ──────────────────────────────────────────
	const customFormatDiffs: CustomFormatDiff[] = [];
	const addedCFs = 0; // Always 0 — additions are suggested separately
	let removedCFs = 0;
	let modifiedCFs = 0;
	let unchangedCFs = 0;

	for (const [trashId, latestCF] of latestCFs) {
		const currentCF = currentCFs.get(trashId);

		// CF not in template — skip (not shown as "added")
		if (!currentCF) continue;

		const currentSpecs = currentCF.originalConfig?.specifications ?? null;
		const latestSpecs = latestCF.specifications ?? null;
		const specificationsChanged = !deepEqual(currentSpecs, latestSpecs);

		const effectiveScore = getCurrentScore(currentCF, scoreSet);

		if (specificationsChanged) {
			customFormatDiffs.push({
				trashId,
				name: latestCF.name,
				changeType: "modified",
				currentScore: effectiveScore,
				newScore: effectiveScore,
				currentSpecifications: currentCF.originalConfig?.specifications || [],
				newSpecifications: latestCF.specifications || [],
				hasSpecificationChanges: true,
			});
			modifiedCFs++;
		} else {
			customFormatDiffs.push({
				trashId,
				name: latestCF.name,
				changeType: "unchanged",
				currentScore: effectiveScore,
				newScore: effectiveScore,
				currentSpecifications: currentCF.originalConfig?.specifications || [],
				newSpecifications: latestCF.specifications || [],
				hasSpecificationChanges: false,
			});
			unchangedCFs++;
		}
	}

	// Removed CFs
	for (const [trashId, currentCF] of currentCFs) {
		if (!latestCFs.has(trashId)) {
			const effectiveScore = getCurrentScore(currentCF, scoreSet);
			customFormatDiffs.push({
				trashId,
				name: currentCF.name,
				changeType: "removed",
				currentScore: effectiveScore,
				currentSpecifications: currentCF.originalConfig?.specifications || [],
				hasSpecificationChanges: false,
			});
			removedCFs++;
		}
	}

	// ── Compare Custom Format Groups ────────────────────────────────────
	const customFormatGroupDiffs: CustomFormatGroupDiff[] = [];

	for (const [trashId, latestGroup] of latestGroups) {
		const currentGroup = currentGroups.get(trashId);
		if (!currentGroup) continue;

		customFormatGroupDiffs.push({
			trashId,
			name: latestGroup.name,
			changeType: "unchanged",
			customFormatDiffs: [],
		});
	}

	for (const [trashId, currentGroup] of currentGroups) {
		if (!latestGroups.has(trashId)) {
			customFormatGroupDiffs.push({
				trashId,
				name: currentGroup.name,
				changeType: "removed",
				customFormatDiffs: [],
			});
		}
	}

	// ── Suggested Additions ─────────────────────────────────────────────
	const suggestedAdditions: SuggestedCFAddition[] = [];
	const suggestedScoreChanges: SuggestedScoreChange[] = [];

	// 1. Suggestions from CF Groups
	for (const [groupTrashId] of currentGroups) {
		const latestGroup = latestGroups.get(groupTrashId);
		if (!latestGroup?.custom_formats) continue;

		for (const cfRef of latestGroup.custom_formats) {
			const cfTrashId = typeof cfRef === "string" ? cfRef : (cfRef as GroupCustomFormat).trash_id;

			if (currentCFs.has(cfTrashId)) continue;
			if (suggestedAdditions.some((s) => s.trashId === cfTrashId)) continue;

			const fullCF = latestCFs.get(cfTrashId) as TrashCFWithScores | undefined;
			if (!fullCF) continue;

			suggestedAdditions.push({
				trashId: cfTrashId,
				name: fullCF.name,
				recommendedScore: getRecommendedScore(fullCF, scoreSet),
				source: "cf_group",
				sourceGroupName: latestGroup.name,
				specifications: fullCF.specifications || [],
			});
		}
	}

	// 2. Suggestions from Quality Profile
	if (template.sourceQualityProfileTrashId) {
		const qualityProfilesData = (qualityProfilesCache as TrashQualityProfile[] | null) ?? [];
		const linkedProfile = qualityProfilesData.find(
			(p) => p.trash_id === template.sourceQualityProfileTrashId,
		);

		if (linkedProfile?.formatItems) {
			for (const cfTrashId of Object.values(linkedProfile.formatItems)) {
				if (currentCFs.has(cfTrashId)) continue;
				if (suggestedAdditions.some((s) => s.trashId === cfTrashId)) continue;

				const fullCF = latestCFs.get(cfTrashId) as TrashCFWithScores | undefined;
				if (!fullCF) continue;

				suggestedAdditions.push({
					trashId: cfTrashId,
					name: fullCF.name,
					recommendedScore: getRecommendedScore(fullCF, scoreSet),
					source: "quality_profile",
					sourceProfileName: linkedProfile.name,
					specifications: fullCF.specifications || [],
				});
			}
		}
	}

	// 3. Score change suggestions
	for (const [trashId, currentCF] of currentCFs) {
		const latestCF = latestCFs.get(trashId) as TrashCFWithScores | undefined;
		if (!latestCF) continue;

		const currentScore = getCurrentScore(currentCF, scoreSet);
		const recommendedScore = getRecommendedScore(latestCF, scoreSet);

		if (currentCF.scoreOverride === undefined && currentScore !== recommendedScore) {
			suggestedScoreChanges.push({
				trashId,
				name: latestCF.name,
				currentScore,
				recommendedScore,
				scoreSet,
			});
		}
	}

	return {
		templateId: template.id,
		templateName: template.name,
		currentCommit: template.trashGuidesCommitHash,
		latestCommit: targetCommitHash,
		summary: {
			totalChanges: addedCFs + removedCFs + modifiedCFs,
			addedCFs,
			removedCFs,
			modifiedCFs,
			unchangedCFs,
		},
		customFormatDiffs,
		customFormatGroupDiffs,
		hasUserModifications: template.hasUserModifications,
		suggestedAdditions: suggestedAdditions.length > 0 ? suggestedAdditions : undefined,
		suggestedScoreChanges: suggestedScoreChanges.length > 0 ? suggestedScoreChanges : undefined,
	};
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Transform an AutoSyncChangeLogEntry into a TemplateDiffResult for historical display.
 */
function transformAutoSyncToHistoricalDiff(
	template: {
		id: string;
		name: string;
		hasUserModifications: boolean;
		trashGuidesCommitHash: string | null;
	},
	targetCommitHash: string,
	entry: AutoSyncChangeLogEntry,
): TemplateDiffResult {
	const addedDiffs: CustomFormatDiff[] = entry.customFormatsAdded.map((cf) => ({
		trashId: cf.trashId,
		name: cf.name,
		changeType: "added" as const,
		newScore: cf.score,
		hasSpecificationChanges: true,
	}));

	const removedDiffs: CustomFormatDiff[] = entry.customFormatsRemoved.map((cf) => ({
		trashId: cf.trashId,
		name: cf.name,
		changeType: "removed" as const,
		hasSpecificationChanges: false,
	}));

	const updatedDiffs: CustomFormatDiff[] = entry.customFormatsUpdated.map((cf) => ({
		trashId: cf.trashId,
		name: cf.name,
		changeType: "modified" as const,
		hasSpecificationChanges: true,
	}));

	const customFormatDiffs: CustomFormatDiff[] = [...addedDiffs, ...removedDiffs, ...updatedDiffs];

	const historicalScoreChanges: SuggestedScoreChange[] = entry.scoreChanges.map((sc) => ({
		trashId: sc.trashId,
		name: sc.name,
		currentScore: sc.newScore,
		recommendedScore: sc.newScore,
		scoreSet: "applied",
	}));

	return {
		templateId: template.id,
		templateName: template.name,
		currentCommit: entry.fromCommitHash,
		latestCommit: targetCommitHash,
		summary: {
			totalChanges:
				entry.summaryStats.customFormatsAdded +
				entry.summaryStats.customFormatsRemoved +
				entry.summaryStats.customFormatsUpdated,
			addedCFs: entry.summaryStats.customFormatsAdded,
			removedCFs: entry.summaryStats.customFormatsRemoved,
			modifiedCFs: entry.summaryStats.customFormatsUpdated,
			unchangedCFs: entry.summaryStats.customFormatsPreserved,
		},
		customFormatDiffs,
		customFormatGroupDiffs: [],
		hasUserModifications: template.hasUserModifications,
		suggestedScoreChanges: historicalScoreChanges.length > 0 ? historicalScoreChanges : undefined,
		isHistorical: true,
		historicalSyncTimestamp: entry.timestamp,
	};
}

/**
 * Get the most recent auto-sync changelog entry for a template.
 */
function getRecentAutoSyncEntry(
	changeLogJson: string | null,
	targetCommitHash?: string,
): AutoSyncChangeLogEntry | null {
	if (!changeLogJson) {
		return null;
	}

	let changeLog: unknown[];
	try {
		const parsed = JSON.parse(changeLogJson);
		changeLog = Array.isArray(parsed) ? parsed : [];
	} catch (parseError) {
		log.warn(
			{ err: parseError },
			"Failed to parse changeLog in getRecentAutoSyncEntry",
		);
		return null;
	}

	const autoSyncEntries = changeLog.filter((entry): entry is AutoSyncChangeLogEntry =>
		isAutoSyncChangeLogEntry(entry),
	);

	if (autoSyncEntries.length === 0) {
		return null;
	}

	let candidates = autoSyncEntries;
	if (targetCommitHash) {
		candidates = autoSyncEntries.filter((entry) => entry.toCommitHash === targetCommitHash);
	}

	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	return candidates[0] ?? null;
}

/**
 * Type guard to validate an entry matches AutoSyncChangeLogEntry interface structure.
 */
function isAutoSyncChangeLogEntry(entry: unknown): entry is AutoSyncChangeLogEntry {
	if (typeof entry !== "object" || entry === null) {
		return false;
	}

	const e = entry as Record<string, unknown>;

	if (e.changeType !== "auto_sync") {
		return false;
	}
	if (typeof e.timestamp !== "string") {
		return false;
	}
	if (typeof e.toCommitHash !== "string") {
		return false;
	}
	if (e.fromCommitHash !== null && typeof e.fromCommitHash !== "string") {
		return false;
	}
	if (!Array.isArray(e.customFormatsAdded)) {
		return false;
	}
	if (!Array.isArray(e.customFormatsRemoved)) {
		return false;
	}
	if (!Array.isArray(e.customFormatsUpdated)) {
		return false;
	}
	if (!Array.isArray(e.scoreChanges)) {
		return false;
	}
	if (typeof e.summaryStats !== "object" || e.summaryStats === null) {
		return false;
	}

	return true;
}
