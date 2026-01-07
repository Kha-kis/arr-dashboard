/**
 * Custom Format Matcher
 *
 * Matches Custom Formats from *arr instances against TRaSH Guides cache
 * to enable linking, updates, and score recommendations.
 */

import type { TrashConfigType, TrashCustomFormat } from "@arr/shared";
import type { PrismaClient } from "@prisma/client";
import { dequal as deepEqual } from "dequal";
import { createCacheManager } from "./cache-manager.js";

// ============================================================================
// Types
// ============================================================================

export type MatchConfidence = "exact" | "name_only" | "specs_similar" | "no_match";

export interface CFMatchResult {
	/** The instance CF being matched */
	instanceCF: InstanceCustomFormat;
	/** The matched TRaSH CF, if found */
	trashCF: TrashCustomFormat | null;
	/** Confidence level of the match */
	confidence: MatchConfidence;
	/** Details about the match */
	matchDetails: {
		nameMatch: boolean;
		specsMatch: boolean;
		specsDiffer?: string[]; // Which specs differ
	};
	/** Recommended score from TRaSH Guides (if matched) */
	recommendedScore?: number;
	/** Score set the recommendation came from */
	scoreSet?: string;
}

export interface InstanceCustomFormat {
	id: number;
	name: string;
	trash_id?: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: InstanceCFSpecification[];
	/** Score from the quality profile (if available) */
	score?: number;
}

export interface InstanceCFSpecification {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Array<{ name: string; value: unknown }> | Record<string, unknown>;
}

export interface CFMatchSummary {
	/** Total CFs analyzed */
	total: number;
	/** CFs with exact trash_id match */
	exactMatches: number;
	/** CFs with name match only (specs may differ) */
	nameMatches: number;
	/** CFs with similar specs but different name */
	specsSimilar: number;
	/** CFs with no match found */
	noMatch: number;
	/** Detailed results for each CF */
	results: CFMatchResult[];
}

// ============================================================================
// Normalization Utilities (adapted from deployment-preview.ts)
// ============================================================================

interface NormalizedSpec {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
}

/**
 * Normalize fields from either format to a consistent object format
 * Instance format: [{ name: "value", value: 5 }]
 * TRaSH format: { value: 5 }
 * Output: { value: 5 }
 */
function normalizeFields(fields: unknown): Record<string, unknown> {
	if (!fields) {
		return {};
	}

	// If already an object (TRaSH format), return as-is
	if (!Array.isArray(fields) && typeof fields === "object") {
		return fields as Record<string, unknown>;
	}

	// If array (Instance format), convert to object
	if (Array.isArray(fields)) {
		const result: Record<string, unknown> = {};
		for (const field of fields) {
			if (field && typeof field === "object" && "name" in field && "value" in field) {
				result[field.name as string] = field.value;
			}
		}
		return result;
	}

	return {};
}

/**
 * Normalize a specification to a consistent format for comparison
 */
function normalizeSpec(
	spec: InstanceCFSpecification | TrashCustomFormat["specifications"][0],
): NormalizedSpec {
	return {
		name: spec.name || "",
		implementation: spec.implementation || "",
		negate: Boolean(spec.negate),
		required: Boolean(spec.required),
		fields: normalizeFields(spec.fields),
	};
}

/**
 * Compare two normalized specs for equality
 * Returns true if specs match, false otherwise
 */
function specsAreEqual(spec1: NormalizedSpec, spec2: NormalizedSpec): boolean {
	if (spec1.name !== spec2.name) return false;
	if (spec1.implementation !== spec2.implementation) return false;
	if (spec1.negate !== spec2.negate) return false;
	if (spec1.required !== spec2.required) return false;

	// Compare fields - use deep equality
	return deepEqual(spec1.fields, spec2.fields);
}

/**
 * Compare spec arrays and return differences
 */
