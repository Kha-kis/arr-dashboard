/**
 * Type conversion utilities for transforming raw API data into typed values
 */

/**
 * Converts unknown value to a finite number
 * @param value - The value to convert
 * @returns A finite number or undefined
 */
export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

/**
 * Converts unknown value to a boolean
 * @param value - The value to convert
 * @returns A boolean or undefined
 */
export const toBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 0) {
			return false;
		}
		if (value === 1) {
			return true;
		}
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes"].includes(normalized)) {
			return true;
		}
		if (["false", "0", "no"].includes(normalized)) {
			return false;
		}
	}
	return undefined;
};

/**
 * Converts unknown value to a non-empty string
 * @param value - The value to convert
 * @returns A non-empty string or undefined
 */
export const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}
	return undefined;
};

/**
 * Converts unknown value to an array of genre strings
 * @param value - The value to convert
 * @returns An array of genre strings or undefined
 */
export const normalizeGenres = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const genres = value
		.map((entry) => toStringValue(entry))
		.filter((entry): entry is string => Boolean(entry));
	return genres.length > 0 ? genres : undefined;
};

/**
 * Converts unknown value to an array of tag strings
 * @param value - The value to convert
 * @returns An array of tag strings or undefined
 */
export const normalizeTags = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tags = value
		.map((entry) => toStringValue(entry))
		.filter((entry): entry is string => Boolean(entry));
	return tags.length > 0 ? tags : undefined;
};
