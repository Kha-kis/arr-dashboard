import type { LibraryEpisode, LibraryEpisodeFile } from "@arr/shared";
import { toBoolean, toNumber, toStringValue } from "./type-converters.js";

/**
 * Extracts episode file metadata from the embedded episodeFile object.
 * This is only present when the API was called with includeEpisodeFile=true.
 */
const normalizeEpisodeFile = (
	raw: Record<string, unknown> | undefined | null,
): LibraryEpisodeFile | undefined => {
	if (!raw || typeof raw !== "object") return undefined;

	const quality = raw.quality as Record<string, unknown> | undefined;
	const qualityInner = quality?.quality as Record<string, unknown> | undefined;
	const mediaInfo = raw.mediaInfo as Record<string, unknown> | undefined;
	const languages = raw.languages as Array<Record<string, unknown>> | undefined;
	const customFormats = raw.customFormats as Array<Record<string, unknown>> | undefined;

	return {
		relativePath: toStringValue(raw.relativePath),
		quality: toStringValue(qualityInner?.name),
		releaseGroup: toStringValue(raw.releaseGroup),
		size: toNumber(raw.size),
		dateAdded: toStringValue(raw.dateAdded),
		languages: languages
			?.map((l) => toStringValue(l?.name))
			.filter((n): n is string => !!n),
		videoCodec: toStringValue(mediaInfo?.videoCodec),
		audioCodec: toStringValue(mediaInfo?.audioCodec),
		resolution: toStringValue(mediaInfo?.resolution),
		videoDynamicRange: toStringValue(mediaInfo?.videoDynamicRange),
		customFormats: customFormats
			?.map((cf) => toStringValue(cf?.name))
			.filter((n): n is string => !!n),
		customFormatScore: toNumber(raw.customFormatScore),
	};
};

/**
 * Normalizes a raw episode object from Sonarr API
 * @param raw - The raw episode data (unknown object type allows flexible property access, safety enforced via helper functions)
 * @param seriesId - The series ID this episode belongs to
 * @returns A normalized library episode
 */
export const normalizeEpisode = (
	raw: Record<string, unknown>,
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
		runtime: toNumber(raw?.runtime),
		finaleType: toStringValue(raw?.finaleType),
		episodeFile: normalizeEpisodeFile(
			raw?.episodeFile as Record<string, unknown> | undefined,
		),
	};
};
