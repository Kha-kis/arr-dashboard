import type {
	ManualImportCandidate,
	ManualImportCandidateRadarr,
	ManualImportCandidateSonarr,
	ManualImportCandidateLidarr,
	ManualImportCandidateReadarr,
	ManualImportSubmissionFile,
	ManualImportServiceType,
} from "@arr/shared";
import { manualImportCandidateListSchema, manualImportCandidateSchema } from "@arr/shared";
import type { SonarrClient, RadarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import { toNumber, toStringValue } from "../lib/data/values.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

/**
 * Simple logger interface compatible with Fastify's logger
 * Allows utility functions to use proper logging when available
 */
export interface ManualImportLogger {
	warn: (msg: string, ...args: unknown[]) => void;
	debug: (msg: string, ...args: unknown[]) => void;
}

export class ManualImportError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode = 422) {
		super(message);
		this.name = "ManualImportError";
		this.statusCode = statusCode;
	}
}

// Re-export the type from shared for convenience
export type ManualImportService = ManualImportServiceType;

export type ManualImportFetchOptions = {
	downloadId?: string;
	folder?: string;
	seriesId?: number;
	seasonNumber?: number;
	filterExistingFiles?: boolean;
};

// Lidarr and Readarr use v1 API, Sonarr and Radarr use v3
const getManualImportApiPath = (service: ManualImportService): string =>
	service === "lidarr" || service === "readarr" ? "/api/v1/manualimport" : "/api/v3/manualimport";

const getCommandApiPath = (service: ManualImportService): string =>
	service === "lidarr" || service === "readarr" ? "/api/v1/command" : "/api/v3/command";

// Module-level logger - can be set by calling setManualImportLogger()
let moduleLogger: ManualImportLogger | undefined;

/**
 * Set the logger for manual import utilities
 * Call this from route initialization to enable proper logging
 */
export const setManualImportLogger = (logger: ManualImportLogger) => {
	moduleLogger = logger;
};

// Debug logging for normalization issues - helps diagnose API response problems
const logNormalizationWarning = (entityType: string, reason: string, rawValue?: unknown) => {
	if (process.env.NODE_ENV === "development" || process.env.DEBUG_MANUAL_IMPORT) {
		const msg = `[manual-import] Normalization skipped for ${entityType}: ${reason}`;
		moduleLogger?.debug(msg, rawValue !== undefined ? { rawValue } : undefined);
	}
};

