/**
 * TRaSH Guides Shared Utilities
 *
 * Common utility functions used across trash-guides modules.
 */

/**
 * Transform specification fields from object format to array format.
 * This matches the format expected by Radarr/Sonarr API.
 *
 * TRaSH format: { value: 5 }
 * Radarr format: [{ name: "value", value: 5 }]
 *
 * @param fields - Fields in object or array format
 * @returns Fields in array format
 */
export function transformFieldsToArray(
	fields: Record<string, unknown> | Array<{ name: string; value: unknown }> | null | undefined,
): Array<{ name: string; value: unknown }> {
	// If fields is already an array, return it as-is
	if (Array.isArray(fields)) {
		return fields;
	}

	// If fields is undefined or null, return empty array
	if (!fields) {
		return [];
	}

	// Convert object format to array format
	return Object.entries(fields).map(([name, value]) => ({
		name,
		value,
	}));
}
