import type { QueueActionCapabilities, QueueItem } from "@arr/shared";
import type { SonarrClient, RadarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import { toNumber, toStringValue } from "../data/values.js";

/** Service types that support queue functionality */
export type QueueService = "sonarr" | "radarr" | "lidarr" | "readarr";

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

/**
 * Returns the API path for queue endpoints
 * Note: Sonarr/Radarr use v3, Lidarr/Readarr use v1
 */
export const queueApiPath = (service: QueueService) => {
	return ["lidarr", "readarr"].includes(service) ? "/api/v1/queue" : "/api/v3/queue";
};

/**
 * Keywords that indicate manual import is required
 */
const manualImportKeywords = [
	"manual import",
	"manual intervention",
	"requires manual",
	"manually import",
	"cannot be imported",
	"could not be imported",
	"no files were found",
	"no matching series",
	"not a valid",
	"stuck pending",
	"import pending",
];

/**
 * Keywords that indicate a retry action should be available
 */
const retryKeywords = [
	"retry",
	"failed",
	"failure",
	"timed out",
	"timeout",
	"temporarily unavailable",
	"unavailable",
	"disconnected",
	"unauthorized",
	"unauthorised",
	"forbidden",
	"stalled",
	"connection",
	"ioexception",
	"i/o",
];

/**
 * Converts a value to lowercase string
 */
const toLowerCase = (value: unknown): string => {
	if (typeof value === "string") {
		return value.trim().toLowerCase();
	}
	return "";
};

/**
 * Collects all status texts from a queue item including statusMessages, errorMessage, and error fields
 */
const collectStatusTexts = (item: unknown): string[] => {
	const anyItem = item as UnknownRecord;
	const results: string[] = [];
	if (Array.isArray(anyItem?.statusMessages)) {
		for (const entry of anyItem.statusMessages) {
			if (entry && typeof entry === "object") {
				if (typeof entry.title === "string" && entry.title.trim()) {
					results.push(entry.title.trim());
				}
				if (Array.isArray(entry.messages)) {
					for (const message of entry.messages) {
						if (typeof message === "string" && message.trim()) {
							results.push(message.trim());
						}
					}
				}
			}
		}
	}

	if (typeof anyItem?.errorMessage === "string" && anyItem.errorMessage.trim()) {
		results.push(anyItem.errorMessage.trim());
	}

	if (typeof anyItem?.error === "string" && anyItem.error.trim()) {
		results.push(anyItem.error.trim());
	}

	return results;
};

/**
 * Finds the first message that contains any of the specified keywords
 */
const pickMatchingMessage = (messages: string[], keywords: string[]): string | undefined => {
	for (const message of messages) {
		const lower = message.toLowerCase();
		if (keywords.some((keyword) => lower.includes(keyword))) {
			return message;
		}
	}
	return undefined;
};

/**
 * Derives the available actions for a queue item based on its status and error messages
 */
export const deriveQueueActions = (item: unknown): QueueActionCapabilities => {
	const anyItem = item as UnknownRecord;
	const status = toLowerCase(anyItem?.status);
	const trackedState = toLowerCase(anyItem?.trackedDownloadState);
	const trackedStatus = toLowerCase(anyItem?.trackedDownloadStatus);
	const messages = collectStatusTexts(item);
	const downloadId = toStringValue(
		anyItem?.downloadId ?? anyItem?.guid ?? anyItem?.sourceId ?? anyItem?.data?.downloadId,
	);
	const hasDownloadId = Boolean(downloadId);

	const manualImportReason = pickMatchingMessage(messages, manualImportKeywords);
	const retryReason = pickMatchingMessage(messages, retryKeywords);

	const isPendingState = trackedState.includes("pending");
	const appearsCompleted =
		status.includes("completed") || status.includes("downloadclientunavailable");

	// Check if the download is in import-related states
	const isImportState =
		trackedState.includes("importpending") ||
		trackedState.includes("importfailed") ||
		trackedState.includes("importblocked");

	// Check if there's a warning that typically indicates manual import is needed
	const hasImportWarning =
		trackedStatus.includes("warning") && (isPendingState || appearsCompleted || isImportState);

	const canManualImport = Boolean(
		hasDownloadId &&
			(manualImportReason ||
				isImportState ||
				hasImportWarning ||
				(isPendingState && appearsCompleted) ||
				(trackedStatus.includes("pending") && appearsCompleted)),
	);

	const canRetry = Boolean(
		retryReason ||
			trackedStatus.includes("error") ||
			trackedStatus.includes("warning") ||
			status.includes("failed") ||
			status.includes("stalled") ||
			status.includes("retry") ||
			status.includes("warning"),
	);

	const recommendedAction = canManualImport ? "manualImport" : canRetry ? "retry" : undefined;

	return {
		canRetry,
		canManualImport,
		canRemove: true,
		canChangeCategory: Boolean(toStringValue(anyItem?.downloadClient)),
		recommendedAction,
		manualImportReason,
		retryReason,
	};
};

/**
 * Parses a queue ID from string or number format
 */
export const parseQueueId = (value: string | number): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
};