const normalizeRejections = (rejections: unknown): ManualImportCandidate["rejections"] => {
	if (!Array.isArray(rejections)) {
		return undefined;
	}

	const normalized = rejections
		.map((entry) => {
			const entryObj = entry as Record<string, unknown> | undefined;
			const reason = toStringValue(entryObj?.reason ?? entry);
			const type = toStringValue(entryObj?.type);
			if (!reason && !type) {
				return undefined;
			}
			return {
				reason,
				type,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

	return normalized.length > 0 ? normalized : undefined;
};

const normalizeEpisodes = (episodes: unknown): ManualImportCandidateSonarr["episodes"] => {
	if (!Array.isArray(episodes)) {
		return undefined;
	}

	const normalized = episodes
		.map((episode) => {
			const episodeObj = episode as Record<string, unknown> | undefined;
			const id = toNumber(episodeObj?.id);
			if (typeof id !== "number") {
				return undefined;
			}
			return {
				id,
				title: toStringValue(episodeObj?.title),
				seasonNumber: toNumber(episodeObj?.seasonNumber),
				episodeNumber: toNumber(episodeObj?.episodeNumber),
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

	return normalized.length > 0 ? normalized : undefined;
};

const normalizeSeries = (series: unknown): ManualImportCandidateSonarr["series"] => {
	const seriesObj = series as Record<string, unknown> | undefined;
	const id = toNumber(seriesObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("series", "missing or invalid id", seriesObj?.id);
		return undefined;
	}

	return {
		id,
		title: toStringValue(seriesObj?.title),
		titleSlug: toStringValue(seriesObj?.titleSlug),
	};
};

const normalizeMovie = (movie: unknown): ManualImportCandidateRadarr["movie"] => {
	const movieObj = movie as Record<string, unknown> | undefined;
	const id = toNumber(movieObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("movie", "missing or invalid id", movieObj?.id);
		return undefined;
	}

	return {
		id,
		title: toStringValue(movieObj?.title),
		tmdbId: toNumber(movieObj?.tmdbId),
		imdbId: toStringValue(movieObj?.imdbId),
	};
};

const normalizeArtist = (artist: unknown): ManualImportCandidateLidarr["artist"] => {
	const artistObj = artist as Record<string, unknown> | undefined;
	const id = toNumber(artistObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("artist", "missing or invalid id", artistObj?.id);
		return undefined;
	}

	return {
		id,
		artistName: toStringValue(artistObj?.artistName),
		foreignArtistId: toStringValue(artistObj?.foreignArtistId),
	};
};

const normalizeAlbum = (album: unknown): ManualImportCandidateLidarr["album"] => {
	const albumObj = album as Record<string, unknown> | undefined;
	const id = toNumber(albumObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("album", "missing or invalid id", albumObj?.id);
		return undefined;
	}

	return {
		id,
		title: toStringValue(albumObj?.title),
		foreignAlbumId: toStringValue(albumObj?.foreignAlbumId),
	};
};

const normalizeAuthor = (author: unknown): ManualImportCandidateReadarr["author"] => {
	const authorObj = author as Record<string, unknown> | undefined;
	const id = toNumber(authorObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("author", "missing or invalid id", authorObj?.id);
		return undefined;
	}

	return {
		id,
		authorName: toStringValue(authorObj?.authorName),
		foreignAuthorId: toStringValue(authorObj?.foreignAuthorId),
	};
};

const normalizeBook = (book: unknown): ManualImportCandidateReadarr["book"] => {
	const bookObj = book as Record<string, unknown> | undefined;
	const id = toNumber(bookObj?.id);
	if (typeof id !== "number") {
		logNormalizationWarning("book", "missing or invalid id", bookObj?.id);
		return undefined;
	}

	return {
		id,
		title: toStringValue(bookObj?.title),
		foreignBookId: toStringValue(bookObj?.foreignBookId),
	};
};

const mapCandidate = (
	service: ManualImportService,
	item: unknown,
): ManualImportCandidate | null => {
	const itemObj = item as Record<string, unknown> | undefined;
	const path = toStringValue(itemObj?.path);
	if (!path) {
		return null;
	}

	const base = {
		id: itemObj?.id ?? path,
		path,
		relativePath: toStringValue(itemObj?.relativePath),
		folderName: toStringValue(itemObj?.folderName),
		name: toStringValue(itemObj?.name),
		size: typeof itemObj?.size === "number" ? itemObj.size : toNumber(itemObj?.size),
		downloadId: toStringValue(itemObj?.downloadId),
		releaseGroup: toStringValue(itemObj?.releaseGroup),
		quality: itemObj?.quality,
		languages: Array.isArray(itemObj?.languages) ? itemObj.languages : undefined,
		customFormats: Array.isArray(itemObj?.customFormats) ? itemObj.customFormats : undefined,
		customFormatScore: toNumber(itemObj?.customFormatScore),
		indexerFlags: toNumber(itemObj?.indexerFlags),
		releaseType: toStringValue(itemObj?.releaseType),
		rejections: normalizeRejections(itemObj?.rejections),
		episodeFileId: toNumber(itemObj?.episodeFileId),
		movieFileId: toNumber(itemObj?.movieFileId),
	} as const;

	try {
		if (service === "sonarr") {
			return manualImportCandidateSchema.parse({
				...base,
				service,
				series: normalizeSeries(itemObj?.series),
				seasonNumber: toNumber(itemObj?.seasonNumber),
				episodes: normalizeEpisodes(itemObj?.episodes),
			});
		}

		if (service === "radarr") {
			return manualImportCandidateSchema.parse({
				...base,
				service,
				movie: normalizeMovie(itemObj?.movie),
			});
		}

		if (service === "lidarr") {
			return manualImportCandidateSchema.parse({
				...base,
				service,
				artist: normalizeArtist(itemObj?.artist),
				album: normalizeAlbum(itemObj?.album),
				albumReleaseId: toNumber(itemObj?.albumReleaseId),
			});
		}

		if (service === "readarr") {
			return manualImportCandidateSchema.parse({
				...base,
				service,
				author: normalizeAuthor(itemObj?.author),
				book: normalizeBook(itemObj?.book),
			});
		}

		return null;
	} catch (error) {
		// Log validation failures to aid debugging - especially important for newer Lidarr/Readarr integrations
		const errorMessage = getErrorMessage(error, "Unknown validation error");
		const warnMsg = `[manual-import] Failed to parse ${service} candidate at path "${path}": ${errorMessage}`;
		moduleLogger?.warn(warnMsg);
		return null;
	}
};

export const fetchManualImportCandidates = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: ManualImportService,
	options: ManualImportFetchOptions,
): Promise<ManualImportCandidate[]> => {
	const params = new URLSearchParams();

	if (options.downloadId) {
		params.set("downloadId", options.downloadId);
	}
	if (options.folder) {
		params.set("folder", options.folder);
	}
	if (typeof options.seriesId === "number") {
		params.set("seriesId", String(options.seriesId));
	}
	if (typeof options.seasonNumber === "number") {
		params.set("seasonNumber", String(options.seasonNumber));
	}
	if (typeof options.filterExistingFiles === "boolean") {
		params.set("filterExistingFiles", String(options.filterExistingFiles));
	} else {
		params.set("filterExistingFiles", "true");
	}

	const query = params.toString();
	const apiPath = getManualImportApiPath(service);
	const response = await fetcher(query.length > 0 ? `${apiPath}?${query}` : apiPath);

	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new ManualImportError(
			`Failed to fetch manual import items (status ${response.status}): ${message || response.statusText}`,
			response.status,
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (_error) {
		throw new ManualImportError("ARR returned an invalid manual import payload.");
	}

	let rawItems: unknown[];
	if (Array.isArray(payload)) {
		rawItems = payload;
	} else if (Array.isArray((payload as { items?: unknown[] } | undefined)?.items)) {
		rawItems = (payload as { items: unknown[] }).items;
	} else {
		// Log unexpected response structure to aid debugging API compatibility issues
		const warnMsg =
			`[manual-import] Unexpected API response structure for ${service}. ` +
			`Expected array or {items: []}, got: ${typeof payload}`;
		moduleLogger?.warn(warnMsg);
		return [];
	}

	if (rawItems.length === 0) {
		return [];
	}

	const candidates = rawItems
		.map((item) => mapCandidate(service, item))
		.filter((candidate): candidate is ManualImportCandidate => candidate !== null);

	return manualImportCandidateListSchema.parse(candidates);
};

const summarizeRejections = (candidate: ManualImportCandidate): string | undefined => {
	if (!candidate.rejections || candidate.rejections.length === 0) {
		return undefined;
	}

	const reasons = candidate.rejections
		.map((rejection) => rejection.reason)
		.filter((reason): reason is string => Boolean(reason));

	return reasons.length > 0 ? reasons.join("; ") : undefined;
};

type CommandFileResult = {
	files: ManualImportSubmissionFile[];
	skipped: string[];
};

export const collectAutoManualImportFiles = (
	service: ManualImportService,
	candidates: ManualImportCandidate[],
	fallbackDownloadId: string,
): CommandFileResult => {
	const files: ManualImportSubmissionFile[] = [];
	const skipped: string[] = [];

	for (const candidate of candidates) {
		const humanName = candidate.relativePath ?? candidate.name ?? candidate.path;
		const rejectionSummary = summarizeRejections(candidate);
		if (rejectionSummary) {
			skipped.push(`${humanName}: ${rejectionSummary}`);
			continue;
		}

		const downloadId = candidate.downloadId ?? fallbackDownloadId;
		if (!downloadId) {
			skipped.push(`${humanName}: missing download identifier`);
			continue;
		}

		if (service === "sonarr") {
			if (candidate.service !== "sonarr") {
				skipped.push(`${humanName}: service type mismatch (expected sonarr, got ${candidate.service})`);
				continue;
			}

			const seriesCandidate: ManualImportCandidateSonarr = candidate;
			const seriesId = seriesCandidate.series?.id;
			const episodeIds =
				seriesCandidate.episodes
					?.map((episode) => episode.id)
					.filter((id): id is number => Boolean(id)) ?? [];

			if (!seriesId || episodeIds.length === 0) {
				skipped.push(`${humanName}: missing series or episode mapping`);
				continue;
			}

			files.push({
				path: candidate.path,
				folderName: candidate.folderName,
				downloadId,
				seriesId,
				episodeIds,
				episodeFileId: seriesCandidate.episodeFileId,
				quality: seriesCandidate.quality,
				languages: seriesCandidate.languages,
				releaseGroup: seriesCandidate.releaseGroup,
				indexerFlags: seriesCandidate.indexerFlags,
				releaseType: seriesCandidate.releaseType,
			});
		} else if (service === "radarr") {
			if (candidate.service !== "radarr") {
				skipped.push(`${humanName}: service type mismatch (expected radarr, got ${candidate.service})`);
				continue;
			}

			const movieCandidate: ManualImportCandidateRadarr = candidate;
			const movieId = movieCandidate.movie?.id;

			if (!movieId) {
				skipped.push(`${humanName}: missing movie mapping`);
				continue;
			}

			files.push({
				path: candidate.path,
				folderName: candidate.folderName,
				downloadId,
				movieId,
				movieFileId: movieCandidate.movieFileId,
				quality: movieCandidate.quality,
				languages: movieCandidate.languages,
				releaseGroup: movieCandidate.releaseGroup,
				indexerFlags: movieCandidate.indexerFlags,
			});
		} else if (service === "lidarr") {
			if (candidate.service !== "lidarr") {
				skipped.push(`${humanName}: service type mismatch (expected lidarr, got ${candidate.service})`);
				continue;
			}

			const lidarrCandidate: ManualImportCandidateLidarr = candidate;
			const artistId = lidarrCandidate.artist?.id;
			const albumId = lidarrCandidate.album?.id;

			if (!artistId || !albumId) {
				skipped.push(`${humanName}: missing artist or album mapping`);
				continue;
			}

			files.push({
				path: candidate.path,
				folderName: candidate.folderName,
				downloadId,
				artistId,
				albumId,
				albumReleaseId: lidarrCandidate.albumReleaseId,
				quality: lidarrCandidate.quality,
				languages: lidarrCandidate.languages,
				releaseGroup: lidarrCandidate.releaseGroup,
				indexerFlags: lidarrCandidate.indexerFlags,
			});
		} else if (service === "readarr") {
			if (candidate.service !== "readarr") {
				skipped.push(`${humanName}: service type mismatch (expected readarr, got ${candidate.service})`);
				continue;
			}

			const readarrCandidate: ManualImportCandidateReadarr = candidate;
			const authorId = readarrCandidate.author?.id;
			const bookId = readarrCandidate.book?.id;

			if (!authorId || !bookId) {
				skipped.push(`${humanName}: missing author or book mapping`);
				continue;
			}

			files.push({
				path: candidate.path,
				folderName: candidate.folderName,
				downloadId,
				authorId,
				bookId,
				quality: readarrCandidate.quality,
				languages: readarrCandidate.languages,
				releaseGroup: readarrCandidate.releaseGroup,
				indexerFlags: readarrCandidate.indexerFlags,
			});
		}
	}

	return { files, skipped };
};

const buildCommandFiles = (
	service: ManualImportService,
	files: ManualImportSubmissionFile[],
): Array<Record<string, unknown>> => {
	return files.map((file, index) => {
		const downloadId = toStringValue(file.downloadId)?.trim();
		if (!downloadId) {
			throw new ManualImportError(`File at index ${index} is missing a download identifier.`);
		}

		const base: Record<string, unknown> = {
			path: file.path,
			folderName: file.folderName ?? "",
			quality: file.quality,
			languages: file.languages ?? [],
			releaseGroup: file.releaseGroup,
			indexerFlags: typeof file.indexerFlags === "number" ? file.indexerFlags : 0,
			downloadId,
		};

		if (service === "sonarr") {
			const seriesId = file.seriesId;
			const episodeIds = Array.isArray(file.episodeIds) ? file.episodeIds : [];

			if (typeof seriesId !== "number" || episodeIds.length === 0) {
				throw new ManualImportError(
					`File at index ${index} is missing series or episode selections for Sonarr.`,
				);
			}

			return {
				...base,
				seriesId,
				episodeIds,
				releaseType: file.releaseType,
				episodeFileId: file.episodeFileId,
			};
		}

		if (service === "radarr") {
			const movieId = file.movieId;
			if (typeof movieId !== "number") {
				throw new ManualImportError(`File at index ${index} is missing movie selection for Radarr.`);
			}

			const commandFile: Record<string, unknown> = {
				...base,
				movieId,
			};

			if (typeof file.movieFileId === "number") {
				commandFile.movieFileId = file.movieFileId;
			}

			return commandFile;
		}

		if (service === "lidarr") {
			const artistId = file.artistId;
			const albumId = file.albumId;

			if (typeof artistId !== "number" || typeof albumId !== "number") {
				throw new ManualImportError(
					`File at index ${index} is missing artist or album selection for Lidarr.`,
				);
			}

			const commandFile: Record<string, unknown> = {
				...base,
				artistId,
				albumId,
			};

			if (typeof file.albumReleaseId === "number") {
				commandFile.albumReleaseId = file.albumReleaseId;
			}

			if (Array.isArray(file.trackIds) && file.trackIds.length > 0) {
				commandFile.trackIds = file.trackIds;
			}

			if (typeof file.trackFileId === "number") {
				commandFile.trackFileId = file.trackFileId;
			}

			return commandFile;
		}

		if (service === "readarr") {
			const authorId = file.authorId;
			const bookId = file.bookId;

			if (typeof authorId !== "number" || typeof bookId !== "number") {
				throw new ManualImportError(
					`File at index ${index} is missing author or book selection for Readarr.`,
				);
			}

			const commandFile: Record<string, unknown> = {
				...base,
				authorId,
				bookId,
			};

			if (typeof file.bookFileId === "number") {
				commandFile.bookFileId = file.bookFileId;
			}

			return commandFile;
		}

		throw new ManualImportError(`Unknown service type: ${service}`);
	});
};

export const submitManualImportCommand = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: ManualImportService,
	files: ManualImportSubmissionFile[],
	importMode: "auto" | "move" | "copy",
) => {
	if (files.length === 0) {
		throw new ManualImportError("No files were provided for manual import.");
	}

	const commandFiles = buildCommandFiles(service, files);
	const apiPath = getCommandApiPath(service);

	const response = await fetcher(apiPath, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			name: "ManualImport",
			importMode,
			files: commandFiles,
		}),
	});

	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new ManualImportError(
			`ARR manual import command failed (status ${response.status}): ${message || response.statusText}`,
			response.status,
		);
	}
};

export const autoImportByDownloadId = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: ManualImportService,
	downloadId: string,
) => {
	const candidates = await fetchManualImportCandidates(fetcher, service, {
		downloadId,
		filterExistingFiles: true,
	});

	if (candidates.length === 0) {
		throw new ManualImportError("ARR did not provide any importable files for this download.");
	}

	const { files, skipped } = collectAutoManualImportFiles(service, candidates, downloadId);

	if (files.length === 0) {
		const detail = skipped.length > 0 ? skipped.slice(0, 3).join("; ") : undefined;
		throw new ManualImportError(
			detail
				? `No importable files were found: ${detail}`
				: "ARR did not provide importable files for manual import.",
		);
	}

	await submitManualImportCommand(fetcher, service, files, "auto");
};

