export interface ArrPolicyEvidence {
	monitored: boolean;
	hasFile: boolean;
	sizeOnDisk: boolean;
	rating: boolean;
	imdbRating: boolean;
}

function safeNonnegativeNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completeRatingValue(container: Record<string, unknown>, key: string): boolean {
	if (!Object.hasOwn(container, key)) return true;
	const child = container[key];
	if (!isRecord(child)) return false;
	const value = child.value;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

function completeFlatRatingValue(ratings: Record<string, unknown>): boolean {
	if (!Object.hasOwn(ratings, "value")) return true;
	const value = ratings.value;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

/**
 * Marks only fields that the raw service response actually proved. Normalized
 * defaults remain useful for display, but cannot authorize cleanup policy.
 */
export function arrPolicyEvidenceFromRaw(
	raw: Record<string, unknown>,
	service: string,
): ArrPolicyEvidence {
	if (service.toLowerCase() === "sonarr") {
		const statistics =
			typeof raw.statistics === "object" && raw.statistics !== null
				? (raw.statistics as Record<string, unknown>)
				: null;
		const ratings = isRecord(raw.ratings) ? raw.ratings : null;
		return {
			monitored: typeof raw.monitored === "boolean",
			hasFile:
				safeNonnegativeNumber(statistics?.episodeFileCount) ||
				safeNonnegativeNumber(raw.episodeFileCount),
			sizeOnDisk: safeNonnegativeNumber(statistics?.sizeOnDisk),
			rating: ratings !== null && completeFlatRatingValue(ratings),
			imdbRating: false,
		};
	}
	if (service.toLowerCase() === "radarr") {
		const ratings = isRecord(raw.ratings) ? raw.ratings : null;
		return {
			monitored: typeof raw.monitored === "boolean",
			hasFile: typeof raw.hasFile === "boolean",
			sizeOnDisk: safeNonnegativeNumber(raw.sizeOnDisk),
			rating: ratings !== null && completeRatingValue(ratings, "tmdb"),
			imdbRating: ratings !== null && completeRatingValue(ratings, "imdb"),
		};
	}
	return {
		monitored: false,
		hasFile: false,
		sizeOnDisk: false,
		rating: false,
		imdbRating: false,
	};
}
