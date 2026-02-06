import type { LibraryAlbum } from "@arr/shared";
import { toBoolean, toNumber, toStringValue } from "./type-converters.js";

/**
 * Normalizes a raw album object from Lidarr API
 * Albums are children of artists in Lidarr's data model
 *
 * @param raw - The raw album data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @param artistId - The artist ID this album belongs to
 * @param baseUrl - The Lidarr instance base URL for image URL construction
 * @returns A normalized library album
 */
export const normalizeAlbum = (
	raw: Record<string, unknown>,
	artistId: number,
	baseUrl?: string,
): LibraryAlbum => {
	const stats = (raw?.statistics ?? {}) as Record<string, unknown>;
	const images = (raw?.images ?? []) as Array<Record<string, unknown>>;

	// Find cover image
	const coverImage = images.find(
		(img) => img?.coverType === "cover" || img?.coverType === "disc",
	);

	// Construct full image URL if relative
	let coverUrl = toStringValue(coverImage?.url ?? coverImage?.remoteUrl);
	if (coverUrl && baseUrl && !coverUrl.startsWith("http")) {
		coverUrl = `${baseUrl.replace(/\/$/, "")}${coverUrl}`;
	}

	return {
		id: toNumber(raw?.id) ?? 0,
		artistId,
		title: toStringValue(raw?.title) ?? "Unknown Album",
		releaseDate: toStringValue(raw?.releaseDate),
		albumType: toStringValue(raw?.albumType),
		genres: normalizeGenresArray(raw?.genres),
		hasFile: (toNumber(stats?.trackFileCount) ?? 0) > 0,
		monitored: toBoolean(raw?.monitored),
		statistics: {
			trackCount: toNumber(stats?.trackCount),
			trackFileCount: toNumber(stats?.trackFileCount),
			totalTrackCount: toNumber(stats?.totalTrackCount),
			sizeOnDisk: toNumber(stats?.sizeOnDisk),
			percentOfTracks: toNumber(stats?.percentOfTracks),
		},
		overview: toStringValue(raw?.overview),
		images: images.map((img) => ({
			coverType: toStringValue(img?.coverType),
			url: constructImageUrl(toStringValue(img?.url ?? img?.remoteUrl), baseUrl),
		})),
		foreignAlbumId: toStringValue(raw?.foreignAlbumId),
	};
};

/**
 * Normalizes genres array from raw API data
 */
const normalizeGenresArray = (genres: unknown): string[] | undefined => {
	if (!Array.isArray(genres)) return undefined;
	return genres.filter((g): g is string => typeof g === "string");
};

/**
 * Constructs full image URL from relative path
 */
const constructImageUrl = (
	url: string | undefined,
	baseUrl?: string,
): string | undefined => {
	if (!url) return undefined;
	if (url.startsWith("http")) return url;
	if (!baseUrl) return url;
	return `${baseUrl.replace(/\/$/, "")}${url}`;
};
