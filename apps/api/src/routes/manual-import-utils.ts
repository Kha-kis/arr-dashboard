import type {
	ManualImportCandidate,
	ManualImportCandidateRadarr,
	ManualImportCandidateSonarr,
	ManualImportSubmissionFile,
} from "@arr/shared";
import { manualImportCandidateListSchema, manualImportCandidateSchema } from "@arr/shared";
import { toNumber, toStringValue } from "../lib/data/values.js";

export class ManualImportError extends Error {
	statusCode: number;

	constructor(message: string, statusCode = 422) {
		super(message);
		this.statusCode = statusCode;
	}
}

export type ManualImportService = "sonarr" | "radarr";

export type ManualImportFetchOptions = {
	downloadId?: string;
	folder?: string;
	seriesId?: number;
	seasonNumber?: number;
	filterExistingFiles?: boolean;
};

const manualImportApiPath = "/api/v3/manualimport";
const commandApiPath = "/api/v3/command";

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
		return undefined;
	}

	return {
		id,
		title: toStringValue(movieObj?.title),
		tmdbId: toNumber(movieObj?.tmdbId),
		imdbId: toStringValue(movieObj?.imdbId),
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

		return manualImportCandidateSchema.parse({
			...base,
			service,
			movie: normalizeMovie(itemObj?.movie),
		});
	} catch (error) {
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
	const response = await fetcher(
		query.length > 0 ? `${manualImportApiPath}?${query}` : manualImportApiPath,
	);

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
	} catch (error) {
		throw new ManualImportError("ARR returned an invalid manual import payload.");
	}

	const rawItems = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { items?: unknown[] } | undefined)?.items)
			? (payload as { items: unknown[] }).items
			: [];

	if (!Array.isArray(rawItems) || rawItems.length === 0) {
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
		} else {
			if (candidate.service !== "radarr") {
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

	const response = await fetcher(commandApiPath, {
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
