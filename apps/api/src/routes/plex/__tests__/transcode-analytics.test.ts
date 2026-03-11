import { describe, expect, it } from "vitest";
import { aggregateTranscodeAnalytics, type SnapshotForTranscode } from "../lib/transcode-analytics-helpers.js";

function snapshot(date: string, directPlay: number, transcode: number, directStream: number): SnapshotForTranscode {
	return { capturedAt: new Date(`${date}T12:00:00Z`), directPlayCount: directPlay, transcodeCount: transcode, directStreamCount: directStream };
}

describe("aggregateTranscodeAnalytics", () => {
	it("aggregates totals and daily breakdown across multiple days", () => {
		const snapshots = [
			snapshot("2025-01-01", 3, 1, 2),
			snapshot("2025-01-01", 1, 2, 0),
			snapshot("2025-01-02", 5, 0, 1),
		];

		const result = aggregateTranscodeAnalytics(snapshots);
		expect(result.directPlay).toBe(9);
		expect(result.transcode).toBe(3);
		expect(result.directStream).toBe(3);
		expect(result.totalSessions).toBe(15);
		expect(result.dailyBreakdown).toHaveLength(2);
		expect(result.dailyBreakdown[0]).toEqual({ date: "2025-01-01", directPlay: 4, transcode: 3, directStream: 2 });
		expect(result.dailyBreakdown[1]).toEqual({ date: "2025-01-02", directPlay: 5, transcode: 0, directStream: 1 });
		expect(result.parseFailures).toBe(0);
		expect(result.totalSnapshots).toBe(3);
	});

	it("returns zeroes for empty input", () => {
		const result = aggregateTranscodeAnalytics([]);
		expect(result.directPlay).toBe(0);
		expect(result.transcode).toBe(0);
		expect(result.directStream).toBe(0);
		expect(result.totalSessions).toBe(0);
		expect(result.dailyBreakdown).toEqual([]);
		expect(result.totalSnapshots).toBe(0);
	});

	it("produces a single daily entry for one day", () => {
		const snapshots = [
			snapshot("2025-06-15", 10, 5, 3),
			snapshot("2025-06-15", 2, 1, 0),
		];

		const result = aggregateTranscodeAnalytics(snapshots);
		expect(result.dailyBreakdown).toHaveLength(1);
		expect(result.dailyBreakdown[0]).toEqual({ date: "2025-06-15", directPlay: 12, transcode: 6, directStream: 3 });
		expect(result.totalSessions).toBe(21);
	});

	it("always reports zero parse failures", () => {
		const snapshots = [snapshot("2025-03-01", 1, 0, 0)];
		const result = aggregateTranscodeAnalytics(snapshots);
		expect(result.parseFailures).toBe(0);
	});
});