// ============================================================================
// SDK-based implementations
// ============================================================================

// Type for SDK clients that have the manualImport resource (Sonarr, Radarr)
type ManualImportClient = {
	manualImport: {
		get: (params: {
			downloadId?: string;
			folder?: string;
			seriesId?: number;
			seasonNumber?: number;
			filterExistingFiles?: boolean;
		}) => Promise<unknown[]>;
	};
};

// All SDK clients extend BaseClient which has get/post for raw API calls.
// Lidarr/Readarr lack the typed manualImport resource, so we fall back to these.
type BaseClientMethods = {
	get: <T>(path: string, params?: Record<string, unknown>) => Promise<T>;
	post: <T>(path: string, body?: unknown, params?: Record<string, unknown>) => Promise<T>;
};

/**
 * Checks whether the SDK client has a typed manualImport resource
 */
const hasManualImportResource = (client: unknown): client is ManualImportClient => {
	const c = client as ManualImportClient | undefined;
	return typeof c?.manualImport?.get === "function";
};

/**
 * Fetches manual import candidates using the arr-sdk client.
 *
 * Sonarr/Radarr SDKs expose a typed `manualImport` resource.
 * Lidarr/Readarr SDKs lack it, so we fall back to BaseClient.get() with the raw API path.
 */
export const fetchManualImportCandidatesWithSdk = async (
	client: SonarrClient | RadarrClient | LidarrClient | ReadarrClient,
	service: ManualImportService,
	options: ManualImportFetchOptions,
): Promise<ManualImportCandidate[]> => {
	try {
		let rawItems: unknown[];

		if (hasManualImportResource(client)) {
			// Sonarr/Radarr: use the typed SDK resource
			rawItems = await client.manualImport.get({
				downloadId: options.downloadId,
				folder: options.folder,
				seriesId: options.seriesId,
				seasonNumber: options.seasonNumber,
				filterExistingFiles: options.filterExistingFiles ?? true,
			});
		} else {
			// Lidarr/Readarr: fall back to BaseClient.get() with the raw API path
			const baseClient = client as unknown as BaseClientMethods;
			const apiPath = getManualImportApiPath(service);
			const params: Record<string, unknown> = {
				filterExistingFiles: options.filterExistingFiles ?? true,
			};
			if (options.downloadId) params.downloadId = options.downloadId;
			if (options.folder) params.folder = options.folder;
			if (typeof options.seriesId === "number") params.seriesId = options.seriesId;
			if (typeof options.seasonNumber === "number") params.seasonNumber = options.seasonNumber;

			rawItems = await baseClient.get<unknown[]>(apiPath, params);
		}

		if (!Array.isArray(rawItems) || rawItems.length === 0) {
			return [];
		}

		const candidates = rawItems
			.map((item) => mapCandidate(service, item))
			.filter((candidate): candidate is ManualImportCandidate => candidate !== null);

		return manualImportCandidateListSchema.parse(candidates);
	} catch (error) {
		if (error instanceof ManualImportError) {
			throw error;
		}
		const message = getErrorMessage(error, "Unknown error");
		throw new ManualImportError(`Failed to fetch manual import items: ${message}`, 502);
	}
};

