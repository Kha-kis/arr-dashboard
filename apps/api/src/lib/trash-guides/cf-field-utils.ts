/**
 * Custom Format field transformation utilities.
 *
 * Pure functions for converting between TRaSH Guides field formats
 * and the Sonarr/Radarr API format.
 */

import type { SonarrClient } from "arr-sdk";

// SDK CustomFormat type for internal use
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

/**
 * Transform fields from TRaSH Guides object format to Radarr API array format.
 * TRaSH format: { value: 5 }
 * Radarr format: [{ name: "value", value: 5 }]
 */
// biome-ignore lint/suspicious/noExplicitAny: Dynamic TRaSH Guides field format
export function transformFieldsToArray(fields: any): Array<{ name: string; value: unknown }> {
	if (Array.isArray(fields)) {
		return fields;
	}
	if (!fields) {
		return [];
	}
	return Object.entries(fields).map(([name, value]) => ({
		name,
		value,
	}));
}

/**
 * Extract trash_id from Custom Format specifications.
 * Returns null if no trash_id is found, allowing callers to distinguish
 * between ID-based matching and name-based matching.
 */
export function extractTrashId(cf: SdkCustomFormat): string | null {
	for (const spec of cf.specifications || []) {
		if (spec.fields) {
			if (Array.isArray(spec.fields)) {
				const trashIdField = spec.fields.find((f) => f.name === "trash_id");
				if (trashIdField) {
					return String(trashIdField.value);
				}
			} else if (typeof spec.fields === "object") {
				if ("trash_id" in spec.fields) {
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic specification field shape
					return String((spec.fields as any).trash_id);
				}
			}
		}
	}
	return null;
}