/**
 * Extracts the display title from a queue item based on the service type
 */
const extractQueueItemTitle = (anyItem: UnknownRecord, service: QueueService): string => {
	// Try generic title first
	const genericTitle = toStringValue(anyItem.title);
	if (genericTitle) return genericTitle;

	// Service-specific fallbacks
	switch (service) {
		case "sonarr":
			return toStringValue(anyItem.series?.title) ?? "Untitled";
		case "radarr":
			return toStringValue(anyItem.movie?.title) ?? "Untitled";
		case "lidarr":
			return toStringValue(anyItem.artist?.artistName) ?? toStringValue(anyItem.album?.title) ?? "Untitled";
		case "readarr":
			return toStringValue(anyItem.author?.authorName) ?? toStringValue(anyItem.book?.title) ?? "Untitled";
		default:
			return "Untitled";
	}
};

/**
 * Normalizes a raw queue item from the ARR API into a consistent format
 * Supports Sonarr (series/episodes), Radarr (movies), Lidarr (artists/albums), and Readarr (authors/books)
 */
export const normalizeQueueItem = (
	item: unknown,
	service: QueueService,
): Omit<QueueItem, "instanceId" | "instanceName"> => {
	const anyItem = item as UnknownRecord;
	const rawId =
		anyItem.id ??
		anyItem.queueId ??
		anyItem.queueItemId ??
		anyItem.downloadId ??
		Math.random().toString(36);
	const id =
		typeof rawId === "number" || typeof rawId === "string" ? rawId : Math.random().toString(36);

	const downloadId = toStringValue(anyItem.downloadId ?? anyItem.guid ?? anyItem.sourceId);
	const title = extractQueueItemTitle(anyItem, service);

	const normalized: Omit<QueueItem, "instanceId" | "instanceName"> = {
		id,
		queueItemId: toStringValue(anyItem.queueItemId ?? anyItem.queueId ?? anyItem.id),
		downloadId,
		title,
		// Sonarr fields
		seriesId: toNumber(anyItem.seriesId ?? anyItem.series?.id),
		episodeId: toNumber(anyItem.episodeId ?? anyItem.episode?.id),
		series:
			anyItem.series && typeof anyItem.series === "object"
				? {
						id: toNumber(anyItem.series.id),
						title: toStringValue(anyItem.series.title) ?? undefined,
					}
				: undefined,
		// Radarr fields
		movieId: toNumber(anyItem.movieId ?? anyItem.movie?.id),
		movie:
			anyItem.movie && typeof anyItem.movie === "object"
				? {
						id: toNumber(anyItem.movie.id),
						title: toStringValue(anyItem.movie.title) ?? undefined,
					}
				: undefined,
		// Lidarr fields
		artistId: toNumber(anyItem.artistId ?? anyItem.artist?.id),
		albumId: toNumber(anyItem.albumId ?? anyItem.album?.id),
		artist:
			anyItem.artist && typeof anyItem.artist === "object"
				? {
						id: toNumber(anyItem.artist.id),
						name: toStringValue(anyItem.artist.artistName) ?? undefined,
					}
				: undefined,
		album:
			anyItem.album && typeof anyItem.album === "object"
				? {
						id: toNumber(anyItem.album.id),
						title: toStringValue(anyItem.album.title) ?? undefined,
					}
				: undefined,
		// Readarr fields
		authorId: toNumber(anyItem.authorId ?? anyItem.author?.id),
		bookId: toNumber(anyItem.bookId ?? anyItem.book?.id),
		author:
			anyItem.author && typeof anyItem.author === "object"
				? {
						id: toNumber(anyItem.author.id),
						name: toStringValue(anyItem.author.authorName) ?? undefined,
					}
				: undefined,
		book:
			anyItem.book && typeof anyItem.book === "object"
				? {
						id: toNumber(anyItem.book.id),
						title: toStringValue(anyItem.book.title) ?? undefined,
					}
				: undefined,
		// Common fields
		size: toNumber(anyItem.size ?? anyItem.sizebytes),
		sizeleft: toNumber(anyItem.sizeleft ?? anyItem.sizeLeft ?? anyItem.sizeRemaining),
		status: toStringValue(anyItem.status),
		protocol: toStringValue(anyItem.protocol ?? anyItem.downloadProtocol),
		downloadProtocol: toStringValue(anyItem.downloadProtocol ?? anyItem.protocol),
		indexer: toStringValue(anyItem.indexer ?? anyItem.data?.indexer ?? anyItem.data?.indexerName),
		downloadClient: toStringValue(
			anyItem.downloadClient ?? anyItem.downloadClientName ?? anyItem.data?.downloadClient,
		),
		trackedDownloadState: toStringValue(anyItem.trackedDownloadState),
		trackedDownloadStatus: toStringValue(anyItem.trackedDownloadStatus),
		statusMessages: Array.isArray(anyItem.statusMessages)
			? anyItem.statusMessages
					.map((entry: unknown) => {
						const anyEntry = entry as UnknownRecord;
						const title = toStringValue(anyEntry?.title ?? anyEntry?.type ?? anyEntry?.source);
						const messages: string[] = [];
						if (Array.isArray(anyEntry?.messages)) {
							for (const raw of anyEntry.messages) {
								const text = toStringValue(raw);
								if (text) {
									messages.push(text);
								}
							}
						}
						return {
							title,
							messages: messages.length > 0 ? messages : undefined,
						};
					})
					.filter((entry: unknown) => {
						const anyEntry = entry as UnknownRecord;
						return anyEntry.title || (anyEntry.messages && anyEntry.messages.length > 0);
					})
			: undefined,
		errorMessage: toStringValue(anyItem.errorMessage ?? anyItem.error),
		service,
	};

	normalized.actions = deriveQueueActions(item);

	return normalized;
};

