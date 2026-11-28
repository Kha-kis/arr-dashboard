import { createHash } from "node:crypto";
import type {
	ManualImportCandidate,
	ManualImportServiceType,
	ManualImportSubmissionFile,
} from "@arr/shared";
import { manualImportForeignEditionIdSchema, manualImportTrackIdsSchema } from "@arr/shared";
import { normalizeDownloadId } from "../../queue-cleaner/qui-gate.js";
import { importCommandFingerprint } from "../manual-import-command.js";
import type { ImportAttemptFile, ImportFileIdentity } from "./repository.js";

export class ManualImportSelectionError extends Error {
	readonly statusCode = 409;
	constructor() {
		super(
			"The current import selection is unverified. Reload candidates and select current files.",
		);
		this.name = "ManualImportSelectionError";
	}
}

export interface VerifiedImportSelection {
	files: ManualImportSubmissionFile[];
	identities: ImportAttemptFile[];
	requestFingerprint: string;
	commandFingerprint: string;
}

const identityFields = [
	"seriesId",
	"episodeIds",
	"episodeFileId",
	"movieId",
	"movieFileId",
	"artistId",
	"albumId",
	"albumReleaseId",
	"trackIds",
	"trackFileId",
	"authorId",
	"bookId",
	"bookFileId",
	"foreignEditionId",
] as const;
const serviceFields: Record<ManualImportServiceType, readonly string[]> = {
	sonarr: ["seriesId", "episodeIds", "episodeFileId"],
	radarr: ["movieId", "movieFileId"],
	lidarr: ["artistId", "albumId", "albumReleaseId", "trackIds", "trackFileId"],
	readarr: ["authorId", "bookId", "bookFileId", "foreignEditionId"],
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function reject(): never {
	throw new ManualImportSelectionError();
}

function sourceId(value: string): string {
	if (typeof value !== "string" || !value || value !== value.trim()) reject();
	// The queue correlator recognizes torrent hashes only. Opaque Usenet/source
	// IDs are still valid import identities and retain their exact case.
	return normalizeDownloadId(value) ?? value;
}

function validId(value: unknown, allowZero = false): number {
	if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) reject();
	return Number(value);
}

function matchingId(actual: unknown, requested: unknown): number {
	const id = validId(actual);
	if (id !== requested) reject();
	return id;
}

function optionalId(actual: number | undefined, requested: number | undefined): number | undefined {
	if (actual !== undefined) validId(actual, true);
	if (requested !== undefined && requested !== actual) reject();
	return actual;
}

/** Immutable user selection, without treating client metadata as command authority. */
export function importRequestFingerprint(files: ManualImportSubmissionFile[]): string {
	if (!files.length || files.length > 1000) reject();
	const signatures = files.map((file) => {
		if (!file.path?.trim()) reject();
		const identity: Record<string, unknown> = {
			path: file.path,
			downloadId: sourceId(file.downloadId),
		};
		for (const field of identityFields) {
			const value = file[field];
			// Historical v1 signatures did not contain an edition slot.
			if (field === "foreignEditionId" && value === undefined) continue;
			if (
				field === "foreignEditionId" &&
				!manualImportForeignEditionIdSchema.safeParse(value).success
			)
				reject();
			identity[field] = Array.isArray(value) ? [...value].sort((a, b) => a - b) : (value ?? null);
		}
		return JSON.stringify(identity);
	});
	if (new Set(signatures).size !== signatures.length) reject();
	return `v1:${hash(JSON.stringify(signatures.sort()))}`;
}

/**
 * Pure authority boundary. Caller fetches current candidates from the owned,
 * enabled connection; this function accepts only exact, unambiguous identities.
 * It never forwards browser-supplied metadata into a provider command.
 */
