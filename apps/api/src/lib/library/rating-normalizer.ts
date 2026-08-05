import type { LibraryRatings, LibraryService } from "@arr/shared";
import { toNumber, toStringValue } from "./type-converters.js";

const RADARR_RATING_SOURCES = ["imdb", "tmdb", "metacritic", "rottenTomatoes", "trakt"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeRatingChild(value: unknown) {
	const child = asRecord(value);
	if (!child) return undefined;

	const rating = toNumber(child.value);
	if (rating === undefined) return undefined;

	return {
		value: rating,
		votes: toNumber(child.votes),
		type: toStringValue(child.type),
	};
}

/**
 * Preserve the rating provenance exposed by each supported *arr service.
 *
 * Radarr has explicit per-source children, including IMDb. Sonarr exposes one
 * source-less SkyHook score; it remains useful to the general rating rule but
 * must not be promoted to IMDb.
 */
export function normalizeRatings(
	value: unknown,
	service: LibraryService,
): LibraryRatings | undefined {
	const ratings = asRecord(value);
	if (!ratings) return undefined;

	if (service === "radarr") {
		const normalized: LibraryRatings = {};
		for (const source of RADARR_RATING_SOURCES) {
			const child = normalizeRatingChild(ratings[source]);
			if (child) normalized[source] = child;
		}
		return Object.keys(normalized).length > 0 ? normalized : undefined;
	}

	if (service === "sonarr") {
		const rating = toNumber(ratings.value);
		if (rating === undefined) return undefined;
		return {
			value: rating,
			votes: toNumber(ratings.votes),
		};
	}

	return undefined;
}
