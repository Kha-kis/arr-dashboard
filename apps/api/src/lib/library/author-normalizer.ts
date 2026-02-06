import type { LibraryItem, LibraryService } from "@arr/shared";
import type { ServiceInstance } from "../../lib/prisma.js";
import { normalizeImages } from "./image-normalizer.js";
import {
	normalizeGenres,
	normalizeTags,
	toBoolean,
	toNumber,
	toStringValue,
} from "./type-converters.js";

/**
 * Extracts year from raw Readarr author data
 * Readarr may store birth year or first publication year
 * @param raw - The raw API data
 * @returns The extracted year or undefined
 */
const extractAuthorYear = (raw: Record<string, unknown>): number | undefined => {
	// Try releaseYear first (most relevant for library display)
	const releaseYear = toNumber(raw?.releaseYear);
	if (typeof releaseYear === "number") {
		return releaseYear;
	}

	// Try to extract from earliest book release
	const nextBook = raw?.nextBook as Record<string, unknown> | undefined;
	const lastBook = raw?.lastBook as Record<string, unknown> | undefined;
	const bookYear = toNumber(nextBook?.releaseDate?.toString()?.slice(0, 4)) ??
		toNumber(lastBook?.releaseDate?.toString()?.slice(0, 4));

	if (typeof bookYear === "number") {
		return bookYear;
	}

	return undefined;
};

/**
 * Builds an author library item from raw Readarr API data
 * @param instance - The service instance
 * @param service - The service type (readarr)
 * @param raw - The raw API data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @returns A normalized author library item
 */
export const buildAuthorItem = (
	instance: ServiceInstance,
	service: LibraryService,
	raw: Record<string, unknown>,
): LibraryItem => {
	const images = normalizeImages(raw?.images, instance.baseUrl);
	const stats = (raw?.statistics ?? {}) as Record<string, unknown>;
	const bookFileCount = toNumber(stats?.bookFileCount ?? raw?.bookFileCount) ?? 0;

	// Readarr uses authorName instead of title
	const authorName = toStringValue(raw?.authorName) ?? toStringValue(raw?.name) ?? "Untitled";

	return {
		id: toNumber(raw?.id) ?? toStringValue(raw?.id) ?? Math.random().toString(36),
		instanceId: instance.id,
		instanceName: instance.label,
		service,
		type: "author",
		title: authorName,
		titleSlug: toStringValue(raw?.titleSlug ?? raw?.cleanName),
		sortTitle: toStringValue(raw?.sortName ?? raw?.sortTitle),
		year: extractAuthorYear(raw),
		overview: toStringValue(raw?.overview ?? raw?.biography),
		runtime: undefined, // Authors don't have runtime
		added: toStringValue(raw?.added),
		updated: toStringValue(raw?.lastInfoSync ?? raw?.lastModified),
		genres: normalizeGenres(raw?.genres),
		tags: normalizeTags(raw?.tags),
		poster: images.poster,
		fanart: images.fanart,
		monitored: toBoolean(raw?.monitored),
		hasFile: bookFileCount > 0,
		qualityProfileId: toNumber(raw?.qualityProfileId),
		qualityProfileName: toStringValue(
			(raw?.qualityProfile as Record<string, unknown> | undefined)?.name,
		),
		// Readarr uses metadataProfileId
		languageProfileId: toNumber(raw?.metadataProfileId),
		languageProfileName: toStringValue(
			(raw?.metadataProfile as Record<string, unknown> | undefined)?.name,
		),
		rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
		sizeOnDisk: toNumber(stats?.sizeOnDisk),
		path: toStringValue(raw?.path),
		status: toStringValue(raw?.status),
		remoteIds: {
			// Readarr uses GoodReads IDs and ASIN
			goodreadsId: toStringValue(raw?.foreignAuthorId ?? raw?.goodreadsId),
			asin: toStringValue(raw?.asin),
		},
		statistics: {
			bookCount: toNumber(stats?.bookCount ?? raw?.bookCount),
			bookFileCount,
			totalBookCount: toNumber(stats?.totalBookCount),
			missingBookCount: Math.max((toNumber(stats?.totalBookCount) ?? 0) - bookFileCount, 0),
		},
	} as LibraryItem;
};
