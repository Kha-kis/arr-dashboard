/**
 * Profile matching and CF recommendation engine for TRaSH Guides profile cloning.
 *
 * Extracted from `profile-clone-routes.ts` Routes 7–8 to keep routes as thin
 * HTTP adapters. All functions are pure (no I/O) and operate on pre-fetched data.
 */

import type {
	CompleteQualityProfile,
	CustomFormatSpecification,
	TemplateConfig,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashQualityProfile,
} from "@arr/shared";
import { findCutoffQualityName } from "../utils/quality-utils.js";
import type { TrashCFWithScores } from "./template-score-utils.js";

// ============================================================================
// Profile Matching
// ============================================================================

/** Successful profile match result. */
interface ProfileMatchSuccess {
	matched: true;
	matchType: "exact" | "fuzzy" | "partial";
	matchedProfile: TrashQualityProfile;
}

/** Failed profile match result. */
interface ProfileMatchFailure {
	matched: false;
	reason: string;
	availableProfiles?: string[];
}

export type ProfileMatchResult = ProfileMatchSuccess | ProfileMatchFailure;

/**
 * Match an instance profile name to TRaSH Guides quality profiles using
 * three-tier matching: exact normalized → fuzzy contains → partial word overlap (≥50%).
 */
export function matchProfileToTrash(
	profileName: string,
	qualityProfiles: TrashQualityProfile[],
): ProfileMatchResult {
	const normalizedInput = normalizeProfileName(profileName);

	// 1. Exact match (case-insensitive, normalized)
	let matchedProfile =
		qualityProfiles.find((p) => normalizeProfileName(p.name) === normalizedInput) || null;
	let matchType: "exact" | "fuzzy" | "partial" = "exact";

	// 2. Fuzzy matching (either contains the other)
	if (!matchedProfile) {
		matchType = "fuzzy";
		matchedProfile =
			qualityProfiles.find((p) => {
				const normalizedTrash = normalizeProfileName(p.name);
				return (
					normalizedTrash.includes(normalizedInput) || normalizedInput.includes(normalizedTrash)
				);
			}) || null;
	}

	// 3. Partial word matching (at least 50% significant word overlap)
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
		return {
			matched: false,
			reason: `No TRaSH Guides quality profile matches "${profileName}"`,
			availableProfiles: qualityProfiles.map((p) => p.name),
		};
	}

	return { matched: true, matchType, matchedProfile };
}

// ============================================================================
// CF Recommendations
// ============================================================================

export interface RecommendedCF {
	trash_id: string;
	name: string;
	score: number;
	source: "profile" | "group";
	groupName?: string;
	required: boolean;
}

export interface CFRecommendations {
	recommendedCFs: RecommendedCF[];
	recommendedTrashIds: Set<string>;
}

/**
 * Build the list of recommended Custom Formats for a matched TRaSH quality profile.
 *
 * Collects CFs from two sources:
 * 1. Mandatory CFs from the profile's `formatItems`
 * 2. Optional CFs from applicable CF groups (respecting exclusion rules)
 */
