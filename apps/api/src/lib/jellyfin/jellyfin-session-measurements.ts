import { getSessionBandwidthKbps, normalizeSessionPlaybackDecision } from "@arr/shared";
import type { JellyfinSession } from "./jellyfin-client.js";

function text(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

function resolution(width: number | undefined, height: number | undefined): string | undefined {
	return typeof width === "number" &&
		Number.isSafeInteger(width) &&
		width > 0 &&
		typeof height === "number" &&
		Number.isSafeInteger(height) &&
		height > 0
		? `${width}x${height}`
		: undefined;
}

/** Per-track evidence: an overall transcode may only encode the audio track. */
export function projectJellyfinSessionMeasurements(
	session: Pick<JellyfinSession, "playMethod" | "transcodingInfo" | "sourceQuality">,
) {
	const method = normalizeSessionPlaybackDecision(session.playMethod);
	const info = session.transcodingInfo;
	let videoDecision = "unknown";
	if (info?.isVideoDirect === false) {
		if (method === "transcode" || method === "unknown") videoDecision = "transcode";
	} else if (method === "direct_play") {
		videoDecision = "direct play";
	} else if (
		method === "direct_stream" ||
		(method === "transcode" && info?.isVideoDirect === true)
	) {
		videoDecision = "copy";
	}
	let audioDecision = "unknown";
	if (info?.isAudioDirect === false) {
		if (method !== "direct_play") audioDecision = "transcode";
	} else if (method === "direct_play") {
		audioDecision = "direct play";
	} else if (info?.isAudioDirect === true) {
		audioDecision = "copy";
	}
	const bitrate = getSessionBandwidthKbps(info?.bitrate);
	const sourceVideo =
		videoDecision === "direct play" || videoDecision === "copy" ? session.sourceQuality : undefined;
	const sourceAudio =
		audioDecision === "direct play" || audioDecision === "copy" ? session.sourceQuality : undefined;
	return {
		videoDecision,
		audioDecision,
		bandwidth: bitrate === null ? undefined : bitrate / 1000,
		videoCodec: text(info?.videoCodec) ?? text(sourceVideo?.videoCodec),
		audioCodec: text(info?.audioCodec) ?? text(sourceAudio?.audioCodec),
		videoResolution:
			resolution(info?.width, info?.height) ?? resolution(sourceVideo?.width, sourceVideo?.height),
	};
}
