import { describe, expect, it } from "vitest";
import { projectJellyfinSessionMeasurements } from "../jellyfin-session-measurements.js";

describe("Jellyfin per-track measurement evidence", () => {
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
		"does not publish invalid normalized source dimensions %s",
		(width) => {
			expect(
				projectJellyfinSessionMeasurements({
					playMethod: "DirectPlay",
					sourceQuality: { width, height: 1080, videoCodec: "h264" },
				}),
			).toMatchObject({ videoResolution: undefined, videoCodec: "h264" });
		},
	);
	it.each([
		{ input: {}, video: "unknown", audio: "unknown" },
		{ input: { playMethod: "DirectPlay" }, video: "direct play", audio: "direct play" },
		{ input: { playMethod: "DirectStream" }, video: "copy", audio: "unknown" },
		{ input: { playMethod: "Transcode" }, video: "unknown", audio: "unknown" },
		{ input: { transcodingInfo: {} }, video: "unknown", audio: "unknown" },
		{
			input: {
				playMethod: "Transcode",
				transcodingInfo: { isVideoDirect: false, isAudioDirect: true },
			},
			video: "transcode",
			audio: "copy",
		},
		{
			input: {
				playMethod: "Transcode",
				transcodingInfo: { isVideoDirect: true, isAudioDirect: false },
			},
			video: "copy",
			audio: "transcode",
		},
		{
			input: {
				playMethod: "DirectPlay",
				transcodingInfo: { isVideoDirect: false, isAudioDirect: false },
			},
			video: "unknown",
			audio: "unknown",
		},
		{
			input: { playMethod: "DirectStream", transcodingInfo: { isVideoDirect: false } },
			video: "unknown",
			audio: "unknown",
		},
		{
			input: { transcodingInfo: { isVideoDirect: false, isAudioDirect: false } },
			video: "transcode",
			audio: "transcode",
		},
		{
			input: { transcodingInfo: { isVideoDirect: true, isAudioDirect: true } },
			video: "unknown",
			audio: "copy",
		},
	])("projects $input without invented decisions", ({ input, video, audio }) => {
		expect(projectJellyfinSessionMeasurements(input)).toMatchObject({
			videoDecision: video,
			audioDecision: audio,
		});
	});
	it.each([
		{ bitrate: 0, expected: 0 },
		{ bitrate: 1234500, expected: 1234.5 },
		{ bitrate: undefined, expected: undefined },
		{ bitrate: -1, expected: undefined },
		{ bitrate: Number.NaN, expected: undefined },
		{ bitrate: Infinity, expected: undefined },
	])("retains the rate evidence $bitrate", ({ bitrate, expected }) => {
		expect(projectJellyfinSessionMeasurements({ transcodingInfo: { bitrate } }).bandwidth).toBe(
			expected,
		);
	});
	it("keeps explicit codec and paired dimensions without a default SD resolution", () => {
		expect(
			projectJellyfinSessionMeasurements({
				transcodingInfo: { videoCodec: " h264 ", audioCodec: "aac", width: 1920, height: 1080 },
			}),
		).toMatchObject({ videoCodec: "h264", audioCodec: "aac", videoResolution: "1920x1080" });
		expect(
			projectJellyfinSessionMeasurements({ transcodingInfo: { width: 1920 } }).videoResolution,
		).toBeUndefined();
		expect(
			projectJellyfinSessionMeasurements({ transcodingInfo: { width: -1, height: 1080 } })
				.videoResolution,
		).toBeUndefined();
	});
});