export function buildCFRecommendations(
	matchedProfile: TrashQualityProfile,
	customFormats: TrashCustomFormat[] | null,
	cfGroups: TrashCustomFormatGroup[] | null,
): CFRecommendations {
	const recommendedCFs: RecommendedCF[] = [];

	// Build CF lookup map
	const cfLookup = new Map<string, TrashCustomFormat>();
	if (customFormats) {
		for (const cf of customFormats) {
			cfLookup.set(cf.trash_id, cf);
		}
	}

	const scoreSet = matchedProfile.trash_score_set;

	// Score resolver: scoreSet-specific → trash_scores.default → cf.score → 0
	// Must handle undefined scoreSet (profiles without a score set still use trash_scores.default)
	const resolveScore = (cf: TrashCustomFormat): number => {
		const cfWithScores = cf as TrashCFWithScores;
		if (cfWithScores.trash_scores) {
			if (scoreSet && cfWithScores.trash_scores[scoreSet] !== undefined) {
				return cfWithScores.trash_scores[scoreSet];
			}
			if (cfWithScores.trash_scores.default !== undefined) {
				return cfWithScores.trash_scores.default;
			}
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
					score: resolveScore(cf),
					source: "profile",
					required: true,
				});
			}
		}
	}

	// 2. Add CFs from applicable CF groups
	if (cfGroups) {
		for (const group of cfGroups) {
			// Check if this group is excluded for the matched profile
			const isExcluded =
				group.quality_profiles?.exclude &&
				Object.values(group.quality_profiles.exclude).includes(matchedProfile.trash_id);

			if (isExcluded) continue;

			if (group.custom_formats) {
				for (const groupCF of group.custom_formats) {
					const cfTrashId = typeof groupCF === "string" ? groupCF : groupCF.trash_id;
					const cfRequired = typeof groupCF === "object" ? groupCF.required === true : false;

					// Skip if already added from profile
					if (recommendedCFs.some((r) => r.trash_id === cfTrashId)) continue;

					const cf = cfLookup.get(cfTrashId);
					if (cf) {
						const score = group.quality_profiles?.score ?? resolveScore(cf);
						recommendedCFs.push({
							trash_id: cfTrashId,
							name: cf.name,
							score,
							source: "group",
							groupName: group.name,
							required: cfRequired || group.required === true,
						});
					}
				}
			}
		}
	}

	return {
		recommendedCFs,
		recommendedTrashIds: new Set(recommendedCFs.map((cf) => cf.trash_id)),
	};
}

// ============================================================================
// Template Config Builders (Route 8 — create-template)
// ============================================================================

/**
 * Build the `customFormats` array for a new template config from user CF selections.
 *
 * Handles both TRaSH-linked CFs (matched by trash_id) and instance-only CFs
 * (identified by `instance-{id}` key format).
 */
export function buildCustomFormatsConfig(
	customFormatSelections: Record<
		string,
		{
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}
	>,
	cfLookup: Map<number, { id: number; name: string; specifications?: unknown[] }>,
	trashCFLookup: Map<string, TrashCustomFormat>,
	sourceInstanceId: string,
): TemplateConfig["customFormats"] {
	const customFormatsConfig: TemplateConfig["customFormats"] = [];

	for (const [cfKey, selection] of Object.entries(customFormatSelections)) {
		if (!selection.selected) continue;

		const trashCF = trashCFLookup.get(cfKey);

		if (trashCF) {
			// TRaSH-linked CF
			customFormatsConfig.push({
				trashId: cfKey,
				name: trashCF.name,
				scoreOverride: selection.scoreOverride,
				conditionsEnabled: selection.conditionsEnabled || {},
				originalConfig: trashCF,
			});
		} else if (cfKey.startsWith("instance-")) {
			// Instance-only CF (not linked to TRaSH)
			const instanceCFId = Number.parseInt(cfKey.replace("instance-", ""), 10);
			const instanceCF = cfLookup.get(instanceCFId);

			if (instanceCF) {
				customFormatsConfig.push({
					trashId: cfKey,
					name: instanceCF.name,
					scoreOverride: selection.scoreOverride,
					conditionsEnabled: selection.conditionsEnabled || {},
					originalConfig: {
						trash_id: cfKey,
						name: instanceCF.name,
						specifications: (instanceCF.specifications ?? []) as CustomFormatSpecification[],
						_source: "instance",
						_instanceId: sourceInstanceId,
						_instanceCFId: instanceCFId,
					},
				});
			}
		}
	}

	return customFormatsConfig;
}

// ============================================================================
// ARR API Response Types (needed by buildCompleteQualityProfile)
// ============================================================================

export interface ArrQualityProfileResponse {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	minFormatScore: number;
	cutoffFormatScore?: number;
	minUpgradeFormatScore?: number;
	formatItems?: Array<{ format: number; score: number }>;
	items?: ArrQualityItem[];
	language?: { id: number; name: string };
}

