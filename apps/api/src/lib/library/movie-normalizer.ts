import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import { normalizeImages } from "./image-normalizer";
import {
	normalizeGenres,
	normalizeTags,
	toBoolean,
	toNumber,
	toStringValue,
} from "./type-converters";

/**
 * Extracts year from raw API data, checking multiple fields
 * @param raw - The raw API data (any type allows flexible property access, safety enforced via helper functions)
 * @returns The extracted year or undefined
 */
export const extractYear = (raw: any): number | undefined => {
	const year = toNumber(raw?.year ?? raw?.releaseYear);
	if (typeof year === "number") {
		return year;
	}
	const firstAired = toStringValue(raw?.firstAired);
	if (firstAired) {
		const match = firstAired.match(/^(\d{4})/);
		if (match) {
			const parsed = Number(match[1]);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
};

/**
 * Builds a movie file object from raw API data
 * @param raw - The raw movie file data (any type allows flexible property access, safety enforced via helper functions)
 * @returns Movie file object or undefined
 */
export const buildMovieFile = (raw: any) => {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const id = toNumber(raw?.id);
	const relativePath =
		toStringValue(raw?.relativePath) ??
		toStringValue(raw?.path) ??
		toStringValue(raw?.originalFilePath);
	const quality = toStringValue(raw?.quality?.quality?.name) ?? toStringValue(raw?.quality?.name);
	const size = toNumber(raw?.size) ?? toNumber(raw?.sizeOnDisk);
	let resolution =
		toStringValue(raw?.mediaInfo?.resolution) ?? toStringValue(raw?.mediaInfo?.screenSize);
	const width = toNumber(raw?.mediaInfo?.width);
	const height = toNumber(raw?.mediaInfo?.height);
	if (!resolution && width !== undefined && height !== undefined) {
		resolution = `${width}x${height}`;
	}
	if (!relativePath && !quality && !size && !resolution && id === undefined) {
		return undefined;
	}
	return {
		id,
		relativePath,
		quality,
		size,
		resolution,
	};
};

/**
 * Builds a movie library item from raw Radarr API data
 * @param instance - The service instance
 * @param service - The service type (radarr)
 * @param raw - The raw API data
 * @returns A normalized movie library item
 */
/**
 * Builds a movie library item from raw Radarr API data
 * @param raw - The raw API data (any type allows flexible property access, safety enforced via helper functions)
 */
export const buildMovieItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: any,
): LibraryItem => {
	const images = normalizeImages(raw?.images, instance.baseUrl);

	return {
		id: toNumber(raw?.id) ?? toStringValue(raw?.id) ?? Math.random().toString(36),
		instanceId: instance.id,
		instanceName: instance.label,
		service,
		type: "movie",
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
		hasFile: Boolean(raw?.hasFile || raw?.movieFileId),
		qualityProfileId: toNumber(raw?.qualityProfileId),
		qualityProfileName: toStringValue(raw?.qualityProfile?.name),
		rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
		sizeOnDisk: toNumber(raw?.sizeOnDisk),
		path: toStringValue(raw?.path),
		status: toStringValue(raw?.status),
		remoteIds: {
			tmdbId: toNumber(raw?.tmdbId),
			imdbId: toStringValue(raw?.imdbId),
		},
		movieFile: buildMovieFile(raw?.movieFile),
		statistics: {
			movieFileQuality: toStringValue(raw?.movieFile?.quality?.quality?.name),
			runtime: toNumber(raw?.runtime ?? raw?.movieFile?.mediaInfo?.runTime),
		},
	} as LibraryItem;
};
