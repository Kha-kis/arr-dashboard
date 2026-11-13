/** Session-only active-source quality; never file bitrate or transport secrets. */
export interface JellyfinSessionSourceQuality {
	videoCodec?: string;
	audioCodec?: string;
	width?: number;
	height?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function index(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function dimension(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function activeStreams(
	item: Record<string, unknown>,
	state: Record<string, unknown>,
	provider: "JELLYFIN" | "EMBY",
): unknown {
	const id = state.MediaSourceId;
	if (id != null && (typeof id !== "string" || !id.trim())) return undefined;
	if (state.MediaSource != null) {
		const source = record(state.MediaSource);
		// An explicitly supplied but inconsistent source must not fall back to
		// another version's top-level/default streams.
		if (!source || (id != null && source.Id !== id)) return undefined;
		return source.MediaStreams;
	}
	if (item.MediaSources != null) {
		if (!Array.isArray(item.MediaSources) || typeof id !== "string") return undefined;
		const sources = item.MediaSources.map(record);
		if (sources.some((source) => !source || !text(source.Id))) return undefined;
		const matches = sources.filter((source) => source?.Id === id);
		return matches.length === 1 ? matches[0]?.MediaStreams : undefined;
	}
	// Jellyfin SessionManager projects the resolved active source into this
	// list, including alternate versions. Emby's BaseItemDto cannot establish
	// the same guarantee when its active version differs from the item ID.
	if (provider === "EMBY" && id != null && id !== item.Id) return undefined;
	return item.MediaStreams;
}

export function readJellyfinSessionSourceQuality(
	itemValue: unknown,
	stateValue: unknown,
	provider: "JELLYFIN" | "EMBY",
): JellyfinSessionSourceQuality {
	const item = record(itemValue);
	if (!item) return {};
	const state = record(stateValue) ?? {};
	const rawStreams = activeStreams(item, state, provider);
	if (!Array.isArray(rawStreams)) return {};
	const streams = rawStreams.map(record);
	// Do not silently drop an unidentified row and then call the remaining
	// track unique. Malformed quality fields within an identified row remain
	// independent, so an absent codec does not discard valid dimensions.
	if (streams.some((stream) => !stream || !text(stream.Type))) return {};
	const videos = streams.filter((stream) => stream?.Type === "Video");
	const video = videos.length === 1 ? videos[0] : undefined;
	const audioIndex = index(state.AudioStreamIndex);
	const audioCandidates =
		state.AudioStreamIndex == null
			? streams.filter((stream) => stream?.Type === "Audio")
			: audioIndex === undefined
				? []
				: streams.filter((stream) => stream?.Index === audioIndex);
	const audio =
		audioCandidates.length === 1 && audioCandidates[0]?.Type === "Audio"
			? audioCandidates[0]
			: undefined;
	const width = dimension(video?.Width);
	const height = dimension(video?.Height);
	return {
		videoCodec: text(video?.Codec),
		audioCodec: text(audio?.Codec),
		width: width !== undefined && height !== undefined ? width : undefined,
		height: width !== undefined && height !== undefined ? height : undefined,
	};
}