/** Payload type for queue search operations across all services */
export type QueueSearchPayload = {
	// Sonarr
	seriesId?: number;
	episodeIds?: number[];
	// Radarr
	movieId?: number;
	// Lidarr
	artistId?: number;
	albumIds?: number[];
	// Readarr
	authorId?: number;
	bookIds?: number[];
};

/**
 * Triggers a search command for the specified content using raw fetcher
 * Supports Sonarr, Radarr, Lidarr, and Readarr
 */
export const triggerQueueSearch = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: QueueService,
	payload?: QueueSearchPayload,
) => {
	if (!payload) {
		return;
	}

	// Determine API version path based on service
	const apiPath = ["lidarr", "readarr"].includes(service) ? "/api/v1/command" : "/api/v3/command";

	if (service === "sonarr") {
		const commandPayload: Record<string, unknown> = {};
		if (Array.isArray(payload.episodeIds) && payload.episodeIds.length > 0) {
			commandPayload.name = "EpisodeSearch";
			commandPayload.episodeIds = Array.from(new Set(payload.episodeIds));
		} else if (typeof payload.seriesId === "number") {
			commandPayload.name = "SeriesSearch";
			commandPayload.seriesId = payload.seriesId;
		} else {
			return;
		}

		const response = await fetcher(apiPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(commandPayload),
		});
		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			throw new Error(`Sonarr search command failed: ${message}`);
		}
		return;
	}

	if (service === "radarr") {
		if (typeof payload.movieId !== "number") {
			return;
		}

		const response = await fetcher(apiPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "MoviesSearch", movieIds: [payload.movieId] }),
		});
		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			throw new Error(`Radarr search command failed: ${message}`);
		}
		return;
	}

	if (service === "lidarr") {
		const commandPayload: Record<string, unknown> = {};
		if (Array.isArray(payload.albumIds) && payload.albumIds.length > 0) {
			commandPayload.name = "AlbumSearch";
			commandPayload.albumIds = Array.from(new Set(payload.albumIds));
		} else if (typeof payload.artistId === "number") {
			commandPayload.name = "ArtistSearch";
			commandPayload.artistId = payload.artistId;
		} else {
			return;
		}

		const response = await fetcher(apiPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(commandPayload),
		});
		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			throw new Error(`Lidarr search command failed: ${message}`);
		}
		return;
	}

	if (service === "readarr") {
		const commandPayload: Record<string, unknown> = {};
		if (Array.isArray(payload.bookIds) && payload.bookIds.length > 0) {
			commandPayload.name = "BookSearch";
			commandPayload.bookIds = Array.from(new Set(payload.bookIds));
		} else if (typeof payload.authorId === "number") {
			commandPayload.name = "AuthorSearch";
			commandPayload.authorId = payload.authorId;
		} else {
			return;
		}

		const response = await fetcher(apiPath, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(commandPayload),
		});
		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			throw new Error(`Readarr search command failed: ${message}`);
		}
	}
};

