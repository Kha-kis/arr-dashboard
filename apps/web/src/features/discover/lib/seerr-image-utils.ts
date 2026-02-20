import {
	SEERR_MEDIA_STATUS,
	SEERR_ANIME_KEYWORD_ID,
	TMDB_ANIMATION_GENRE_ID,
	type SeerrMediaStatus,
} from "@arr/shared";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

/** TMDB image base URL */
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

/** Common TMDB poster sizes */
export type PosterSize = "w92" | "w154" | "w185" | "w300" | "w342" | "w500" | "w780" | "original";

/** Common TMDB backdrop sizes */
export type BackdropSize = "w300" | "w780" | "w1280" | "original";

/** Common TMDB profile sizes */
export type ProfileSize = "w45" | "w185" | "h632" | "original";

/** Build a full TMDB image URL from a path fragment */
export function getSeerrImageUrl(
	path: string | undefined | null,
	size: PosterSize | BackdropSize | ProfileSize = "w300",
): string | null {
	if (!path || !path.startsWith("/")) return null;
	return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

/** Status display info for media status badges */
export interface MediaStatusInfo {
	label: string;
	bg: string;
	border: string;
	text: string;
}

/** Map a Seerr media status to display info */
export function getMediaStatusInfo(status: SeerrMediaStatus | undefined): MediaStatusInfo | null {
	switch (status) {
		case SEERR_MEDIA_STATUS.AVAILABLE:
			return {
				label: "Available",
				bg: SEMANTIC_COLORS.success.bg,
				border: SEMANTIC_COLORS.success.border,
				text: SEMANTIC_COLORS.success.text,
			};
		case SEERR_MEDIA_STATUS.PENDING:
			return {
				label: "Pending",
				bg: SEMANTIC_COLORS.warning.bg,
				border: SEMANTIC_COLORS.warning.border,
				text: SEMANTIC_COLORS.warning.text,
			};
		case SEERR_MEDIA_STATUS.PROCESSING:
			return {
				label: "Processing",
				bg: "rgba(234, 179, 8, 0.1)",
				border: "rgba(234, 179, 8, 0.3)",
				text: "#facc15",
			};
		case SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE:
			return {
				label: "Partial",
				bg: SEMANTIC_COLORS.info.bg,
				border: SEMANTIC_COLORS.info.border,
				text: SEMANTIC_COLORS.info.text,
			};
		default:
			return null;
	}
}

/** Check if keywords contain the anime keyword (definitive — for full detail responses) */
export function isAnimeFromKeywords(keywords: { id: number; name: string }[] | undefined): boolean {
	return keywords?.some((k) => k.id === SEERR_ANIME_KEYWORD_ID) ?? false;
}

/** Heuristic anime detection for discover results (Animation genre + Japanese language) */
export function isLikelyAnime(item: {
	genreIds?: number[];
	originalLanguage?: string;
	mediaType?: string;
}): boolean {
	if (item.mediaType === "movie") return false;
	return (
		item.originalLanguage === "ja" &&
		(item.genreIds?.includes(TMDB_ANIMATION_GENRE_ID) ?? false)
	);
}

/** Normalize the display title from Seerr result (handles movie vs TV naming) */
export function getDisplayTitle(item: {
	title?: string;
	name?: string;
	originalTitle?: string;
	originalName?: string;
}): string {
	return item.title || item.name || item.originalTitle || item.originalName || "Unknown Title";
}

/** Get the release year from a date string */
export function getReleaseYear(
	item: { releaseDate?: string; firstAirDate?: string },
): number | null {
	const date = item.releaseDate || item.firstAirDate;
	if (!date) return null;
	const year = new Date(date).getFullYear();
	return Number.isNaN(year) ? null : year;
}

/** YouTube video IDs are 11 alphanumeric chars (plus hyphens/underscores) */
const YOUTUBE_KEY_RE = /^[a-zA-Z0-9_-]{10,12}$/;

/** Validate a YouTube video key from external API data */
export function isValidYoutubeKey(key: string | undefined): key is string {
	return !!key && YOUTUBE_KEY_RE.test(key);
}