function compareSpecArrays(
	instanceSpecs: InstanceCFSpecification[],
	trashSpecs: TrashCustomFormat["specifications"],
): { match: boolean; differences: string[] } {
	const differences: string[] = [];

	if (instanceSpecs.length !== trashSpecs.length) {
		differences.push(
			`Spec count differs: instance has ${instanceSpecs.length}, TRaSH has ${trashSpecs.length}`,
		);
	}

	const normalizedInstance = instanceSpecs.map(normalizeSpec);
	const normalizedTrash = trashSpecs.map(normalizeSpec);

	// Sort by name+implementation for consistent comparison
	const sortKey = (s: NormalizedSpec) => `${s.name}:${s.implementation}`;
	normalizedInstance.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
	normalizedTrash.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

	// Create maps for easier comparison
	const instanceMap = new Map(normalizedInstance.map((s) => [sortKey(s), s]));
	const trashMap = new Map(normalizedTrash.map((s) => [sortKey(s), s]));

	// Find specs in instance not in TRaSH
	for (const [key, instanceSpec] of instanceMap) {
		const trashSpec = trashMap.get(key);
		if (!trashSpec) {
			differences.push(`Spec "${instanceSpec.name}" (${instanceSpec.implementation}) not in TRaSH`);
		} else if (!specsAreEqual(instanceSpec, trashSpec)) {
			differences.push(`Spec "${instanceSpec.name}" fields differ`);
		}
	}

	// Find specs in TRaSH not in instance
	for (const [key, trashSpec] of trashMap) {
		if (!instanceMap.has(key)) {
			differences.push(
				`TRaSH spec "${trashSpec.name}" (${trashSpec.implementation}) not in instance`,
			);
		}
	}

	return {
		match: differences.length === 0,
		differences,
	};
}

// ============================================================================
// Internal Types for Core Matching
// ============================================================================

/**
 * Intermediate result from core matching logic (strategies 1 & 2)
 */
interface CoreMatchResult {
	matchedTrashCF: TrashCustomFormat | null;
	confidence: MatchConfidence;
	matchDetails: {
		nameMatch: boolean;
		specsMatch: boolean;
		specsDiffer?: string[];
	};
}

// ============================================================================
// CF Matcher Class
// ============================================================================

export class CFMatcher {
	private prisma: PrismaClient;
	private trashCFCache: Map<string, TrashCustomFormat[]> = new Map();

	constructor(prisma: PrismaClient) {
		this.prisma = prisma;
	}

	/**
	 * Load TRaSH CFs from cache for a service type
	 */
	private async loadTrashCFs(serviceType: "RADARR" | "SONARR"): Promise<TrashCustomFormat[]> {
		const cacheKey = serviceType;
		if (this.trashCFCache.has(cacheKey)) {
			return this.trashCFCache.get(cacheKey)!;
		}

		const cacheManager = createCacheManager(this.prisma);
		const trashCFs = await cacheManager.get<TrashCustomFormat[]>(
			serviceType,
			"CUSTOM_FORMATS" as TrashConfigType,
		);

		const result = trashCFs || [];
		this.trashCFCache.set(cacheKey, result);
		return result;
	}

