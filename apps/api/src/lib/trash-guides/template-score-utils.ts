/**
 * Score resolution utilities for TRaSH Guides template operations.
 *
 * Consolidates the duplicated score lookup logic used by the merger, differ,
 * CF-group-addition detector, and deployment executor into a single source of truth.
 */

import type { TemplateCustomFormat, TrashCustomFormat } from "@arr/shared";
import { loggers } from "../logger.js";

const log = loggers.deployment;

/** TRaSH CF with the optional `trash_scores` map present in real API data. */
export type TrashCFWithScores = TrashCustomFormat & {
	trash_scores?: Record<string, number>;
};

/**
 * Get the recommended score for a CF based on the active score set.
 *
 * Resolution order:
 * 1. `trash_scores[scoreSet]` — profile-specific score
 * 2. `trash_scores.default`  — TRaSH default score
 * 3. `cf.score`              — legacy fallback
 * 4. `0`                     — final fallback
 */
export function getRecommendedScore(cf: TrashCFWithScores, scoreSet: string): number {
	if (cf.trash_scores) {
		if (cf.trash_scores[scoreSet] !== undefined) {
			return cf.trash_scores[scoreSet];
		}
		if (cf.trash_scores.default !== undefined) {
			return cf.trash_scores.default;
		}
	}
	return cf.score ?? 0;
}

/**
 * Get the current effective score from a template CF, mirroring deployment
 * score resolution order.
 *
 * Priority:
 * 1. `scoreOverride`                        — explicit user override
 * 2. `originalConfig.trash_scores[scoreSet]` — TRaSH authoritative score
 * 3. `originalConfig.trash_scores.default`   — TRaSH default
 * 4. `cf.score`                              — legacy template field
 * 5. `originalConfig.score`                  — legacy original field
 * 6. `0`                                     — final fallback
 */
export function getCurrentScore(cf: TemplateCustomFormat, scoreSet: string): number {
	if (cf.scoreOverride !== undefined) {
		return cf.scoreOverride;
	}

	const cfWithScores = cf.originalConfig as TrashCFWithScores | undefined;
	if (cfWithScores?.trash_scores) {
		if (scoreSet !== "" && cfWithScores.trash_scores[scoreSet] !== undefined) {
			return cfWithScores.trash_scores[scoreSet];
		}
		if (cfWithScores.trash_scores.default !== undefined) {
			return cfWithScores.trash_scores.default;
		}
	}

	if (cf.score !== undefined) {
		return cf.score;
	}

	if (cf.originalConfig?.score !== undefined) {
		return cf.originalConfig.score;
	}

	return 0;
}

// ============================================================================
// Deployment Score Calculation
// ============================================================================

export interface ScoreCalculationResult {
	score: number;
	scoreSource: string;
}

export interface TemplateCFForScoring {
	scoreOverride?: number | null;
	originalConfig?: {
		trash_scores?: Record<string, number>;
	};
}

/**
 * Calculates the resolved score for a Custom Format using priority rules:
 * 1. Instance-level override (manual changes in instance)
 * 2. Template-level override (user's wizard selection)
 * 3. TRaSH Guides score from profile's score set
 * 4. TRaSH Guides default score
 * 5. Fallback to 0
 */
export function calculateScoreAndSource(
	templateCF: TemplateCFForScoring,
	scoreSet: string | undefined | null,
	instanceOverrideScore?: number,
): ScoreCalculationResult {
	if (instanceOverrideScore !== undefined) {
		return { score: instanceOverrideScore, scoreSource: "instance override" };
	}

	if (templateCF.scoreOverride !== undefined && templateCF.scoreOverride !== null) {
		return { score: templateCF.scoreOverride, scoreSource: "template override" };
	}

	if (scoreSet != null && scoreSet !== "" && templateCF.originalConfig?.trash_scores?.[scoreSet] !== undefined) {
		const score = templateCF.originalConfig.trash_scores[scoreSet];
		if (typeof score === "number" && Number.isFinite(score)) {
			return { score, scoreSource: `TRaSH score set (${scoreSet})` };
		}
		log.warn(
			{ scoreSet, scoreType: typeof score, scoreValue: String(score) },
			"Non-numeric score for scoreSet, falling through to next priority",
		);
	}

	if (templateCF.originalConfig?.trash_scores?.default !== undefined) {
		const score = templateCF.originalConfig.trash_scores.default;
		if (typeof score === "number" && Number.isFinite(score)) {
			return { score, scoreSource: "TRaSH default" };
		}
		log.warn(
			{ scoreType: typeof score, scoreValue: String(score) },
			"Non-numeric default score, falling back to 0",
		);
	}

	return { score: 0, scoreSource: "default" };
}
