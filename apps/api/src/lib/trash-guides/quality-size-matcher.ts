/**
 * Quality Size Matcher
 *
 * Maps TRaSH quality size preset entries to instance quality definitions.
 * Matching strategy:
 * 1. Exact case-insensitive match on `title` (quality definition display name)
 * 2. Fallback: case-insensitive match on `quality.name` (internal quality name)
 */

import type { TrashQualitySizeQuality } from "@arr/shared";

// ============================================================================
// Types
// ============================================================================

/** Shape of a quality definition from the arr-sdk */
export interface InstanceQualityDefinition {
	id?: number;
	title?: string | null;
	minSize?: number | null;
	preferredSize?: number | null;
	maxSize?: number | null;
	weight?: number;
	quality?: {
		id?: number;
		name?: string | null;
	};
}

/** Comparison result for a single quality tier */
export interface QualitySizeComparison {
	qualityName: string;
	instanceDefinitionId: number | null;
	instanceTitle: string | null;
	current: { min: number; preferred: number; max: number } | null;
	trash: { min: number; preferred: number; max: number };
	matched: boolean;
	changed: boolean;
}

/** Full preview result returned from the matcher */
export interface QualitySizePreviewResult {
	comparisons: QualitySizeComparison[];
	matchedCount: number;
	changedCount: number;
	unmatchedCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Floating-point-safe comparison for quality size values (avoids false positives from IEEE 754 artifacts) */
function sizeEquals(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.001;
}

// ============================================================================
// Matcher
// ============================================================================

/**
 * Build a comparison between TRaSH quality size entries and instance quality definitions.
 */
export function buildQualitySizeComparison(
	trashQualities: TrashQualitySizeQuality[],
	instanceDefinitions: InstanceQualityDefinition[],
): QualitySizePreviewResult {
	// Build lookup maps keyed by normalized name
	const byTitle = new Map<string, InstanceQualityDefinition>();
	const byQualityName = new Map<string, InstanceQualityDefinition>();

	for (const def of instanceDefinitions) {
		if (def.title) {
			byTitle.set(def.title.trim().toLowerCase(), def);
		}
		if (def.quality?.name) {
			byQualityName.set(def.quality.name.trim().toLowerCase(), def);
		}
	}

	let matchedCount = 0;
	let changedCount = 0;
	let unmatchedCount = 0;

	const comparisons: QualitySizeComparison[] = trashQualities.map((tq) => {
		const normalizedName = tq.quality.trim().toLowerCase();

		// Try title first, then quality.name
		const instanceDef = byTitle.get(normalizedName) ?? byQualityName.get(normalizedName);

		if (!instanceDef || instanceDef.id == null) {
			unmatchedCount++;
			return {
				qualityName: tq.quality,
				instanceDefinitionId: null,
				instanceTitle: null,
				current: null,
				trash: { min: tq.min, preferred: tq.preferred, max: tq.max },
				matched: false,
				changed: false,
			};
		}

		matchedCount++;

		const current = {
			min: instanceDef.minSize ?? 0,
			preferred: instanceDef.preferredSize ?? 0,
			max: instanceDef.maxSize ?? 0,
		};

		const changed =
			!sizeEquals(current.min, tq.min) ||
			!sizeEquals(current.preferred, tq.preferred) ||
			!sizeEquals(current.max, tq.max);

		if (changed) changedCount++;

		return {
			qualityName: tq.quality,
			instanceDefinitionId: instanceDef.id,
			instanceTitle: instanceDef.title ?? null,
			current,
			trash: { min: tq.min, preferred: tq.preferred, max: tq.max },
			matched: true,
			changed,
		};
	});

	return { comparisons, matchedCount, changedCount, unmatchedCount };
}

/**
 * Apply TRaSH quality size values onto the full instance definitions array.
 * Returns the mutated array (Sonarr/Radarr requires the full array for updateAll).
 */
export function applyQualitySizeToDefinitions(
	trashQualities: TrashQualitySizeQuality[],
	instanceDefinitions: InstanceQualityDefinition[],
): { updated: InstanceQualityDefinition[]; appliedCount: number } {
	const preview = buildQualitySizeComparison(trashQualities, instanceDefinitions);
	const matchedById = new Map<number, QualitySizeComparison>();

	for (const c of preview.comparisons) {
		if (c.matched && c.instanceDefinitionId != null) {
			matchedById.set(c.instanceDefinitionId, c);
		}
	}

	let appliedCount = 0;
	const updated = instanceDefinitions.map((def) => {
		if (def.id == null) return def;
		const match = matchedById.get(def.id);
		if (!match) return def;

		appliedCount++;
		return {
			...def,
			minSize: match.trash.min,
			preferredSize: match.trash.preferred,
			maxSize: match.trash.max,
		};
	});

	return { updated, appliedCount };
}