/** Union type for all ARR clients that support queue operations */
export type QueueClient = SonarrClient | RadarrClient | LidarrClient | ReadarrClient;

/**
 * Triggers a search command using the arr-sdk client
 * Supports Sonarr, Radarr, Lidarr, and Readarr
 */
export const triggerQueueSearchWithSdk = async (
	client: QueueClient,
	service: QueueService,
	payload?: QueueSearchPayload,
) => {
	if (!payload) {
		return;
	}

	if (service === "sonarr") {
		const sonarrClient = client as SonarrClient;
		if (Array.isArray(payload.episodeIds) && payload.episodeIds.length > 0) {
			await sonarrClient.command.execute({
				name: "EpisodeSearch",
				episodeIds: Array.from(new Set(payload.episodeIds)),
			});
		} else if (typeof payload.seriesId === "number") {
			await sonarrClient.command.execute({
				name: "SeriesSearch",
				seriesId: payload.seriesId,
			});
		}
		return;
	}

	if (service === "radarr") {
		if (typeof payload.movieId !== "number") {
			return;
		}
		const radarrClient = client as RadarrClient;
		await radarrClient.command.execute({
			name: "MoviesSearch",
			movieIds: [payload.movieId],
		});
		return;
	}

	if (service === "lidarr") {
		const lidarrClient = client as LidarrClient;
		if (Array.isArray(payload.albumIds) && payload.albumIds.length > 0) {
			await lidarrClient.command.execute({
				name: "AlbumSearch",
				albumIds: Array.from(new Set(payload.albumIds)),
			});
		} else if (typeof payload.artistId === "number") {
			await lidarrClient.command.execute({
				name: "ArtistSearch",
				artistId: payload.artistId,
			});
		}
		return;
	}

	if (service === "readarr") {
		const readarrClient = client as ReadarrClient;
		if (Array.isArray(payload.bookIds) && payload.bookIds.length > 0) {
			await readarrClient.command.execute({
				name: "BookSearch",
				bookIds: Array.from(new Set(payload.bookIds)),
			});
		} else if (typeof payload.authorId === "number") {
			await readarrClient.command.execute({
				name: "AuthorSearch",
				authorId: payload.authorId,
			});
		}
	}
};
