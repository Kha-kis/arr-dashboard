import { describe, expect, it } from "vitest";
import { computeForecast, linearRegression, type SnapshotForForecast } from "../lib/forecast-helpers.js";

function snapshot(capturedAt: string, bandwidth: number, concurrent = 1): SnapshotForForecast {
	return {
		capturedAt: new Date(capturedAt),
		totalBandwidth: bandwidth,
		concurrentStreams: concurrent,
	};
}

describe("linearRegression", () => {
	it("computes slope and intercept for linear data", () => {
		const points = [
			{ x: 0, y: 10 },
			{ x: 1, y: 20 },
			{ x: 2, y: 30 },
		];
		const result = linearRegression(points);
		expect(result.slope).toBeCloseTo(10, 5);
		expect(result.intercept).toBeCloseTo(10, 5);
	});

	it("handles single point", () => {
		const result = linearRegression([{ x: 0, y: 42 }]);
		expect(result.slope).toBe(0);
		expect(result.intercept).toBe(42);
	});

	it("handles empty array", () => {
		const result = linearRegression([]);
		expect(result.slope).toBe(0);
		expect(result.intercept).toBe(0);
	});
});

describe("computeForecast", () => {
	it("returns empty for no snapshots", () => {
		const result = computeForecast([]);
		expect(result.historicalDaily).toEqual([]);
		expect(result.forecast).toEqual([]);
		expect(result.trend).toBe("stable");
	});

	it("computes daily historical averages and peaks", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", 5000, 2),
			snapshot("2025-01-15T14:00:00Z", 8000, 3),
			snapshot("2025-01-16T10:00:00Z", 6000, 1),
		];

		const result = computeForecast(snapshots);
		expect(result.historicalDaily).toHaveLength(2);
		expect(result.historicalDaily[0]?.peakBandwidth).toBe(8000);
		expect(result.historicalDaily[0]?.avgBandwidth).toBe(6500); // (5000+8000)/2
	});

	it("generates 7-day forecast by default", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", 5000),
			snapshot("2025-01-16T10:00:00Z", 6000),
		];

		const result = computeForecast(snapshots);
		expect(result.forecast).toHaveLength(7);
		expect(result.forecast[0]?.date).toBe("2025-01-17");
	});

	it("groups by hour for peak hours analysis", () => {
		const snapshots = [
			snapshot("2025-01-15T20:00:00Z", 10000, 5),
			snapshot("2025-01-16T20:00:00Z", 12000, 4),
			snapshot("2025-01-15T08:00:00Z", 2000, 1),
		];

		const result = computeForecast(snapshots);
		const peak = result.peakHours.find((h) => h.hour === 20);
		expect(peak?.avgBandwidth).toBe(11000); // (10000+12000)/2
		expect(peak?.avgConcurrent).toBe(4.5); // (5+4)/2
	});

	it("identifies increasing trend", () => {
		const snapshots = [
			snapshot("2025-01-10T10:00:00Z", 1000),
			snapshot("2025-01-11T10:00:00Z", 2000),
			snapshot("2025-01-12T10:00:00Z", 3000),
			snapshot("2025-01-13T10:00:00Z", 4000),
			snapshot("2025-01-14T10:00:00Z", 5000),
		];

		const result = computeForecast(snapshots);
		expect(result.trend).toBe("increasing");
	});
});
