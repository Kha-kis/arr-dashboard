import { normalizeSessionPlaybackDecision, type SessionPlaybackDecision } from "@arr/shared";

type Evidence = Record<string, unknown>;
type Selection = { item?: Evidence; ambiguous: boolean };

function object(value: unknown): Evidence | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Evidence)
		: undefined;
}

function select(value: unknown): Selection {
	if (value === undefined) return { ambiguous: false };
	if (!Array.isArray(value)) return { ambiguous: true };
	const selected = value.filter((entry) => {
		const flag = object(entry)?.selected;
		return flag === true || flag === 1 || flag === "1";
	});
	if (selected.length === 1) return { item: object(selected[0]), ambiguous: false };
	if (selected.length > 1) return { ambiguous: true };
	if (value.length === 0) return { ambiguous: false };
	if (value.length !== 1) return { ambiguous: true };
	const item = object(value[0]);
	if (!item) return { ambiguous: true };
	const flag = item.selected;
	return flag === false || flag === 0 || flag === "0"
		? { ambiguous: true }
		: { item, ambiguous: false };
}

function track(part: Evidence | undefined, streamType: number): Selection {
	if (part?.Stream === undefined) return { ambiguous: false };
	if (!Array.isArray(part.Stream)) return { ambiguous: true };
	return select(
		part.Stream.filter((entry) => {
			const type = object(entry)?.streamType;
			return type === streamType || type === String(streamType);
		}),
	);
}

function decision(
	transcodeValue: unknown,
	stream: Selection,
	partValue: unknown,
): SessionPlaybackDecision {
	if (stream.ambiguous) return "unknown";
	const explicit = [transcodeValue, stream.item?.decision].filter((value) => value !== undefined);
	const normalized = explicit.map(normalizeSessionPlaybackDecision);
	if (normalized.includes("unknown") || new Set(normalized).size > 1) return "unknown";
	const partDirectPlay = normalizeSessionPlaybackDecision(partValue) === "direct_play";
	const perTrack = normalized[0];
	if (partDirectPlay && perTrack !== undefined && perTrack !== "direct_play") return "unknown";
	return perTrack ?? (partDirectPlay ? "direct_play" : "unknown");
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function dimensions(evidence: Evidence | undefined): string | undefined {
	const width = evidence?.width;
	const height = evidence?.height;
	return typeof width === "number" &&
		Number.isInteger(width) &&
		width > 0 &&
		typeof height === "number" &&
		Number.isInteger(height) &&
		height > 0
		? `${width}x${height}`
		: undefined;
}

function codec(
	method: SessionPlaybackDecision,
	stream: Selection,
	media: Evidence | undefined,
	transcode: Evidence | undefined,
	field: "videoCodec" | "audioCodec",
): string | undefined {
	if (method === "transcode") return text(transcode?.[field]);
	if (method === "unknown") return undefined;
	return text(stream.item?.codec !== undefined ? stream.item.codec : media?.[field]);
}

function nativeDecision(method: SessionPlaybackDecision): string {
	if (method === "direct_play") return "direct play";
	if (method === "direct_stream") return "copy";
	return method;
}

/** Project only explicitly reported, unambiguous measurements from one session. */
export function projectSessionMeasurements(session: {
	Media?: unknown;
	TranscodeSession?: unknown;
}) {
	const media = select(session.Media).item;
	const part = select(media?.Part).item;
	const video = track(part, 1);
	const audio = track(part, 2);
	const transcode = object(session.TranscodeSession);
	const videoDecision = decision(transcode?.videoDecision, video, part?.decision);
	const audioDecision = decision(transcode?.audioDecision, audio, part?.decision);
	const sourceDimensions =
		video.item?.width !== undefined || video.item?.height !== undefined ? video.item : media;
	return {
		videoDecision: nativeDecision(videoDecision),
		audioDecision: nativeDecision(audioDecision),
		videoCodec: codec(videoDecision, video, media, transcode, "videoCodec"),
		audioCodec: codec(audioDecision, audio, media, transcode, "audioCodec"),
		videoResolution:
			videoDecision === "transcode"
				? dimensions(transcode)
				: videoDecision === "unknown"
					? undefined
					: (dimensions(sourceDimensions) ?? text(media?.videoResolution)),
	};
}
