/**
 * Score resolution utilities for TRaSH Guides template operations.
 *
 * Consolidates the duplicated score lookup logic used by the merger, differ, and
 * CF-group-addition detector into a single source of truth.
 */

import type { TemplateCustomFormat, TrashCustomFormat } from "@arr/shared";

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
