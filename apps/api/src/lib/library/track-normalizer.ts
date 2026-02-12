import type { LibraryTrack } from "@arr/shared";
import { toBoolean, toNumber, toStringValue } from "./type-converters.js";

/**
 * Normalizes a raw track object from Lidarr API
 * Tracks are children of albums in Lidarr's data model
 *
 * @param raw - The raw track data
 * @param albumId - The album ID this track belongs to
 * @returns A normalized library track
 */
export const normalizeTrack = (
	raw: Record<string, unknown>,
	albumId: number,
): LibraryTrack => {
	const trackFile = raw?.trackFile as Record<string, unknown> | undefined;
	const mediaInfo = trackFile?.mediaInfo as Record<string, unknown> | undefined;
	const quality = trackFile?.quality as Record<string, unknown> | undefined;
	const qualityInner = quality?.quality as Record<string, unknown> | undefined;

	const result: LibraryTrack = {
		id: toNumber(raw?.id) ?? 0,
		albumId,
		trackNumber: toStringValue(raw?.trackNumber),
		absoluteTrackNumber: toNumber(raw?.absoluteTrackNumber),
		title: toStringValue(raw?.title),
		duration: toNumber(raw?.duration),
		hasFile: toBoolean(raw?.hasFile),
		mediumNumber: toNumber(raw?.mediumNumber),
		explicit: toBoolean(raw?.explicit),
	};

	if (trackFile) {
		result.trackFile = {
			quality: toStringValue(qualityInner?.name),
			size: toNumber(trackFile?.size),
			dateAdded: toStringValue(trackFile?.dateAdded),
			audioCodec: toStringValue(mediaInfo?.audioCodec),
			audioBitRate: toStringValue(mediaInfo?.audioBitRate),
			audioChannels: toNumber(mediaInfo?.audioChannels),
			audioSampleRate: toStringValue(mediaInfo?.audioSampleRate),
		};
	}

	return result;
};
