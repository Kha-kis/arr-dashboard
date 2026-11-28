import { describe, expect, it } from "vitest";
import { buildFailedSessionSnapshot } from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	aggregateCodecAnalytics,
	createCodecAnalyticsAccumulator,
	type SnapshotForCodec,
} from "../lib/codec-analytics-helpers.js";

function snapshot(sessions: unknown[]): SnapshotForCodec {
	return {
		sessionsJson: JSON.stringify(sessions),
		concurrentStreams: sessions.length,
		measurementJson: JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: "active",
			observedSessions: sessions.length,
			bandwidthBasis: "provider-reported",
			bandwidth: {
				status: "unavailable",
				observedSessions: sessions.length,
				measuredSessions: 0,
				knownTotalKbps: null,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: sessions.length,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
	};
}

describe("aggregateCodecAnalytics", () => {
	it("retains unknown rows and independent field measurements without crashing on malformed elements", () => {
		const result = aggregateCodecAnalytics([
			snapshot([
				{ videoCodec: " H264 ", audioCodec: "AAC", videoResolution: "1920x1080" },
				{ audioCodec: "eac3", videoResolution: "1080p" },
				null,
			]),
		]);
		expect(result).toMatchObject({
			totalSessions: 3,
			videoCodecs: [
				{ codec: "unknown", count: 2, percent: 66.7 },
				{ codec: "h264", count: 1, percent: 33.3 },
			],
			audioCodecs: [
				{ codec: "aac", count: 1, percent: 33.3 },
				{ codec: "eac3", count: 1, percent: 33.3 },
				{ codec: "unknown", count: 1, percent: 33.3 },
			],
			resolutions: [
				{ resolution: "1080", count: 2, percent: 66.7 },
				{ resolution: "unknown", count: 1, percent: 33.3 },
			],
			measurement: {
				version: 1,
				status: "partial",
				observedSessions: 3,
				videoCodecMeasuredSessions: 1,
				audioCodecMeasuredSessions: 2,
				resolutionMeasuredSessions: 2,
				invalidDetailSnapshots: 1,
			},
		});
	});
	it("does not certify legacy codec categories, while preserving their declared observation count", () => {
		const result = aggregateCodecAnalytics([
			{
				...snapshot([{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" }]),
				concurrentStreams: 4,
				measurementJson: null,
			},
		]);
		expect(result).toMatchObject({
			totalSessions: 4,
			videoCodecs: [{ codec: "unknown", count: 4, percent: 100 }],
			audioCodecs: [{ codec: "unknown", count: 4, percent: 100 }],
			resolutions: [{ resolution: "unknown", count: 4, percent: 100 }],
			measurement: {
				status: "unavailable",
				observedSessions: 4,
				videoCodecMeasuredSessions: 0,
				collection: { legacySnapshots: 1 },
			},
		});
	});
	it.each([null, 7, {}, [], "", " ", "PRIVATE LONG TITLE WITH SPACES", "a".repeat(65)])(
		"normalizes unusable codec category %s to unknown without losing resolution",
		(codec) => {
			const result = aggregateCodecAnalytics([
				snapshot([{ videoCodec: codec, audioCodec: codec, videoResolution: "1080" }]),
			]);
			expect(result.videoCodecs).toEqual([{ codec: "unknown", count: 1, percent: 100 }]);
			expect(result.audioCodecs).toEqual([{ codec: "unknown", count: 1, percent: 100 }]);
			expect(result.resolutions).toEqual([{ resolution: "1080", count: 1, percent: 100 }]);
		},
	);
	it.each([
		["4k", "2160"],
		["2160P", "2160"],
		["2160x3840", "2160"],
		[" 1920 x 1080 ", "1080"],
		["sd", "sd"],
		["unknown", "unknown"],
		["tail-resolution", "unknown"],
		["0", "unknown"],
		["0x1080", "unknown"],
		["1.5", "unknown"],
		["9007199254740992x1080", "unknown"],
		[7, "unknown"],
		[{}, "unknown"],
	])("normalizes resolution %s without inventing SD", (input, resolution) => {
		expect(aggregateCodecAnalytics([snapshot([{ videoResolution: input }])]).resolutions).toEqual([
			{ resolution, count: 1, percent: 100 },
		]);
	});
	it.each(["bad-json", "{}", "null", "[]"])(
		"preserves the receipt denominator when detail %s is unusable",
		(sessionsJson) => {
			const result = aggregateCodecAnalytics([{ ...snapshot([{}]), sessionsJson }]);
			expect(result).toMatchObject({
				totalSessions: 1,
				videoCodecs: [{ codec: "unknown", count: 1, percent: 100 }],
				measurement: { invalidDetailSnapshots: 1, observedSessions: 1 },
			});
		},
	);
	it("does not call failed or inconsistent collection zero activity and accepts raw collection counts", () => {
		const failed = buildFailedSessionSnapshot("PLEX");
		const result = aggregateCodecAnalytics([failed, { ...snapshot([{}]), concurrentStreams: 2 }]);
		expect(result).toMatchObject({
			totalSessions: 0,
			measurement: {
				status: "unavailable",
				collection: { failedSnapshots: 1, invalidSnapshots: 1 },
			},
		});
		const accumulator = createCodecAnalyticsAccumulator();
		accumulator.addSnapshots([
			snapshot([{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" }]),
		]);
		expect(
			accumulator.getResult({
				activeSnapshots: 1,
				idleSnapshots: 2,
				failedSnapshots: 1,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			}),
		).toMatchObject({
			measurement: {
				status: "partial",
				collection: { activeSnapshots: 1, idleSnapshots: 2, failedSnapshots: 1 },
			},
		});
	});
	it("counts video/audio codec and resolution distributions", () => {
		const snapshots = [
			snapshot([
				{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" },
				{ videoCodec: "hevc", audioCodec: "eac3", videoResolution: "2160" },
			]),
			snapshot([{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" }]),
		];

		const result = aggregateCodecAnalytics(snapshots);
		expect(result.totalSessions).toBe(3);
		expect(result.videoCodecs).toHaveLength(2);
		expect(result.videoCodecs[0]).toEqual({ codec: "h264", count: 2, percent: 66.7 });
		expect(result.videoCodecs[1]).toEqual({ codec: "hevc", count: 1, percent: 33.3 });
	});

	it("treats missing fields as 'unknown'", () => {
		const snapshots = [
			snapshot([{ videoCodec: null, audioCodec: undefined, videoResolution: "" }]),
		];

		const result = aggregateCodecAnalytics(snapshots);
		expect(result.videoCodecs[0]?.codec).toBe("unknown");
		expect(result.audioCodecs[0]?.codec).toBe("unknown");
		expect(result.resolutions[0]?.resolution).toBe("unknown");
	});

	it("returns empty results for no snapshots", () => {
		const result = aggregateCodecAnalytics([]);
		expect(result.totalSessions).toBe(0);
		expect(result.videoCodecs).toEqual([]);
	});

	it("handles malformed sessionsJson", () => {
		const result = aggregateCodecAnalytics([{ sessionsJson: "bad" }]);
		expect(result.totalSessions).toBe(0);
	});

	it.each([
		["null", "null"],
		["empty object", "{}"],
		["number", "42"],
	])("treats valid-but-non-iterable JSON (%s) as a parse failure", (_label, sessionsJson) => {
		const result = aggregateCodecAnalytics([{ sessionsJson }]);
		expect(result.parseFailures).toBe(1);
		expect(result.failedPreviews).toEqual([]);
		expect(result.totalSessions).toBe(0);
	});

	it("sorts by count descending", () => {
		const snapshots = [
			snapshot([
				{ videoCodec: "av1", audioCodec: "opus", videoResolution: "720" },
				{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" },
				{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" },
			]),
		];

		const result = aggregateCodecAnalytics(snapshots);
		expect(result.videoCodecs[0]?.codec).toBe("h264");
		expect(result.resolutions[0]?.resolution).toBe("1080");
	});

	it("accumulates uneven pages before calculating global percentages", () => {
		const batches = [
			[snapshot([{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" }])],
			[
				snapshot([
					{ videoCodec: "hevc", audioCodec: "eac3", videoResolution: "2160" },
					{ videoCodec: "hevc", audioCodec: "eac3", videoResolution: "2160" },
				]),
				snapshot([{ videoCodec: null, audioCodec: "", videoResolution: undefined }]),
				{ sessionsJson: "broken-json" },
				{ sessionsJson: "{}" },
			],
		];
		const accumulator = createCodecAnalyticsAccumulator();
		for (const batch of batches) accumulator.addSnapshots(batch);
		const expected = {
			videoCodecs: [
				{ codec: "hevc", count: 2, percent: 50 },
				{ codec: "h264", count: 1, percent: 25 },
				{ codec: "unknown", count: 1, percent: 25 },
			],
			audioCodecs: [
				{ codec: "eac3", count: 2, percent: 50 },
				{ codec: "aac", count: 1, percent: 25 },
				{ codec: "unknown", count: 1, percent: 25 },
			],
			resolutions: [
				{ resolution: "2160", count: 2, percent: 50 },
				{ resolution: "1080", count: 1, percent: 25 },
				{ resolution: "unknown", count: 1, percent: 25 },
			],
			totalSessions: 4,
			parseFailures: 2,
			totalSnapshots: 5,
			failedPreviews: [],
		};
		expect(accumulator.getResult()).toMatchObject(expected);
		expect(aggregateCodecAnalytics(batches.flat())).toMatchObject(expected);
	});
});