	/**
	 * Core matching logic: strategies 1 (trash_id) and 2 (name match)
	 * Extracted to eliminate duplication between matchSingleCF and matchSingleCFWithMaps
	 *
	 * @param instanceCF - The instance CF to match
	 * @param trashByTrashId - Pre-built map of trash_id -> TrashCustomFormat
	 * @param trashByName - Pre-built map of lowercase name -> TrashCustomFormat
	 * @returns Intermediate match result (before optional Strategy 3)
	 */
	private matchCFByIdAndName(
		instanceCF: InstanceCustomFormat,
		trashByTrashId: Map<string, TrashCustomFormat>,
		trashByName: Map<string, TrashCustomFormat>,
	): CoreMatchResult {
		const extractedTrashId = this.extractTrashId(instanceCF);

		const matchDetails = {
			nameMatch: false,
			specsMatch: false,
			specsDiffer: undefined as string[] | undefined,
		};

		let matchedTrashCF: TrashCustomFormat | null = null;
		let confidence: MatchConfidence = "no_match";

		// Strategy 1: Exact trash_id match (fast O(1) lookup for previously TRaSH-deployed CFs)
		if (extractedTrashId) {
			const trashCF = trashByTrashId.get(extractedTrashId);
			if (trashCF) {
				matchedTrashCF = trashCF;
				matchDetails.nameMatch = trashCF.name.toLowerCase() === instanceCF.name.toLowerCase();

				const specComparison = compareSpecArrays(instanceCF.specifications, trashCF.specifications);
				matchDetails.specsMatch = specComparison.match;
				matchDetails.specsDiffer =
					specComparison.differences.length > 0 ? specComparison.differences : undefined;

				confidence = "exact";
			}
		}

		// Strategy 2: Name match (fast O(1) lookup)
		if (!matchedTrashCF) {
			const trashCF = trashByName.get(instanceCF.name.toLowerCase());
			if (trashCF) {
				matchedTrashCF = trashCF;
				matchDetails.nameMatch = true;

				const specComparison = compareSpecArrays(instanceCF.specifications, trashCF.specifications);
				matchDetails.specsMatch = specComparison.match;
				matchDetails.specsDiffer =
					specComparison.differences.length > 0 ? specComparison.differences : undefined;

				confidence = specComparison.match ? "name_only" : "specs_similar";
			}
		}

		return { matchedTrashCF, confidence, matchDetails };
	}

	/**
	 * Calculate recommended score from TRaSH CF
	 *
	 * Priority: specified score set > "default" score set > score property
	 */
	private calculateRecommendedScore(
		matchedTrashCF: TrashCustomFormat | null,
		scoreSet?: string,
	): { recommendedScore?: number; usedScoreSet?: string } {
		if (!matchedTrashCF) {
			return {};
		}

		let recommendedScore: number | undefined;
		let usedScoreSet: string | undefined;

		const trashScores = (
			matchedTrashCF as TrashCustomFormat & { trash_scores?: Record<string, number> }
		).trash_scores;

		if (trashScores) {
			if (scoreSet && trashScores[scoreSet] !== undefined) {
				recommendedScore = trashScores[scoreSet];
				usedScoreSet = scoreSet;
			} else if (trashScores.default !== undefined) {
				recommendedScore = trashScores.default;
				usedScoreSet = "default";
			}
		}

		// Fallback to score property
		if (recommendedScore === undefined && matchedTrashCF.score !== undefined) {
			recommendedScore = matchedTrashCF.score;
		}

		return { recommendedScore, usedScoreSet };
	}

	/**
	 * Match a single instance CF against TRaSH cache
	 * Includes Strategy 3 (spec-based matching) for thorough matching
	 */
	async matchSingleCF(
		instanceCF: InstanceCustomFormat,
		serviceType: "RADARR" | "SONARR",
		scoreSet?: string,
	): Promise<CFMatchResult> {
		const trashCFs = await this.loadTrashCFs(serviceType);

		// Build lookup maps
		const trashByTrashId = new Map(trashCFs.map((cf) => [cf.trash_id, cf]));
		const trashByName = new Map(trashCFs.map((cf) => [cf.name.toLowerCase(), cf]));

		// Run core matching (strategies 1 & 2)
		let { matchedTrashCF, confidence, matchDetails } = this.matchCFByIdAndName(
			instanceCF,
			trashByTrashId,
			trashByName,
		);

		// Strategy 3: Spec-based matching (expensive O(n), only if no match yet)
		if (!matchedTrashCF) {
			for (const trashCF of trashCFs) {
				const specComparison = compareSpecArrays(instanceCF.specifications, trashCF.specifications);
				if (specComparison.match) {
					matchedTrashCF = trashCF;
					matchDetails = { ...matchDetails, specsMatch: true };
					confidence = "specs_similar";
					break;
				}
			}
		}

		// Calculate recommended score
		const { recommendedScore, usedScoreSet } = this.calculateRecommendedScore(
			matchedTrashCF,
			scoreSet,
		);

		return {
			instanceCF,
			trashCF: matchedTrashCF,
			confidence,
			matchDetails,
			recommendedScore,
			scoreSet: usedScoreSet,
		};
	}

