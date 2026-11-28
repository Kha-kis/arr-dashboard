import { describe, expect, it } from "vitest";
import {
	computeForecast,
	createForecastAccumulator,
	linearRegression,
	type SnapshotForForecast,
} from "../lib/forecast-helpers.js";

function snapshot(capturedAt: string, bandwidth: number, concurrent = 1): SnapshotForForecast {
	return {
		capturedAt: new Date(capturedAt),
		totalBandwidth: bandwidth,
		concurrentStreams: concurrent,
		measurementJson: JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: "active",
			observedSessions: concurrent,
			bandwidthBasis: "provider-reported",
			bandwidth: {
				status: "complete",
				observedSessions: concurrent,
				measuredSessions: concurrent,
				knownTotalKbps: bandwidth,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: concurrent,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
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
		expect(result.trend).toBe("unknown");
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

	it("groups daily and hourly sums across uneven pages before rounding and regression", () => {
		const accumulator = createForecastAccumulator();
		accumulator.addSnapshots([snapshot("2025-08-01T14:00:00Z", 2, 1)]);
		accumulator.addSnapshots([
			snapshot("2025-08-01T14:30:00Z", 4, 3),
			snapshot("2025-08-02T14:00:00Z", 6, 5),
		]);

		const result = accumulator.getResult();
		expect(result.historicalDaily).toMatchObject([
			{ date: "2025-08-01", avgBandwidth: 3, peakBandwidth: 4 },
			{ date: "2025-08-02", avgBandwidth: 6, peakBandwidth: 6 },
		]);
		expect(result.peakHours).toMatchObject([{ hour: 14, avgConcurrent: 3, avgBandwidth: 4 }]);
		expect(result.forecast.slice(0, 2)).toEqual([
			{ date: "2025-08-03", predictedPeak: 8 },
			{ date: "2025-08-04", predictedPeak: 10 },
		]);
		expect(result.trend).toBe("increasing");
		expect(accumulator.getResult()).toEqual(
			computeForecast([
				snapshot("2025-08-01T14:00:00Z", 2, 1),
				snapshot("2025-08-01T14:30:00Z", 4, 3),
				snapshot("2025-08-02T14:00:00Z", 6, 5),
			]),
		);
	});

	it("projects increasing, decreasing, and constant peaks from the next historical index", () => {
		const forecastPairs = [
			{
				name: "increasing",
				first: 100,
				second: 200,
				want: [300, 400],
			},
			{
				name: "decreasing",
				first: 300,
				second: 200,
				want: [100, 0],
			},
			{
				name: "constant",
				first: 200,
				second: 200,
				want: [200, 200],
			},
		];

		for (const { name, first, second, want } of forecastPairs) {
			const accumulator = createForecastAccumulator();
			accumulator.addSnapshots([
				snapshot("2025-10-01T12:00:00Z", first),
				snapshot("2025-10-02T12:00:00Z", second),
			]);
			expect(accumulator.getResult().forecast.slice(0, 2), name).toEqual([
				{ date: "2025-10-03", predictedPeak: want[0] },
				{ date: "2025-10-04", predictedPeak: want[1] },
			]);
		}
	});
});
