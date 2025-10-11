import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import { normalizeImages } from "./image-normalizer.js";
import { extractYear } from "./movie-normalizer.js";
import {
	normalizeGenres,
	normalizeTags,
	toBoolean,
	toNumber,
	toStringValue,
} from "./type-converters.js";

/**
 * Normalizes an array of season objects from raw API data
 * @param value - The raw seasons array (unknown type allows flexible property access, safety enforced via helper functions)
 * @returns Array of normalized season objects or undefined
 */
export const normalizeSeasons = (value: unknown) => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const seasons = value
		.map((entry: unknown) => {
			const seasonEntry = entry as Record<string, unknown>;
			const seasonNumber = toNumber(seasonEntry?.seasonNumber);
			if (seasonNumber === undefined) {
				return null;
			}
			const title = toStringValue(seasonEntry?.title);
			const monitored = toBoolean(seasonEntry?.monitored);
			const stats = (seasonEntry?.statistics ?? {}) as Record<string, unknown>;
			const episodeCount =
				toNumber(stats?.totalEpisodeCount) ??
				toNumber(stats?.episodeCount) ??
				toNumber(seasonEntry?.episodeCount);
			const episodeFileCount =
				toNumber(stats?.episodeFileCount) ?? toNumber(seasonEntry?.episodeFileCount);
			const missingEpisodeCountRaw =
				episodeCount !== undefined && episodeFileCount !== undefined
					? Math.max(episodeCount - episodeFileCount, 0)
					: undefined;
			const missingEpisodeCount = monitored === false ? 0 : missingEpisodeCountRaw;

			return {
				seasonNumber,
				title,
				monitored,
				episodeCount,
				episodeFileCount,
				missingEpisodeCount,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	return seasons.length > 0 ? seasons : undefined;
};

/**
 * Builds a series library item from raw Sonarr API data
 * @param instance - The service instance
 * @param service - The service type (sonarr)
 * @param raw - The raw API data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @returns A normalized series library item
 */
export const buildSeriesItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: Record<string, unknown>,
): LibraryItem => {
	const images = normalizeImages(raw?.images, instance.baseUrl);
	const stats = (raw?.statistics ?? {}) as Record<string, unknown>;
	const episodeFileCount = toNumber(stats?.episodeFileCount ?? raw?.episodeFileCount) ?? 0;

	return {
		id: toNumber(raw?.id) ?? toStringValue(raw?.id) ?? Math.random().toString(36),
		instanceId: instance.id,
		instanceName: instance.label,
		service,
		type: "series",
		title: toStringValue(raw?.title) ?? "Untitled",
		titleSlug: toStringValue(raw?.titleSlug),
		sortTitle: toStringValue(raw?.sortTitle),
		year: extractYear(raw),
		overview: toStringValue(raw?.overview),
		runtime: toNumber(raw?.runtime ?? raw?.runtimeMinutes),
		added: toStringValue(raw?.added),
		updated: toStringValue(raw?.lastInfoSync ?? raw?.lastModified),
		genres: normalizeGenres(raw?.genres),
		tags: normalizeTags(raw?.tags),
		poster: images.poster,
		fanart: images.fanart,
		monitored: toBoolean(raw?.monitored),
		hasFile: episodeFileCount > 0,
		qualityProfileId: toNumber(raw?.qualityProfileId),
		qualityProfileName: toStringValue((raw?.qualityProfile as Record<string, unknown> | undefined)?.name),
		languageProfileId: toNumber(raw?.languageProfileId),
		languageProfileName: toStringValue((raw?.languageProfile as Record<string, unknown> | undefined)?.name),
		rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
		sizeOnDisk: toNumber(stats?.sizeOnDisk),
		path: toStringValue(raw?.path),
		status: toStringValue(raw?.status),
		remoteIds: {
			tmdbId: toNumber(raw?.tmdbId),
			imdbId: toStringValue(raw?.imdbId),
			tvdbId: toNumber(raw?.tvdbId),
		},
		seasons: normalizeSeasons(raw?.seasons),
		statistics: {
			seasonCount: toNumber(stats?.seasonCount),
			episodeCount: toNumber(stats?.episodeCount),
			episodeFileCount,
			totalEpisodeCount: toNumber(stats?.totalEpisodeCount),
			monitoredSeasons: Array.isArray(raw?.seasons)
				? raw.seasons.filter((season: unknown) => toBoolean((season as Record<string, unknown>)?.monitored)).length
				: undefined,
			runtime: toNumber(raw?.runtime),
		},
	} as LibraryItem;
};
