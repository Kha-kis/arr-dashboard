import type { HistoryItem } from "@arr/shared";
import { toNumber, toStringValue } from "../data/values.js";

/** Service types that support history functionality */
export type HistoryService = "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

/**
 * Returns the API path for history endpoints
 * Note: Prowlarr, Lidarr, and Readarr use v1 API; Sonarr/Radarr use v3
 */
export const historyApiPath = (service: HistoryService) =>
	["prowlarr", "lidarr", "readarr"].includes(service) ? "/api/v1/history" : "/api/v3/history";

/**
 * Normalizes a raw history item from the ARR API into a consistent format
 * Supports Sonarr (episodes), Radarr (movies), Prowlarr (indexer), Lidarr (albums/tracks), and Readarr (books)
 */
export const normalizeHistoryItem = (
	item: unknown,
	service: HistoryService,
): HistoryItem => {
	const anyItem = item as UnknownRecord;
	const rawId =
		anyItem.id ??
		anyItem.eventId ??
		anyItem.downloadId ??
		anyItem.sourceId ??
		anyItem.historyId ??
		anyItem.guid ??
		Math.random().toString(36);
	const normalizedId =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const downloadId =
		toStringValue(anyItem.downloadId) ??
		toStringValue(anyItem.sourceId) ??
		toStringValue(anyItem.eventId) ??
		toStringValue(anyItem.guid) ??
		(typeof normalizedId === "number" || typeof normalizedId === "string"
			? String(normalizedId)
			: undefined);

	// For Prowlarr, extract more info from data field
	const isProwlarr = service === "prowlarr";
	const dataObj = typeof anyItem.data === "object" ? anyItem.data : {};

	// Prowlarr specific: extract query, release title, or other useful info
	// Try multiple possible field names from Prowlarr's response
	const prowlarrTitle = isProwlarr
		? (toStringValue(anyItem.sourceTitle) ??
			toStringValue(dataObj.releaseTitle) ??
			toStringValue(dataObj.title) ??
			toStringValue(dataObj.query) ??
			toStringValue(dataObj.searchTerm) ??
			toStringValue(dataObj.searchString) ??
			toStringValue(anyItem.title))
		: undefined;

	const prowlarrSource = isProwlarr
		? (toStringValue(dataObj.indexer) ??
			toStringValue(dataObj.indexerName) ??
			toStringValue(dataObj.host))
		: undefined;

	// Extract title based on service type
	const extractedTitle =
		prowlarrTitle ??
		toStringValue(anyItem.title) ??
		toStringValue(anyItem.sourceTitle) ??
		toStringValue(anyItem.series?.title) ??
		toStringValue(anyItem.movie?.title) ??
		toStringValue(anyItem.artist?.artistName) ??
		toStringValue(anyItem.album?.title) ??
		toStringValue(anyItem.author?.authorName) ??
		toStringValue(anyItem.book?.title) ??
		"Untitled";

	return {
		id: normalizedId,
		downloadId,
		title: extractedTitle,
		size: toNumber(anyItem.size ?? dataObj.size),
		quality: anyItem.quality ?? dataObj.quality,
		status: toStringValue(anyItem.status ?? anyItem.eventType ?? anyItem.event),
		downloadClient: toStringValue(
			anyItem.downloadClient ?? dataObj.downloadClient ?? dataObj.downloadClientName,
		),
		indexer:
			prowlarrSource ?? toStringValue(anyItem.indexer ?? dataObj.indexer ?? dataObj.indexerName),
		protocol: toStringValue(anyItem.protocol ?? anyItem.downloadProtocol ?? dataObj.protocol),
		date: toStringValue(
			anyItem.date ??
				anyItem.eventDate ??
				anyItem.eventDateUtc ??
				anyItem.created ??
				anyItem.timestamp,
		),
		reason: toStringValue(
			anyItem.reason ?? dataObj.reason ?? anyItem.error ?? dataObj.message ?? dataObj.statusMessage,
		),
		eventType: toStringValue(anyItem.eventType ?? anyItem.event),
		sourceTitle: toStringValue(anyItem.sourceTitle ?? dataObj.source),
		// Sonarr fields
		seriesId: toNumber(anyItem.seriesId ?? anyItem.series?.id),
		seriesSlug: toStringValue(anyItem.series?.titleSlug ?? anyItem.seriesSlug),
		episodeId: toNumber(anyItem.episodeId ?? anyItem.episode?.id),
		// Radarr fields
		movieId: toNumber(anyItem.movieId ?? anyItem.movie?.id),
		movieSlug: toStringValue(anyItem.movie?.titleSlug ?? anyItem.movieSlug),
		// Lidarr fields
		artistId: toNumber(anyItem.artistId ?? anyItem.artist?.id),
		albumId: toNumber(anyItem.albumId ?? anyItem.album?.id),
		trackId: toNumber(anyItem.trackId ?? anyItem.track?.id),
		// Readarr fields
		authorId: toNumber(anyItem.authorId ?? anyItem.author?.id),
		bookId: toNumber(anyItem.bookId ?? anyItem.book?.id),
		data: typeof anyItem.data === "object" ? anyItem.data : undefined,
		customFormats: Array.isArray(anyItem.customFormats)
			? anyItem.customFormats
				.filter((cf: unknown) => cf && typeof cf === "object" && "id" in cf && "name" in cf)
				.map((cf: UnknownRecord) => ({ id: Number(cf.id), name: String(cf.name) }))
			: undefined,
		customFormatScore: toNumber(anyItem.customFormatScore),
		instanceId: "",
		instanceName: "",
		service,
	};
};
