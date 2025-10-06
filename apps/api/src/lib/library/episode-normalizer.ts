import type { LibraryEpisode } from "@arr/shared";
import { toBoolean, toNumber, toStringValue } from "./type-converters";

/**
 * Normalizes a raw episode object from Sonarr API
 * @param raw - The raw episode data
 * @param seriesId - The series ID this episode belongs to
 * @returns A normalized library episode
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const normalizeEpisode = (
  raw: any,
  seriesId: number,
): LibraryEpisode => {
  return {
    id: toNumber(raw?.id) ?? 0,
    seriesId,
    episodeNumber: toNumber(raw?.episodeNumber) ?? 0,
    seasonNumber: toNumber(raw?.seasonNumber) ?? 0,
    title: toStringValue(raw?.title),
    airDate: toStringValue(raw?.airDate ?? raw?.airDateUtc),
    hasFile: Boolean(raw?.hasFile),
    monitored: toBoolean(raw?.monitored),
    overview: toStringValue(raw?.overview),
    episodeFileId: toNumber(raw?.episodeFileId),
  };
};
