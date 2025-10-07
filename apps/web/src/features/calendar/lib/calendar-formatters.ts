import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";

/**
 * Formats a date to YYYY-MM-DD format
 */
export const formatDateOnly = (date: Date): string => {
	const iso = date.toISOString();
	const index = iso.indexOf("T");
	return index === -1 ? iso : iso.slice(0, index);
};

/**
 * Creates a date at the start of the specified month in UTC
 */
export const createMonthDate = (year: number, month: number): Date =>
	new Date(Date.UTC(year, month, 1));

/**
 * Formats a date as "Month Year" (e.g., "January 2024")
 */
export const formatMonthLabel = (date: Date): string =>
	new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);

/**
 * Formats a time string to localized time format
 */
export const formatTime = (value?: string): string => {
	if (!value) {
		return "All day";
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(parsed);
};

/**
 * Formats a date as full date string (e.g., "Monday, January 1, 2024")
 */
export const formatLongDate = (value: Date): string =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(value);

/**
 * Formats a datetime string to medium date and short time
 */
export const formatAirDateTime = (value?: string): string | undefined => {
	if (!value) {
		return undefined;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(parsed);
};

/**
 * Formats season and episode numbers to S##E## format
 */
export const formatEpisodeCode = (
	seasonNumber?: number,
	episodeNumber?: number,
): string | undefined => {
	const seasonPart =
		typeof seasonNumber === "number" ? `S${seasonNumber.toString().padStart(2, "0")}` : "";
	const episodePart =
		typeof episodeNumber === "number" ? `E${episodeNumber.toString().padStart(2, "0")}` : "";
	const combined = `${seasonPart}${episodePart}`.trim();
	return combined.length > 0 ? combined : undefined;
};

/**
 * Converts monitoring status to human-readable label
 */
export const formatMonitoringLabel = (monitored?: boolean): string | undefined => {
	if (typeof monitored !== "boolean") {
		return undefined;
	}
	return monitored ? "Monitored" : "Not monitored";
};

/**
 * Converts file availability status to human-readable label
 */
export const formatLibraryLabel = (hasFile?: boolean): string | undefined => {
	if (typeof hasFile !== "boolean") {
		return undefined;
	}
	return hasFile ? "In library" : "Pending download";
};

/**
 * Joins genre array into comma-separated string (max 4 genres)
 */
export const joinGenres = (genres?: string[]): string | undefined => {
	if (!Array.isArray(genres)) {
		return undefined;
	}
	const normalized = genres
		.map((genre) => (typeof genre === "string" ? genre.trim() : ""))
		.filter((genre) => genre.length > 0);
	if (normalized.length === 0) {
		return undefined;
	}
	return normalized.slice(0, 4).join(", ");
};

/**
 * Converts snake_case or kebab-case to Title Case
 */
export const humanizeLabel = (value: string): string =>
	value
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());

/**
 * Removes trailing slashes from URL
 */
export const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Builds external link to Sonarr/Radarr for a calendar item
 */
export const buildExternalLink = (
	event: CalendarItem,
	instance?: ServiceInstanceSummary,
): string | null => {
	if (!instance || !instance.baseUrl) {
		return null;
	}

	const baseUrl = normalizeBaseUrl(instance.baseUrl);

	if (event.service === "sonarr" && (event.seriesSlug || event.seriesId)) {
		const seriesSegment = event.seriesSlug ?? String(event.seriesId);
		return `${baseUrl}/series/${seriesSegment}`;
	}

	if (event.service === "radarr" && (event.movieSlug || event.movieId)) {
		const movieSegment = event.movieSlug ?? String(event.movieId);
		return `${baseUrl}/movie/${movieSegment}`;
	}

	return null;
};

export interface EventDetailData {
	airDate?: string;
	episodeCode?: string;
	runtime?: number;
	network?: string;
	status?: string;
	monitoring?: string;
	library?: string;
	genres?: string;
	tmdbId?: number;
	tmdbLink?: string;
	imdbId?: string;
	imdbLink?: string;
	serviceType: "sonarr" | "radarr";
}

/**
 * Extracts all detail data for an event (without JSX)
 */
export const extractEventDetails = (event: CalendarItem): EventDetailData => {
	const airDate = formatAirDateTime(event.airDateUtc ?? event.airDate);
	const episodeCode =
		event.type === "episode"
			? formatEpisodeCode(event.seasonNumber, event.episodeNumber)
			: undefined;
	const networkLabel = event.network ?? event.studio;
	const statusSource = event.status ?? event.seriesStatus;
	const statusValue = statusSource ? humanizeLabel(statusSource) : undefined;
	const monitoringLabel = formatMonitoringLabel(event.monitored);
	const libraryLabel = formatLibraryLabel(event.hasFile);
	const genresLabel = joinGenres(event.genres);

	const tmdbLink =
		event.tmdbId != null
			? `https://www.themoviedb.org/${event.service === "radarr" ? "movie" : "tv"}/${event.tmdbId}`
			: undefined;

	const imdbLink = event.imdbId ? `https://www.imdb.com/title/${event.imdbId}` : undefined;

	return {
		airDate,
		episodeCode,
		runtime: event.runtime,
		network: networkLabel,
		status: statusValue,
		monitoring: monitoringLabel,
		library: libraryLabel,
		genres: genresLabel,
		tmdbId: event.tmdbId,
		tmdbLink,
		imdbId: event.imdbId,
		imdbLink,
		serviceType: event.service,
	};
};

/**
 * Formats event title based on type (episode vs movie)
 */
export const formatEventTitle = (event: CalendarItem): string => {
	if (event.type === "episode") {
		return `${event.seriesTitle ?? "Unknown Series"}${event.episodeTitle ? " - " + event.episodeTitle : ""}`;
	}
	return event.movieTitle ?? event.title ?? "Untitled";
};
