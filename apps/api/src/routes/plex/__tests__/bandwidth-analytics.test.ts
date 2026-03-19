import { describe, expect, it } from "vitest";
import { aggregateBandwidthAnalytics, type SnapshotForBandwidth } from "../lib/bandwidth-analytics-helpers.js";

function snapshot(date: string, concurrent: number, total: number, lan: number, wan: number): SnapshotForBandwidth {
	return { capturedAt: new Date(`${date}T12:00:00Z`), concurrentStreams: concurrent, totalBandwidth: total, lanBandwidth: lan, wanBandwidth: wan };
}

describe("aggregateBandwidthAnalytics", () => {
	it("computes peaks, averages, and time series across multiple days", () => {
		const snapshots = [
			snapshot("2025-01-01", 3, 1000, 600, 400),
			snapshot("2025-01-01", 5, 2000, 1200, 800),
			snapshot("2025-01-02", 2, 500, 300, 200),
		];

		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.peakConcurrent).toBe(5);
		expect(result.peakBandwidth).toBe(2000);
		expect(result.avgBandwidth).toBe(Math.round(3500 / 3));
		expect(result.timeSeries).toHaveLength(2);
		// Day 1: peak concurrent=5, avg bandwidth=1500, avg lan=900, avg wan=600
		expect(result.timeSeries[0]).toEqual({ date: "2025-01-01", concurrent: 5, bandwidth: 1500, lanBandwidth: 900, wanBandwidth: 600 });
		// Day 2: single snapshot
		expect(result.timeSeries[1]).toEqual({ date: "2025-01-02", concurrent: 2, bandwidth: 500, lanBandwidth: 300, wanBandwidth: 200 });
		expect(result.parseFailures).toBe(0);
		expect(result.totalSnapshots).toBe(3);
	});

	it("returns zeroes for empty input", () => {
		const result = aggregateBandwidthAnalytics([]);
		expect(result.peakConcurrent).toBe(0);
		expect(result.peakBandwidth).toBe(0);
		expect(result.avgBandwidth).toBe(0);
		expect(result.timeSeries).toEqual([]);
		expect(result.totalSnapshots).toBe(0);
	});

	it("averages daily bandwidth correctly with multiple snapshots", () => {
		const snapshots = [
			snapshot("2025-03-10", 1, 100, 60, 40),
			snapshot("2025-03-10", 1, 200, 120, 80),
			snapshot("2025-03-10", 1, 300, 180, 120),
		];

		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.timeSeries).toHaveLength(1);
		expect(result.timeSeries[0]?.bandwidth).toBe(200);
		expect(result.timeSeries[0]?.lanBandwidth).toBe(120);
		expect(result.timeSeries[0]?.wanBandwidth).toBe(80);
	});

	it("always reports zero parse failures", () => {
		const snapshots = [snapshot("2025-03-01", 1, 100, 50, 50)];
		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.parseFailures).toBe(0);
	});
});
