/**
 * Quality profile shared helpers.
 *
 * Standalone functions used by the three profile creation strategies
 * (schema-based, cloned, custom) and the quality profile sync logic.
 */

import type { SonarrClient, RadarrClient } from "arr-sdk";
import { calculateScoreAndSource } from "./template-score-utils.js";
import { loggers } from "../logger.js";

const log = loggers.deployment;

// SDK CustomFormat type for internal use
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

export interface TemplateCF {
	trashId: string;
	name: string;
	scoreOverride: number;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR custom format config
	originalConfig: any;
}

/**
 * Feature flag for TRaSH Guides quality format change.
 *
 * TRaSH Guides PR #2590 changes the quality ordering in their JSON files:
 * - OLD format (current): Highest quality at index 0 (Remux → Unknown) - matches Sonarr/Radarr API
 * - NEW format (PR #2590): Lowest quality at index 0 (Unknown → Remux) - human-readable
 *
 * Sonarr/Radarr API expects highest quality first, so when PR #2590 is merged,
 * we need to reverse the quality items before sending to the API.
 *
 * HOW TO UPDATE WHEN PR #2590 IS MERGED:
 * 1. Change this flag to `true`
 * 2. Run tests to verify quality ordering is correct
 * 3. Test deployment with a profile to verify order matches expected
 *
 * See: https://github.com/TRaSH-Guides/Guides/pull/2590
 * See: https://github.com/Kha-kis/arr-dashboard/issues/85
 */
export const TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED = false;

/**
 * Reverses quality items if TRaSH Guides uses NEW format (PR #2590).
 * Sonarr/Radarr API expects highest quality first (index 0).
 */
export function reverseQualityItemsIfNeeded<T>(items: T[]): T[] {
	if (!items || items.length === 0) {
		return items;
	}

	if (TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED) {
		log.info("TRaSH Guides NEW format active, reversing quality items for API compatibility");
		return [...items].reverse();
	}

	return items;
}

/**
 * Normalize a quality name by removing whitespace and hyphens for consistent matching.
 * Used across all three createQualityProfile* methods.
 */
export function normalizeQualityName(name: string): string {
	return name.replace(/[\s-]/g, "").toLowerCase();
}

/**
 * Apply Custom Format scores from a template to a schema's formatItems.
 * Fetches the current CF list from the instance and maps template scores
 * using the priority chain in calculateScoreAndSource().
 */
export async function applyCustomFormatScores(
	client: SonarrClient | RadarrClient,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema formatItems
	schemaFormatItems: any[],
	templateCFs: TemplateCF[],
	scoreSet: string | undefined | null,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR formatItem structure
): Promise<{ allCFs: SdkCustomFormat[]; formatItemsWithScores: any[] }> {
	const allCFs = await client.customFormat.getAll();
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR formatItem structure
	const formatItemsWithScores = (schemaFormatItems || []).map((item: any) => {
		const cf = allCFs.find((c) => c.id === item.format);
		if (cf) {
			const templateCF = templateCFs.find((tcf) => tcf.name === cf.name);
			if (templateCF) {
				const { score } = calculateScoreAndSource(templateCF, scoreSet);
				return { ...item, score };
			}
		}
		return item;
	});
	return { allCFs, formatItemsWithScores };
}

/**
 * Submit a new quality profile to the ARR instance.
 * Strips the `id` field from the schema-based profile object before creating.
 */
export async function submitNewProfile(
	client: SonarrClient | RadarrClient,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile structure
	profileToCreate: Record<string, any>,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality profile response
): Promise<any> {
	const { id: _unusedId, ...profileWithoutId } = profileToCreate as {
		id?: number;
	} & typeof profileToCreate;
	// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types differ but are runtime-compatible
	return client.qualityProfile.create(profileWithoutId as any);
}

/**
 * Extract all individual qualities from a schema's items tree.
 * Returns maps for lookup by numeric ID and by normalized name.
 *
 * Handles two schema shapes:
 * - Items with a `quality` wrapper (standard individual quality items)
 * - Sub-items without a `quality` wrapper (e.g. group members with raw id/name/source/resolution)
 *   → These are normalized into the same `{ quality: {...}, items: [], allowed }` shape.
 */
export function extractQualitiesFromSchema(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema item structure
	schemaItems: any[],
): {
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	byId: Map<number, any>;
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	byName: Map<string, any>;
} {
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	const byId = new Map<number, any>();
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR quality item
	const byName = new Map<string, any>();

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic ARR schema item structure
	const walk = (items: any[]) => {
		for (const item of items) {
			if (item.quality) {
				byId.set(item.quality.id, item);
				byName.set(normalizeQualityName(item.quality.name), item);
			} else if (item.id !== undefined && item.name && !item.items) {
				const wrappedItem = {
					quality: {
						id: item.id,
						name: item.name,
						source: item.source,
						resolution: item.resolution,
					},
					items: [],
					allowed: item.allowed,
				};
				byId.set(item.id, wrappedItem);
				byName.set(normalizeQualityName(item.name), wrappedItem);
			}
			if (item.items && Array.isArray(item.items)) {
				walk(item.items);
			}
		}
	};
	walk(schemaItems || []);

	return { byId, byName };
}
