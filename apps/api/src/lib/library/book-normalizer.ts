import type { LibraryBook } from "@arr/shared";
import { resolveImageUrl } from "./image-normalizer.js";
import { toBoolean, toNumber, toStringValue } from "./type-converters.js";

/**
 * Normalizes a raw book object from Readarr API
 * Books are children of authors in Readarr's data model
 *
 * @param raw - The raw book data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @param authorId - The author ID this book belongs to
 * @param baseUrl - The Readarr instance base URL for image URL construction
 * @returns A normalized library book
 */
export const normalizeBook = (
	raw: Record<string, unknown>,
	authorId: number,
	baseUrl?: string,
): LibraryBook => {
	const stats = (raw?.statistics ?? {}) as Record<string, unknown>;
	const images = (raw?.images ?? []) as Array<Record<string, unknown>>;

	return {
		id: toNumber(raw?.id) ?? 0,
		authorId,
		title: toStringValue(raw?.title) ?? "Unknown Book",
		releaseDate: toStringValue(raw?.releaseDate),
		genres: normalizeGenresArray(raw?.genres),
		hasFile: (toNumber(stats?.bookFileCount) ?? 0) > 0,
		monitored: toBoolean(raw?.monitored),
		statistics: {
			bookFileCount: toNumber(stats?.bookFileCount),
			sizeOnDisk: toNumber(stats?.sizeOnDisk),
		},
		overview: toStringValue(raw?.overview ?? raw?.description),
		images: images.map((img) => ({
			coverType: toStringValue(img?.coverType),
			url: resolveImageUrl(img?.remoteUrl ?? img?.url, baseUrl),
		})),
		foreignBookId: toStringValue(raw?.foreignBookId ?? raw?.goodreadsId),
		asin: toStringValue(raw?.asin),
		pageCount: toNumber(raw?.pageCount),
	};
};

/**
 * Normalizes genres array from raw API data
 */
const normalizeGenresArray = (genres: unknown): string[] | undefined => {
	if (!Array.isArray(genres)) return undefined;
	return genres.filter((g): g is string => typeof g === "string");
};

