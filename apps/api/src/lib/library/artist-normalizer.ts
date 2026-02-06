import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "../../lib/prisma.js";
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
 * Builds an artist library item from raw Lidarr API data
 * @param instance - The service instance
 * @param service - The service type (lidarr)
 * @param raw - The raw API data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @returns A normalized artist library item
 */
export const buildArtistItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: Record<string, unknown>,
): LibraryItem => {
	const images = normalizeImages(raw?.images, instance.baseUrl);
	const stats = (raw?.statistics ?? {}) as Record<string, unknown>;
	const trackFileCount = toNumber(stats?.trackFileCount ?? raw?.trackFileCount) ?? 0;

	// Lidarr uses artistName instead of title
	const artistName = toStringValue(raw?.artistName) ?? toStringValue(raw?.name) ?? "Untitled";

	return {
		id: toNumber(raw?.id) ?? toStringValue(raw?.id) ?? Math.random().toString(36),
		instanceId: instance.id,
		instanceName: instance.label,
		service,
		type: "artist",
		title: artistName,
		titleSlug: toStringValue(raw?.titleSlug ?? raw?.cleanName),
		sortTitle: toStringValue(raw?.sortName ?? raw?.sortTitle),
		year: extractYear(raw),
		overview: toStringValue(raw?.overview ?? raw?.biography),
		runtime: undefined, // Artists don't have runtime
		added: toStringValue(raw?.added),
		updated: toStringValue(raw?.lastInfoSync ?? raw?.lastModified),
		genres: normalizeGenres(raw?.genres),
		tags: normalizeTags(raw?.tags),
		poster: images.poster,
		fanart: images.fanart,
		monitored: toBoolean(raw?.monitored),
		hasFile: trackFileCount > 0,
		qualityProfileId: toNumber(raw?.qualityProfileId),
		qualityProfileName: toStringValue(
			(raw?.qualityProfile as Record<string, unknown> | undefined)?.name,
		),
		// Lidarr uses metadataProfileId instead of languageProfileId
		languageProfileId: toNumber(raw?.metadataProfileId),
		languageProfileName: toStringValue(
			(raw?.metadataProfile as Record<string, unknown> | undefined)?.name,
		),
		rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
		sizeOnDisk: toNumber(stats?.sizeOnDisk),
		path: toStringValue(raw?.path),
		status: toStringValue(raw?.status),
		remoteIds: {
			// Lidarr uses MusicBrainz IDs
			musicBrainzId: toStringValue(raw?.foreignArtistId ?? raw?.mbId),
		},
		statistics: {
			albumCount: toNumber(stats?.albumCount ?? raw?.albumCount),
			trackCount: toNumber(stats?.trackCount),
			trackFileCount,
			totalTrackCount: toNumber(stats?.totalTrackCount),
			missingTrackCount: Math.max((toNumber(stats?.totalTrackCount) ?? 0) - trackFileCount, 0),
		},
	} as LibraryItem;
};
