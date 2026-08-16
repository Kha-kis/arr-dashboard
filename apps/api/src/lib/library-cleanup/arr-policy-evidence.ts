export interface ArrPolicyEvidence {
	monitored: boolean;
	hasFile: boolean;
	episodeFileCount: boolean;
	sizeOnDisk: boolean;
	tags: boolean;
	rating: boolean;
	imdbRating: boolean;
	hdrType: boolean;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteRatingValue(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10;
}

function hasCompleteTags(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(tag) =>
				(typeof tag === "number" && Number.isSafeInteger(tag) && tag >= 0) ||
				(typeof tag === "string" && tag.trim().length > 0),
		)
	);
}

function hasCompleteSourceRating(ratings: Record<string, unknown>, source: string): boolean {
	if (!Object.hasOwn(ratings, source)) return false;
	const child = ratings[source];
	return isRecord(child) && isCompleteRatingValue(child.value);
}

function hasCompleteFlatRating(ratings: Record<string, unknown>): boolean {
	if (!Object.hasOwn(ratings, "value")) return false;
	return isCompleteRatingValue(ratings.value);
}

function hasExplicitDynamicRange(raw: Record<string, unknown>): boolean {
	const file = isRecord(raw.movieFile)
		? raw.movieFile
		: isRecord(raw.episodeFile)
			? raw.episodeFile
			: undefined;
	const mediaInfo = file && isRecord(file.mediaInfo) ? file.mediaInfo : undefined;
	return (
		mediaInfo !== undefined &&
		Object.hasOwn(mediaInfo, "videoDynamicRange") &&
		(typeof mediaInfo.videoDynamicRange === "string" || mediaInfo.videoDynamicRange === null)
	);
}

/**
 * Capture which cleanup-policy fields existed in the raw ARR response before
 * normalizers apply defaults such as `hasFile: false` or an episode count of
 * zero. Mutation-time evaluation must never treat those defaults as proof.
 */
export function deriveArrPolicyEvidence(
	service: "sonarr" | "radarr",
	raw: Record<string, unknown>,
): ArrPolicyEvidence {
	const statistics = isRecord(raw.statistics) ? raw.statistics : undefined;
	const monitored = typeof raw.monitored === "boolean";

	if (service === "sonarr") {
		const episodeFileCount =
			isNonNegativeSafeInteger(statistics?.episodeFileCount) ||
			isNonNegativeSafeInteger(raw.episodeFileCount);
		const ratings = isRecord(raw.ratings) ? raw.ratings : undefined;
		return {
			monitored,
			hasFile: episodeFileCount,
			episodeFileCount,
			sizeOnDisk: isNonNegativeSafeInteger(statistics?.sizeOnDisk),
			tags: hasCompleteTags(raw.tags),
			rating: ratings !== undefined && hasCompleteFlatRating(ratings),
			imdbRating: false,
			hdrType: hasExplicitDynamicRange(raw),
		};
	}

	const ratings = isRecord(raw.ratings) ? raw.ratings : undefined;
	return {
		monitored,
		hasFile: typeof raw.hasFile === "boolean",
		episodeFileCount: false,
		sizeOnDisk: isNonNegativeSafeInteger(raw.sizeOnDisk),
		tags: hasCompleteTags(raw.tags),
		rating: ratings !== undefined && hasCompleteSourceRating(ratings, "tmdb"),
		imdbRating: ratings !== undefined && hasCompleteSourceRating(ratings, "imdb"),
		hdrType: hasExplicitDynamicRange(raw),
	};
}