	/**
	 * Match multiple instance CFs against TRaSH cache
	 * Optimized to pre-load cache and build lookup maps once
	 */
	async matchMultipleCFs(
		instanceCFs: InstanceCustomFormat[],
		serviceType: "RADARR" | "SONARR",
		scoreSet?: string,
	): Promise<CFMatchSummary> {
		// Pre-load TRaSH CFs once for all matching
		const trashCFs = await this.loadTrashCFs(serviceType);

		// Build lookup maps once
		const trashByTrashId = new Map(trashCFs.map((cf) => [cf.trash_id, cf]));
		const trashByName = new Map(trashCFs.map((cf) => [cf.name.toLowerCase(), cf]));

		const results: CFMatchResult[] = [];

		for (const instanceCF of instanceCFs) {
			const result = this.matchSingleCFWithMaps(
				instanceCF,
				trashByTrashId,
				trashByName,
				scoreSet,
			);
			results.push(result);
		}

		return {
			total: results.length,
			exactMatches: results.filter((r) => r.confidence === "exact").length,
			nameMatches: results.filter((r) => r.confidence === "name_only").length,
			specsSimilar: results.filter((r) => r.confidence === "specs_similar").length,
			noMatch: results.filter((r) => r.confidence === "no_match").length,
			results,
		};
	}

	/**
	 * Internal method that uses pre-built lookup maps for faster batch matching
	 * Skips Strategy 3 (spec-based matching) for performance - O(n) causes slowdowns with many CFs
	 */
	private matchSingleCFWithMaps(
		instanceCF: InstanceCustomFormat,
		trashByTrashId: Map<string, TrashCustomFormat>,
		trashByName: Map<string, TrashCustomFormat>,
		scoreSet?: string,
	): CFMatchResult {
		// Run core matching (strategies 1 & 2 only - skip Strategy 3 for performance)
		const { matchedTrashCF, confidence, matchDetails } = this.matchCFByIdAndName(
			instanceCF,
			trashByTrashId,
			trashByName,
		);

		// Calculate recommended score
		const { recommendedScore, usedScoreSet } = this.calculateRecommendedScore(
			matchedTrashCF,
			scoreSet,
		);

		return {
			instanceCF,
			trashCF: matchedTrashCF,
			confidence,
			matchDetails,
			recommendedScore,
			scoreSet: usedScoreSet,
		};
	}

	/**
	 * Extract trash_id from instance CF
	 */
	private extractTrashId(cf: InstanceCustomFormat): string | null {
		// Strategy 1: Direct property
		if (cf.trash_id && cf.trash_id.length > 0) {
			return cf.trash_id;
		}

		// Strategy 2: Check specifications for trash_id in fields
		for (const spec of cf.specifications || []) {
			if (spec.fields) {
				// Handle array format (Instance API)
				if (Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find((f) => f.name === "trash_id");
					if (trashIdField && typeof trashIdField.value === "string") {
						return trashIdField.value;
					}
				}
				// Handle object format
				else if (typeof spec.fields === "object") {
					const fields = spec.fields as Record<string, unknown>;
					const trashIdValue = fields.trash_id || fields.trashId;
					if (typeof trashIdValue === "string" && trashIdValue.length > 0) {
						return trashIdValue;
					}
				}
			}
		}

		// Strategy 3: Check for TRaSH ID pattern in CF name
		const trashIdMatch = cf.name.match(/\[([a-f0-9-]{36})\]$/i);
		if (trashIdMatch?.[1]) {
			return trashIdMatch[1];
		}

		return null;
	}

	/**
	 * Clear the internal cache (useful for testing or cache refresh)
	 */
	clearCache(): void {
		this.trashCFCache.clear();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCFMatcher(prisma: PrismaClient): CFMatcher {
	return new CFMatcher(prisma);
}
