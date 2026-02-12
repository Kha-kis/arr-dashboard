import { toStringValue } from "./type-converters.js";

/**
 * Resolves an image URL, handling both absolute URLs and relative paths
 * @param value - The image URL or path
 * @param baseUrl - Optional base URL to prepend to relative paths
 * @returns The resolved image URL or undefined
 */
export const resolveImageUrl = (value: unknown, baseUrl?: string): string | undefined => {
	const raw = toStringValue(value);
	if (!raw) {
		return undefined;
	}
	if (/^https:\/\//i.test(raw)) {
		return raw;
	}
	// Upgrade HTTP remote URLs to HTTPS (required by CSP img-src policy)
	if (/^http:\/\//i.test(raw)) {
		return raw.replace(/^http:/i, "https:");
	}
	if (!baseUrl) {
		return raw;
	}
	const normalizedBase = baseUrl.replace(/\/$/, "");
	const trimmed = raw.replace(/^\/+/, "");
	return `${normalizedBase}/${trimmed}`;
};

/**
 * Normalizes an array of image objects into poster and fanart URLs
 * @param images - The raw images array from the API
 * @param baseUrl - Optional base URL for resolving relative paths
 * @returns Object containing poster and fanart URLs
 */
export const normalizeImages = (
	images: unknown,
	baseUrl?: string,
): { poster?: string; fanart?: string } => {
	if (!Array.isArray(images)) {
		return {};
	}
	const result: { poster?: string; fanart?: string } = {};
	for (const raw of images as Array<{
		coverType?: string;
		url?: string;
		remoteUrl?: string;
	}>) {
		const type = toStringValue(raw?.coverType)?.toLowerCase();
		if (!type) {
			continue;
		}
		if (type === "poster" && !result.poster) {
			result.poster = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
		}
		if ((type === "fanart" || type === "background") && !result.fanart) {
			result.fanart = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
		}
	}
	return result;
};
