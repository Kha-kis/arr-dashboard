import { describe, expect, it } from "vitest";
import { plexSessionsResponseSchema } from "../plex-schemas.js";
import { projectSessionMeasurements } from "../plex-session-measurements.js";

function project(evidence: Record<string, unknown>) {
	const parsed = plexSessionsResponseSchema.parse({
		MediaContainer: { Metadata: [{ sessionKey: "1", ratingKey: "2", ...evidence }] },
	});
	return projectSessionMeasurements(parsed.MediaContainer.Metadata![0]!);
}
function media(part: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return {
		Media: [
			{ videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, Part: [part], ...extra },
		],
	};
}

describe("native Plex session evidence projection", () => {
	it.each([
		["no evidence", {}, "unknown", "unknown"],
		["part directplay", media({ decision: "directplay" }), "direct play", "direct play"],
		["overall transcode alone", media({ decision: "transcode" }), "unknown", "unknown"],
		[
			"explicit tracks",
			{ TranscodeSession: { videoDecision: "transcode", audioDecision: "copy" } },
			"transcode",
			"copy",
		],
		[
			"explicit directplay",
			{ TranscodeSession: { videoDecision: "DirectPlay", audioDecision: "direct play" } },
			"direct play",
			"direct play",
		],
		[
			"stream decisions",
			media({
				Stream: [
					{ streamType: 1, decision: "copy" },
					{ streamType: 2, decision: "transcode" },
				],
			}),
			"copy",
			"transcode",
		],
		[
			"unknown method blocks fallback",
			{ ...media({ decision: "directplay" }), TranscodeSession: { videoDecision: "new-method" } },
			"unknown",
			"direct play",
		],
		[
			"malformed method blocks fallback",
			{ ...media({ decision: "directplay" }), TranscodeSession: { videoDecision: {} } },
			"unknown",
			"direct play",
		],
		[
			"null method blocks fallback",
			{ ...media({ decision: "directplay" }), TranscodeSession: { videoDecision: null } },
			"unknown",
			"direct play",
		],
		[
			"transcoder and stream conflict",
			{
				...media({ Stream: [{ streamType: 1, decision: "copy" }] }),
				TranscodeSession: { videoDecision: "transcode" },
			},
			"unknown",
			"unknown",
		],
		[
			"part and stream conflict",
			media({ decision: "directplay", Stream: [{ streamType: 1, decision: "copy" }] }),
			"unknown",
			"direct play",
		],
		[
			"part and transcoder conflict",
			{ ...media({ decision: "directplay" }), TranscodeSession: { audioDecision: "transcode" } },
			"direct play",
			"unknown",
		],
		[
			"unknown stream decision blocks fallback",
			media({ decision: "directplay", Stream: [{ streamType: 1, decision: "new-method" }] }),
			"unknown",
			"direct play",
		],
		[
			"ambiguous media",
			{ Media: [{ Part: [{ decision: "directplay" }] }, { Part: [{ decision: "directplay" }] }] },
			"unknown",
			"unknown",
		],
		[
			"ambiguous parts",
			media(
				{ decision: "directplay" },
				{ Part: [{ decision: "directplay" }, { decision: "directplay" }] },
			),
			"unknown",
			"unknown",
		],
		[
			"explicitly unselected media",
			media({ decision: "directplay" }, { selected: "0" }),
			"unknown",
			"unknown",
		],
		[
			"explicitly unselected part",
			media({ selected: false, decision: "directplay" }),
			"unknown",
			"unknown",
		],
		[
			"ambiguous streams",
			media({
				decision: "directplay",
				Stream: [
					{ streamType: 1, decision: "directplay" },
					{ streamType: 1, decision: "transcode" },
				],
			}),
			"unknown",
			"direct play",
		],
		[
			"multiple selected streams",
			media({
				decision: "directplay",
				Stream: [
					{ streamType: 1, selected: 1, decision: "directplay" },
					{ streamType: 1, selected: true, decision: "directplay" },
				],
			}),
			"unknown",
			"direct play",
		],
	] as const)("normalizes %s without guessing", (_name, evidence, videoDecision, audioDecision) => {
		expect(project(evidence)).toMatchObject({ videoDecision, audioDecision });
	});
	it.each([true, 1, "1"])("selects one explicit Media, Part and track with flag %s", (selected) => {
		expect(
			project({
				Media: [
					{ Part: [{ decision: "transcode" }] },
					{
						selected,
						videoCodec: "fallback-video",
						audioCodec: "fallback-audio",
						Part: [
							{ decision: "transcode" },
							{
								selected,
								decision: "directplay",
								Stream: [
									{ streamType: 1, codec: "unselected" },
									{ streamType: 1, selected, codec: "hevc", width: 3840, height: 2160 },
									{ streamType: "2", selected, codec: "opus" },
								],
							},
						],
					},
				],
			}),
		).toEqual({
			videoDecision: "direct play",
			audioDecision: "direct play",
			videoCodec: "hevc",
			audioCodec: "opus",
			videoResolution: "3840x2160",
		});
	});
	it("retains transcode output instead of source codecs/dimensions", () => {
		expect(
			project({
				...media({ Stream: [{ streamType: 1, codec: "hevc", width: 3840, height: 2160 }] }),
				TranscodeSession: {
					videoDecision: "transcode",
					audioDecision: "transcode",
					videoCodec: "h264",
					audioCodec: "aac",
					width: 1280,
					height: 720,
				},
			}),
		).toEqual({
			videoDecision: "transcode",
			audioDecision: "transcode",
			videoCodec: "h264",
			audioCodec: "aac",
			videoResolution: "1280x720",
		});
	});
	it("leaves missing transcode output unknown even when source fields are available", () => {
		expect(
			project({
				...media({}),
				TranscodeSession: { videoDecision: "transcode", audioDecision: "transcode" },
			}),
		).toEqual({
			videoDecision: "transcode",
			audioDecision: "transcode",
			videoCodec: undefined,
			audioCodec: undefined,
			videoResolution: undefined,
		});
	});
	it("captures passthrough audio alongside transcoded video", () => {
		expect(
			project({
				...media({ Stream: [{ streamType: 2, codec: "flac", decision: "copy" }] }),
				TranscodeSession: { videoDecision: "transcode", audioDecision: "copy", videoCodec: "h264" },
			}),
		).toEqual({
			videoDecision: "transcode",
			audioDecision: "copy",
			videoCodec: "h264",
			audioCodec: "flac",
			videoResolution: undefined,
		});
	});
	it.each([0, -1, 1.5, "1920", null, {}])(
		"rejects invalid width %s without inventing SD",
		(width) => {
			expect(project(media({ decision: "directplay" }, { width })).videoResolution).toBeUndefined();
		},
	);
	it("uses a nonblank explicit passthrough resolution when dimensions are unavailable", () => {
		expect(
			project(
				media(
					{ decision: "directplay" },
					{ width: undefined, height: undefined, videoResolution: " 1080 " },
				),
			).videoResolution,
		).toBe("1080");
	});
	it.each(["", "   ", 1080, null])("rejects invalid explicit resolution %s", (videoResolution) => {
		expect(
			project(
				media({ decision: "directplay" }, { width: undefined, height: undefined, videoResolution }),
			).videoResolution,
		).toBeUndefined();
	});
	it("does not replace a malformed selected track codec with a source fallback", () => {
		expect(
			project(media({ decision: "directplay", Stream: [{ streamType: 1, codec: {} }] })).videoCodec,
		).toBeUndefined();
	});
	it("uses Media codec only when the selected track codec is absent", () => {
		expect(project(media({ decision: "directplay", Stream: [{ streamType: 1 }] })).videoCodec).toBe(
			"h264",
		);
	});
	it("keeps unrelated malformed metadata from invalidating explicit selected evidence", () => {
		expect(
			project({
				Media: [
					null,
					{ selected: 1, unrelated: {}, Part: [null, { selected: 1, decision: "directplay" }] },
				],
			}),
		).toMatchObject({ videoDecision: "direct play", audioDecision: "direct play" });
	});
});
