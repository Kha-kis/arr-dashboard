import { describe, expect, it } from "vitest";
import { aggregateCodecAnalytics, type SnapshotForCodec } from "../lib/codec-analytics-helpers.js";

function snapshot(sessions: Array<Record<string, unknown>>): SnapshotForCodec {
	return { sessionsJson: JSON.stringify(sessions) };
}

describe("aggregateCodecAnalytics", () => {
	it("counts video/audio codec and resolution distributions", () => {
		const snapshots = [
			snapshot([
				{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" },
				{ videoCodec: "hevc", audioCodec: "eac3", videoResolution: "2160" },
			]),
			snapshot([
				{ videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" },
			]),
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
});