export function buildVerifiedImportSelection(
	service: ManualImportServiceType,
	requestedFiles: ManualImportSubmissionFile[],
	currentCandidates: ManualImportCandidate[],
): VerifiedImportSelection {
	const requestFingerprint = importRequestFingerprint(requestedFiles);
	const selectedPaths = new Set<string>();
	const files: ManualImportSubmissionFile[] = [];
	const identities: ImportAttemptFile[] = [];
	for (const requested of requestedFiles) {
		if (selectedPaths.has(requested.path)) reject();
		selectedPaths.add(requested.path);
		for (const field of identityFields) {
			if (requested[field] !== undefined && !serviceFields[service].includes(field)) reject();
		}
		// A path claimed by multiple sources/mappings is ambiguous, even if only
		// one row happens to match the client-provided download identifier.
		const matches = currentCandidates.filter((candidate) => candidate.path === requested.path);
		if (matches.length !== 1) reject();
		const candidate = matches[0] ?? reject();
		if (
			candidate.service !== service ||
			!candidate.downloadId ||
			sourceId(candidate.downloadId) !== sourceId(requested.downloadId)
		)
			reject();
		const downloadId = sourceId(candidate.downloadId);
		const file: ManualImportSubmissionFile = {
			path: candidate.path,
			downloadId,
			folderName: candidate.folderName,
			quality: candidate.quality,
			languages: candidate.languages,
			releaseGroup: candidate.releaseGroup,
			indexerFlags: candidate.indexerFlags,
		};
		let identity: ImportFileIdentity;
		const pathHash = hash(candidate.path);
		switch (candidate.service) {
			case "sonarr": {
				const seriesId = matchingId(candidate.series?.id, requested.seriesId);
				const currentIds = candidate.episodes?.map((episode) => validId(episode.id)) ?? [];
				const episodeIds =
					requested.episodeIds?.map((id) => validId(id)).sort((a, b) => a - b) ?? [];
				if (
					!episodeIds.length ||
					new Set(episodeIds).size !== episodeIds.length ||
					new Set(currentIds).size !== currentIds.length ||
					episodeIds.some((id) => !currentIds.includes(id))
				)
					reject();
				const episodeFileId = optionalId(candidate.episodeFileId, requested.episodeFileId);
				Object.assign(file, {
					seriesId,
					episodeIds,
					episodeFileId,
					releaseType: candidate.releaseType,
				});
				identity = {
					pathHash,
					seriesId,
					episodeIds,
					...(episodeFileId === undefined ? {} : { episodeFileId }),
				};
				break;
			}
			case "radarr": {
				const movieId = matchingId(candidate.movie?.id, requested.movieId);
				const movieFileId = optionalId(candidate.movieFileId, requested.movieFileId);
				Object.assign(file, { movieId, movieFileId });
				identity = { pathHash, movieId, ...(movieFileId === undefined ? {} : { movieFileId }) };
				break;
			}
			case "lidarr": {
				const artistId = matchingId(candidate.artist?.id, requested.artistId);
				const albumId = matchingId(candidate.album?.id, requested.albumId);
				const albumReleaseId = validId(candidate.albumReleaseId);
				if (requested.albumReleaseId !== undefined && requested.albumReleaseId !== albumReleaseId)
					reject();
				const currentTrackIds = candidate.tracks?.map((track) => track.id);
				if (!manualImportTrackIdsSchema.safeParse(currentTrackIds).success) reject();
				const trackIds = [...currentTrackIds!].sort((a, b) => a - b);
				if (requested.trackIds !== undefined) {
					if (
						!manualImportTrackIdsSchema.safeParse(requested.trackIds).success ||
						JSON.stringify([...requested.trackIds].sort((a, b) => a - b)) !==
							JSON.stringify(trackIds)
					)
						reject();
				}
				// Track-file evidence is still absent; never accept a client-only ID.
				if (requested.trackFileId !== undefined) reject();
				Object.assign(file, { artistId, albumId, albumReleaseId, trackIds });
				identity = {
					pathHash,
					artistId,
					albumId,
					trackIds,
					albumReleaseId,
				};
				break;
			}
			case "readarr": {
				const authorId = matchingId(candidate.author?.id, requested.authorId);
				const bookId = matchingId(candidate.book?.id, requested.bookId);
				const edition = manualImportForeignEditionIdSchema.safeParse(candidate.foreignEditionId);
				if (!edition.success) reject();
				const foreignEditionId = edition.data;
				if (
					requested.foreignEditionId !== undefined &&
					requested.foreignEditionId !== foreignEditionId
				)
					reject();
				// No normalized book-file evidence exists; do not trust a client ID.
				if (requested.bookFileId !== undefined) reject();
				Object.assign(file, { authorId, bookId, foreignEditionId });
				identity = { pathHash, authorId, bookId, foreignEditionId };
				break;
			}
		}
		const fileFingerprint = importCommandFingerprint([file]);
		if (!fileFingerprint) reject();
		files.push(file);
		identities.push({ fileFingerprint, downloadKey: hash(downloadId), identity });
	}
	const commandFingerprint = importCommandFingerprint(files);
	if (!commandFingerprint) reject();
	return { files, identities, requestFingerprint, commandFingerprint };
}
