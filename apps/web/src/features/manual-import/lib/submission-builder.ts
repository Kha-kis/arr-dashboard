import type {
  ManualImportCandidateUnion,
  ManualImportSubmissionFile,
} from "../types";
import {
  extractDownloadId,
  isSonarrCandidate,
  isRadarrCandidate,
} from "../helpers";

/**
 * Builds default submission values for a candidate
 */
export function buildSubmissionDefaults(
  candidate: ManualImportCandidateUnion,
  fallbackDownloadId?: string,
): {
  downloadId: string;
  values: ManualImportSubmissionFile;
} | null {
  const resolvedDownloadId =
    extractDownloadId(candidate) ?? fallbackDownloadId;
  if (!resolvedDownloadId) {
    return null;
  }

  const defaults: ManualImportSubmissionFile = {
    path: candidate.path,
    folderName: candidate.folderName ?? "",
    downloadId: resolvedDownloadId,
    quality: candidate.quality,
    languages: candidate.languages,
    releaseGroup: candidate.releaseGroup ?? undefined,
    indexerFlags:
      typeof candidate.indexerFlags === "number" &&
      Number.isFinite(candidate.indexerFlags)
        ? candidate.indexerFlags
        : 0,
    releaseType: candidate.releaseType ?? undefined,
  };

  if (isSonarrCandidate(candidate)) {
    const seriesId = candidate.series?.id;
    const episodeIds =
      candidate.episodes
        ?.map((episode) => episode?.id)
        .filter((id): id is number => typeof id === "number") ?? [];

    if (typeof seriesId === "number" && episodeIds.length > 0) {
      defaults.seriesId = seriesId;
      defaults.episodeIds = episodeIds;
    }

    if (typeof candidate.episodeFileId === "number") {
      defaults.episodeFileId = candidate.episodeFileId;
    }
  } else if (isRadarrCandidate(candidate)) {
    const movieId = candidate.movie?.id;
    if (typeof movieId === "number") {
      defaults.movieId = movieId;
    }
    if (typeof candidate.movieFileId === "number") {
      defaults.movieFileId = candidate.movieFileId;
    }
  }

  return { downloadId: resolvedDownloadId, values: defaults };
}
