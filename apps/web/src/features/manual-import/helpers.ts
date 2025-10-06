import type {
  ManualImportCandidateUnion,
  ManualImportSonarrCandidate,
  ManualImportRadarrCandidate,
} from "./types";

export const isSonarrCandidate = (
  candidate: ManualImportCandidateUnion,
): candidate is ManualImportSonarrCandidate => candidate.service === "sonarr";

export const isRadarrCandidate = (
  candidate: ManualImportCandidateUnion,
): candidate is ManualImportRadarrCandidate => candidate.service === "radarr";

type SonarrEpisode = NonNullable<
  ManualImportSonarrCandidate["episodes"]
>[number];

const isMeaningfulString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const formatEpisodeCode = (
  episode: SonarrEpisode | undefined,
): string => {
  if (!episode) {
    return "";
  }

  const season =
    typeof episode.seasonNumber === "number" ? episode.seasonNumber : undefined;
  const episodeNumber =
    typeof episode.episodeNumber === "number"
      ? episode.episodeNumber
      : undefined;

  const seasonPart =
    typeof season === "number" ? `S${String(season).padStart(2, "0")}` : "";
  const episodePart =
    typeof episodeNumber === "number"
      ? `E${String(episodeNumber).padStart(2, "0")}`
      : "";

  return `${seasonPart}${episodePart}`;
};

export const describeEpisode = (episode: SonarrEpisode | undefined): string => {
  if (!episode) {
    return "Episode";
  }

  const code = formatEpisodeCode(episode);
  const title = isMeaningfulString(episode.title)
    ? episode.title.trim()
    : undefined;

  if (code && title) {
    return `${code} - ${title}`;
  }

  if (title) {
    return title;
  }

  return code || "Episode";
};

export const describeRejections = (
  candidate: ManualImportCandidateUnion,
): string | undefined => {
  if (!candidate.rejections || candidate.rejections.length === 0) {
    return undefined;
  }

  const reasons = candidate.rejections
    .map((rejection) => rejection.reason)
    .filter(isMeaningfulString);

  return reasons.length > 0 ? reasons.join("; ") : undefined;
};

export const describeCandidate = (
  candidate: ManualImportCandidateUnion,
): string => {
  const fallback =
    candidate.name ??
    candidate.relativePath ??
    candidate.path ??
    String(candidate.id ?? "candidate");

  if (isSonarrCandidate(candidate)) {
    const seriesTitle = candidate.series?.title ?? "Unknown series";
    const episodes = candidate.episodes
      ?.map((episode) => describeEpisode(episode))
      .filter(isMeaningfulString);

    return episodes && episodes.length > 0
      ? `${seriesTitle} - ${episodes.join(", ")}`
      : seriesTitle;
  }

  if (isRadarrCandidate(candidate)) {
    return candidate.movie?.title ?? fallback;
  }

  return fallback;
};

export const extractDownloadId = (
  candidate: ManualImportCandidateUnion,
): string | undefined => {
  const value = candidate.downloadId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const candidateKey = (candidate: ManualImportCandidateUnion): string =>
  `${candidate.service}:${candidate.id}`;

export const candidateDisplayPath = (
  candidate: ManualImportCandidateUnion,
): string =>
  candidate.relativePath ??
  candidate.path ??
  candidate.name ??
  String(candidate.id ?? "candidate");

export const describeQuality = (quality: unknown): string => {
  if (!quality || typeof quality !== "object") {
    return "";
  }

  const source = quality as Record<string, unknown>;
  const nested = source.quality;
  const qualityObject =
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)
      : undefined;

  const nameCandidates: Array<unknown> = [
    qualityObject?.name,
    qualityObject?.source,
    qualityObject?.label,
    source.name,
    source.label,
    source.resolution,
  ];

  for (const candidate of nameCandidates) {
    if (isMeaningfulString(candidate)) {
      return candidate.trim();
    }
  }

  return "";
};

export const describeLanguages = (languages: unknown): string => {
  if (!Array.isArray(languages) || languages.length === 0) {
    return "";
  }

  const extract = (entry: unknown): string | undefined => {
    if (isMeaningfulString(entry)) {
      return entry.trim();
    }
    if (!entry || typeof entry !== "object") {
      return undefined;
    }

    const record = entry as Record<string, unknown>;
    const language =
      typeof record.language === "object" && record.language !== null
        ? (record.language as Record<string, unknown>)
        : undefined;

    const candidates: Array<unknown> = [
      record.name,
      record.label,
      record.code,
      language?.name,
      language?.label,
      language?.code,
    ];

    for (const candidate of candidates) {
      if (isMeaningfulString(candidate)) {
        return candidate.trim();
      }
    }

    return undefined;
  };

  const names = languages
    .map((entry) => extract(entry))
    .filter(isMeaningfulString);

  return names.join(", ");
};

export const formatFileSize = (size?: number): string => {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};
