import type { CalendarItem } from "@arr/shared";
import { toBoolean, toNumber, toStringArray, toStringValue } from "../data/values.js";

/** Service types that support calendar functionality */
export type CalendarService = "sonarr" | "radarr" | "lidarr" | "readarr";

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

/**
 * Returns the API path for calendar endpoints
 * Note: Sonarr/Radarr use v3, Lidarr/Readarr use v1
 */
export const calendarApiPath = (service: CalendarService) => {
	return ["lidarr", "readarr"].includes(service) ? "/api/v1/calendar" : "/api/v3/calendar";
};

/**
 * Formats a date to YYYY-MM-DD format
 */
export const formatDateOnly = (date: Date): string =>
	date.toISOString().split("T")[0] ?? date.toISOString();

/**
 * Selects the appropriate date fields for a calendar item based on service type
 */
const selectCalendarDates = (item: unknown, service: CalendarService) => {
	const anyItem = item as UnknownRecord;

	// Sonarr uses airDate/airDateUtc for episode air dates
	if (service === "sonarr") {
		return {
			local: toStringValue(anyItem.airDate),
			utc: toStringValue(anyItem.airDateUtc),
		};
	}

	// Radarr uses multiple release date fields
	if (service === "radarr") {
		const primary =
			toStringValue(anyItem.inCinemas) ??
			toStringValue(anyItem.digitalRelease) ??
			toStringValue(anyItem.physicalRelease) ??
			toStringValue(anyItem.releaseDate);
		return {
			local: primary,
			utc: primary,
		};
	}

	// Lidarr uses releaseDate for album releases
	if (service === "lidarr") {
		const releaseDate = toStringValue(anyItem.releaseDate);
		return {
			local: releaseDate,
			utc: releaseDate,
		};
	}

	// Readarr uses releaseDate for book releases
	const releaseDate = toStringValue(anyItem.releaseDate);
	return {
		local: releaseDate,
		utc: releaseDate,
	};
};

/**
 * Maps service type to calendar item type
 */
const getCalendarItemType = (service: CalendarService): "episode" | "movie" | "album" | "book" => {
	switch (service) {
		case "sonarr":
			return "episode";
		case "radarr":
			return "movie";
		case "lidarr":
			return "album";
		case "readarr":
			return "book";
	}
};

/**
 * Extracts the display title from a calendar item based on the service type
 */
const extractCalendarTitle = (anyItem: UnknownRecord, service: CalendarService): string => {
	const genericTitle = toStringValue(anyItem.title);
	if (genericTitle) return genericTitle;

	switch (service) {
		case "sonarr":
			return toStringValue(anyItem.series?.title) ?? "Untitled";
		case "radarr":
			return toStringValue(anyItem.originalTitle) ?? "Untitled";
		case "lidarr":
			return toStringValue(anyItem.artist?.artistName) ?? "Untitled";
		case "readarr":
			return toStringValue(anyItem.author?.authorName) ?? "Untitled";
		default:
			return "Untitled";
	}
};

/**
 * Normalizes a raw calendar item from the ARR API into a consistent format
 * Supports Sonarr (episodes), Radarr (movies), Lidarr (albums), and Readarr (books)
 */