export interface ArrQualityItem {
	id?: number;
	name?: string;
	quality?: {
		id: number;
		name: string;
		source?: string;
		resolution?: number;
	};
	items?: Array<{
		id?: number;
		name?: string;
		source?: string;
		resolution?: number;
		allowed?: boolean;
		quality?: { id: number; name: string; source?: string; resolution?: number };
	}>;
	allowed: boolean;
}

/**
 * Build a `CompleteQualityProfile` from a fetched ARR quality profile response.
 *
 * Resolves cutoff quality names, maps nested quality items with fallback defaults,
 * and attaches source metadata.
 */
export function buildCompleteQualityProfile(
	fullProfile: ArrQualityProfileResponse,
	profileConfig: {
		upgradeAllowed?: boolean;
		cutoff?: number;
		minFormatScore?: number;
		cutoffFormatScore?: number;
	} | undefined,
	sourceInfo: {
		sourceInstanceId: string;
		sourceInstanceLabel: string;
		sourceProfileId: number;
		sourceProfileName: string;
	},
): CompleteQualityProfile {
	const cutoffId = fullProfile.cutoff ?? profileConfig?.cutoff ?? 0;
	const cutoffQualityName = cutoffId
		? findCutoffQualityName(fullProfile.items || [], cutoffId)
		: undefined;

	return {
		// Source information
		sourceInstanceId: sourceInfo.sourceInstanceId,
		sourceInstanceLabel: sourceInfo.sourceInstanceLabel,
		sourceProfileId: sourceInfo.sourceProfileId,
		sourceProfileName: sourceInfo.sourceProfileName,
		importedAt: new Date().toISOString(),

		// Quality settings from the instance profile
		upgradeAllowed: fullProfile.upgradeAllowed ?? profileConfig?.upgradeAllowed ?? true,
		cutoff: cutoffId,
		cutoffQuality: cutoffId
			? {
					id: cutoffId,
					name: cutoffQualityName || "Unknown",
				}
			: undefined,

		// Quality items with full structure
		items: (fullProfile.items || []).map((item) => ({
			quality: item.quality
				? {
						id: item.quality.id,
						name: item.quality.name,
						source: item.quality.source,
						resolution: item.quality.resolution,
					}
				: undefined,
			items: item.items?.map((subItem) => ({
				id: subItem.id ?? subItem.quality?.id ?? 0,
				name: subItem.name ?? subItem.quality?.name ?? "",
				source: subItem.source ?? subItem.quality?.source,
				resolution: subItem.resolution ?? subItem.quality?.resolution,
				allowed: subItem.allowed ?? false,
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
		language: fullProfile.language
			? {
					id: fullProfile.language.id,
					name: fullProfile.language.name,
				}
			: undefined,
	};
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Normalize profile name for matching.
 * Removes common prefixes, suffixes, and normalizes whitespace.
 */
function normalizeProfileName(name: string): string {
	let result = name.toLowerCase().trim();

	// Remove "TRaSH - " or "TRaSH:" prefix
	const trashMatch = result.match(/^trash\s*[-:]\s*/);
	if (trashMatch) result = result.slice(trashMatch[0].length);

	// Remove version suffix like " v4" or " v4.0" from end (string-based to avoid ReDoS)
	const lastV = result.lastIndexOf(" v");
	if (lastV > 0) {
		const suffix = result.slice(lastV + 2);
		if (/^\d+(\.\d+)?$/.test(suffix)) {
			result = result.slice(0, lastV);
		}
	}

	// Remove parenthetical suffix from end (string-based to avoid ReDoS)
	if (result.endsWith(")")) {
		const openParen = result.lastIndexOf("(");
		if (openParen > 0) {
			const before = result.slice(0, openParen).trimEnd();
			if (before.length > 0) result = before;
		}
	}

	// Normalize separators and whitespace
	return result.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract significant words from a profile name (for fuzzy matching).
 * Filters out common words and short words.
 */
function extractSignificantWords(normalized: string): string[] {
	const stopWords = new Set(["the", "and", "or", "for", "with", "hd", "uhd", "web", "dl"]);
	return normalized.split(/\s+/).filter((w) => w.length >= 2 && !stopWords.has(w));
}
