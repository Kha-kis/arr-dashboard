import type { LibraryEpisode } from "@arr/shared";
import { toBoolean, toNumber, toStringValue } from "./type-converters.js";

/**
 * Normalizes a raw episode object from Sonarr API
 * @param raw - The raw episode data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @param seriesId - The series ID this episode belongs to
 * @returns A normalized library episode
 */
export const normalizeEpisode = (raw: Record<string, unknown>, seriesId: number): LibraryEpisode => {
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