/**
 * Submits a manual import command using the arr-sdk client.
 *
 * Uses BaseClient.post() to call the command API directly, which works for all
 * services including Lidarr/Readarr whose typed command unions don't include ManualImport.
 *
 * Note: The SDK expects "Move" | "Copy" for importMode (capitalized).
 * "auto" mode is translated to "Move" as the default import behavior.
 */
export const submitManualImportCommandWithSdk = async (
	client: SonarrClient | RadarrClient | LidarrClient | ReadarrClient,
	service: ManualImportService,
	files: ManualImportSubmissionFile[],
	importMode: "auto" | "move" | "copy",
) => {
	if (files.length === 0) {
		throw new ManualImportError("No files were provided for manual import.");
	}

	const commandFiles = buildCommandFiles(service, files);

	// Convert import mode to SDK expected format (capitalized)
	// "auto" defaults to "Move" which is the standard ARR behavior
	const sdkImportMode: "Move" | "Copy" = importMode === "copy" ? "Copy" : "Move";

	try {
		// Use BaseClient.post() directly to call the command API.
		// This avoids typed command unions that may not include ManualImport (Lidarr/Readarr).
		const baseClient = client as unknown as BaseClientMethods;
		const commandPath = getCommandApiPath(service);

		await baseClient.post(commandPath, {
			name: "ManualImport",
			importMode: sdkImportMode,
			files: commandFiles,
		});
	} catch (error) {
		if (error instanceof ManualImportError) {
			throw error;
		}
		const message = getErrorMessage(error, "Unknown error");
		throw new ManualImportError(`ARR manual import command failed: ${message}`, 502);
	}
};

/**
 * Auto-imports files by download ID using the arr-sdk client
 */
export const autoImportByDownloadIdWithSdk = async (
	client: SonarrClient | RadarrClient | LidarrClient | ReadarrClient,
	service: ManualImportService,
	downloadId: string,
) => {
	const candidates = await fetchManualImportCandidatesWithSdk(client, service, {
		downloadId,
		filterExistingFiles: true,
	});

	if (candidates.length === 0) {
		throw new ManualImportError("ARR did not provide any importable files for this download.");
	}

	const { files, skipped } = collectAutoManualImportFiles(service, candidates, downloadId);

	if (files.length === 0) {
		const detail = skipped.length > 0 ? skipped.slice(0, 3).join("; ") : undefined;
		throw new ManualImportError(
			detail
				? `No importable files were found: ${detail}`
				: "ARR did not provide importable files for manual import.",
		);
	}

	await submitManualImportCommandWithSdk(client, service, files, "auto");
};