export const normalizeCalendarItem = (
	item: unknown,
	service: CalendarService,
): CalendarItem => {
	const anyItem = item as UnknownRecord;
	const rawId =
		anyItem.id ??
		anyItem.eventId ??
		anyItem.episodeId ??
		anyItem.movieId ??
		anyItem.albumId ??
		anyItem.bookId ??
		anyItem.sourceId ??
		Math.random().toString(36);
	const normalizedId =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const { local: airDate, utc: airDateUtc } = selectCalendarDates(item, service);

	// Sonarr-specific fields
	const seriesTitle =
		service === "sonarr"
			? (toStringValue(anyItem.series?.title) ??
				toStringValue(anyItem.seriesTitle) ??
				toStringValue(anyItem.title))
			: undefined;
	const episodeTitle =
		service === "sonarr"
			? (toStringValue(anyItem.title) ??
				(typeof anyItem.episodeNumber !== "undefined"
					? `Episode ${anyItem.episodeNumber}`
					: undefined))
			: undefined;
	const seriesId =
		service === "sonarr" ? toNumber(anyItem.seriesId ?? anyItem.series?.id) : undefined;
	const seriesSlug =
		service === "sonarr"
			? toStringValue(anyItem.series?.titleSlug ?? anyItem.titleSlug ?? anyItem.series?.path)
			: undefined;
	const episodeId = service === "sonarr" ? toNumber(anyItem.episodeId ?? anyItem.id) : undefined;
	const seriesStatus = service === "sonarr" ? toStringValue(anyItem.series?.status) : undefined;

	// Radarr-specific fields
	const movieTitle =
		service === "radarr"
			? (toStringValue(anyItem.title) ?? toStringValue(anyItem.originalTitle))
			: undefined;
	const movieId = service === "radarr" ? toNumber(anyItem.movieId ?? anyItem.id) : undefined;
	const movieSlug =
		service === "radarr"
			? toStringValue(anyItem.movie?.titleSlug ?? anyItem.titleSlug ?? anyItem.movie?.path)
			: undefined;

	// Lidarr-specific fields
	const artistName =
		service === "lidarr"
			? toStringValue(anyItem.artist?.artistName ?? anyItem.artistName)
			: undefined;
	const albumTitle =
		service === "lidarr" ? toStringValue(anyItem.title) : undefined;
	const artistId =
		service === "lidarr" ? toNumber(anyItem.artistId ?? anyItem.artist?.id) : undefined;
	const albumId = service === "lidarr" ? toNumber(anyItem.albumId ?? anyItem.id) : undefined;

	// Readarr-specific fields
	const authorName =
		service === "readarr"
			? toStringValue(anyItem.author?.authorName ?? anyItem.authorName)
			: undefined;
	const bookTitle =
		service === "readarr" ? toStringValue(anyItem.title) : undefined;
	const authorId =
		service === "readarr" ? toNumber(anyItem.authorId ?? anyItem.author?.id) : undefined;
	const bookId = service === "readarr" ? toNumber(anyItem.bookId ?? anyItem.id) : undefined;

	// Common external IDs
	const tmdbId = toNumber(
		anyItem.tmdbId ?? anyItem.tmdbid ?? anyItem.movie?.tmdbId ?? anyItem.series?.tmdbId,
	);
	const imdbId = toStringValue(
		anyItem.imdbId ?? anyItem.imdbid ?? anyItem.movie?.imdbId ?? anyItem.series?.imdbId,
	);
	// Lidarr uses MusicBrainz IDs
	const musicBrainzId = toStringValue(
		anyItem.foreignAlbumId ?? anyItem.artist?.foreignArtistId ?? anyItem.mbid,
	);
	// Readarr uses GoodReads IDs
	const goodreadsId = toStringValue(
		anyItem.foreignBookId ?? anyItem.author?.foreignAuthorId ?? anyItem.goodreadsId,
	);

	const status = toStringValue(
		anyItem.status ?? anyItem.movie?.status ?? anyItem.series?.status ?? anyItem.artist?.status ?? anyItem.author?.status,
	);

	const title = extractCalendarTitle(anyItem, service);

	return {
		id: normalizedId,
		title,
		service,
		type: getCalendarItemType(service),
		// Sonarr fields
		seriesTitle,
		episodeTitle,
		seriesId,
		seriesSlug,
		episodeId,
		seriesStatus,
		seasonNumber: service === "sonarr" ? toNumber(anyItem.seasonNumber) : undefined,
		episodeNumber: service === "sonarr" ? toNumber(anyItem.episodeNumber) : undefined,
		// Radarr fields
		movieTitle,
		movieId,
		movieSlug,
		// Lidarr fields
		artistName,
		albumTitle,
		artistId,
		albumId,
		// Readarr fields
		authorName,
		bookTitle,
		authorId,
		bookId,
		// Common fields
		tmdbId,
		imdbId,
		musicBrainzId,
		goodreadsId,
		status,
		airDate,
		airDateUtc,
		runtime: toNumber(anyItem.runtime ?? anyItem.series?.runtime),
		network: toStringValue(anyItem.series?.network ?? anyItem.network),
		studio: toStringValue(anyItem.studio ?? anyItem.artist?.disambiguation),
		overview: toStringValue(anyItem.overview ?? anyItem.series?.overview ?? anyItem.artist?.overview ?? anyItem.author?.overview),
		genres: toStringArray(anyItem.genres) ?? toStringArray(anyItem.series?.genres) ?? toStringArray(anyItem.artist?.genres) ?? toStringArray(anyItem.author?.genres),
		monitored: toBoolean(anyItem.monitored),
		hasFile: toBoolean(anyItem.hasFile),
		instanceId: "",
		instanceName: "",
	};
};

/**
 * Compares two calendar items for sorting by air date, then by title
 */
export const compareCalendarItems = (a: CalendarItem, b: CalendarItem): number => {
	const timeA = new Date(a.airDateUtc ?? a.airDate ?? 0).getTime();
	const timeB = new Date(b.airDateUtc ?? b.airDate ?? 0).getTime();
	if (timeA !== timeB) {
		return timeA - timeB;
	}
	const titleA = toStringValue(a.title) ?? "";
	const titleB = toStringValue(b.title) ?? "";
	return titleA.localeCompare(titleB);
};
