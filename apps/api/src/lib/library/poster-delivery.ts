import { createHash } from "node:crypto";

/** Root Library artwork only; never accept a client-supplied provider URL/path. */
export const LIBRARY_POSTER_SERVICES = {
	movie: "RADARR",
	series: "SONARR",
	artist: "LIDARR",
	author: "READARR",
} as const;

export type LibraryPosterType = keyof typeof LIBRARY_POSTER_SERVICES;
type PosterCacheKey = { instanceId: string; arrItemId: number; itemType: string };
const MAX_POSTER_BYTES = 4 * 1024 * 1024;
const RASTER_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export function libraryPosterUrl(row: PosterCacheKey, poster: unknown): string | undefined {
	if (
		typeof poster !== "string" ||
		!poster.trim() ||
		!row.instanceId ||
		!Number.isSafeInteger(row.arrItemId) ||
		row.arrItemId <= 0 ||
		!Object.hasOwn(LIBRARY_POSTER_SERVICES, row.itemType)
	)
		return undefined;
	// A changed cached source resets browser fallback/cache state without exposing
	// its origin or using it as provider-request authority.
	const version = createHash("sha256").update(poster).digest("hex").slice(0, 16);
	return `/api/library/poster/${encodeURIComponent(row.instanceId)}/${row.itemType}/${row.arrItemId}?v=${version}`;
}

export function libraryPosterPath(
	itemType: LibraryPosterType,
	itemId: number,
	data: string,
): string {
	let extension = "jpg";
	// Radarr/Sonarr always save posters as JPEG. Lidarr/Readarr retain the
	// source cover's extension; only a known raster suffix may affect this path.
	if (itemType === "artist" || itemType === "author") {
		try {
			const poster: unknown = JSON.parse(data)?.poster;
			if (typeof poster === "string") {
				const suffix = /\.(jpe?g|png|webp|gif|avif)$/i.exec(poster.split(/[?#]/, 1)[0] ?? "");
				if (suffix) extension = suffix[1]!;
			}
		} catch {
			// Corrupt cached metadata cannot choose a path. Use the fixed default.
		}
	}
	return `/MediaCover/${itemId}/poster.${extension}`;
}

/** Consume at most four MiB; header-only validation must not permit an unbounded read. */
export async function readLibraryPoster(
	response: Response,
): Promise<{ bytes: Buffer; contentType: string } | null> {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	const length = Number(response.headers.get("content-length"));
	if (!contentType || !RASTER_MIME.has(contentType) || length > MAX_POSTER_BYTES) {
		await response.body?.cancel();
		return null;
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_POSTER_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		return size ? { bytes: Buffer.concat(chunks, size), contentType } : null;
	} finally {
		reader.releaseLock();
	}
}
