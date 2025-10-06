import type { CalendarItem } from "@arr/shared";
import { toBoolean, toNumber, toStringArray, toStringValue } from "../data/values";

/**
 * Returns the API path for calendar endpoints
 */
export const calendarApiPath = (service: "sonarr" | "radarr") => "/api/v3/calendar";

/**
 * Formats a date to YYYY-MM-DD format
 */
export const formatDateOnly = (date: Date): string =>
	date.toISOString().split("T")[0] ?? date.toISOString();

/**
 * Selects the appropriate date fields for a calendar item based on service type
 */
const selectCalendarDates = (item: unknown, service: "sonarr" | "radarr") => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anyItem = item as any;
	if (service === "sonarr") {
		return {
			local: toStringValue(anyItem.airDate),
			utc: toStringValue(anyItem.airDateUtc),
		};
	}
	const primary =
		toStringValue(anyItem.inCinemas) ??
		toStringValue(anyItem.digitalRelease) ??
		toStringValue(anyItem.physicalRelease) ??
		toStringValue(anyItem.releaseDate);
	return {
		local: primary,
		utc: primary,
	};
};

/**
 * Normalizes a raw calendar item from the ARR API into a consistent format
 */
export const normalizeCalendarItem = (item: unknown, service: "sonarr" | "radarr"): CalendarItem => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anyItem = item as any;
	const rawId =
		anyItem.id ??
		anyItem.eventId ??
		anyItem.episodeId ??
		anyItem.movieId ??
		anyItem.sourceId ??
		Math.random().toString(36);
	const normalizedId =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const { local: airDate, utc: airDateUtc } = selectCalendarDates(item, service);

	const seriesTitle =
		service === "sonarr"
			? (toStringValue(anyItem.series?.title) ??
				toStringValue(anyItem.seriesTitle) ??
				toStringValue(anyItem.title))
			: undefined;
	const episodeTitle =
		service === "sonarr"
			? (toStringValue(anyItem.title) ??
				(typeof anyItem.episodeNumber !== "undefined" ? `Episode ${anyItem.episodeNumber}` : undefined))
			: undefined;
	const movieTitle =
		service === "radarr"
			? (toStringValue(anyItem.title) ?? toStringValue(anyItem.originalTitle))
			: undefined;

	const seriesId = service === "sonarr" ? toNumber(anyItem.seriesId ?? anyItem.series?.id) : undefined;
	const seriesSlug =
		service === "sonarr"
			? toStringValue(anyItem.series?.titleSlug ?? anyItem.titleSlug ?? anyItem.series?.path)
			: undefined;
	const episodeId = service === "sonarr" ? toNumber(anyItem.episodeId ?? anyItem.id) : undefined;
	const movieId = service === "radarr" ? toNumber(anyItem.movieId ?? anyItem.id) : undefined;
	const movieSlug =
		service === "radarr"
			? toStringValue(anyItem.movie?.titleSlug ?? anyItem.titleSlug ?? anyItem.movie?.path)
			: undefined;
	const tmdbId = toNumber(anyItem.tmdbId ?? anyItem.tmdbid ?? anyItem.movie?.tmdbId ?? anyItem.series?.tmdbId);
	const imdbId = toStringValue(
		anyItem.imdbId ?? anyItem.imdbid ?? anyItem.movie?.imdbId ?? anyItem.series?.imdbId,
	);
	const seriesStatus = service === "sonarr" ? toStringValue(anyItem.series?.status) : undefined;
	const status = toStringValue(anyItem.status ?? anyItem.movie?.status ?? anyItem.series?.status);

	const title =
		toStringValue(anyItem.title) ?? episodeTitle ?? movieTitle ?? seriesTitle ?? "Untitled";

	return {
		id: normalizedId,
		title,
		service,
		type: service === "sonarr" ? "episode" : "movie",
		seriesTitle,
		episodeTitle,
		movieTitle,
		seriesId,
		seriesSlug,
		episodeId,
		movieId,
		movieSlug,
		tmdbId,
		imdbId,
		seriesStatus,
		status,
		seasonNumber: service === "sonarr" ? toNumber(anyItem.seasonNumber) : undefined,
		episodeNumber: service === "sonarr" ? toNumber(anyItem.episodeNumber) : undefined,
		airDate,
		airDateUtc,
		runtime: toNumber(anyItem.runtime ?? anyItem.series?.runtime),
		network: toStringValue(anyItem.series?.network ?? anyItem.network),
		studio: toStringValue(anyItem.studio),
		overview: toStringValue(anyItem.overview ?? anyItem.series?.overview),
		genres: toStringArray(anyItem.genres) ?? toStringArray(anyItem.series?.genres),
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
