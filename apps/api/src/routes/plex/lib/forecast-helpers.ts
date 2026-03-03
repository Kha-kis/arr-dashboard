/**
 * Bandwidth Forecast Helpers
 *
 * Pure functions for computing bandwidth forecasts using simple linear regression
 * and peak-hour analysis from SessionSnapshot data.
 */

import type { BandwidthForecast } from "@arr/shared";

/** Snapshot row for forecasting */
export interface SnapshotForForecast {
	capturedAt: Date;
	totalBandwidth: number;
	concurrentStreams: number;
}

/** Simple linear regression on (x, y) data points */
export function linearRegression(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } {
	const n = points.length;
	if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };

	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumXX = 0;

	for (const p of points) {
		sumX += p.x;
		sumY += p.y;
		sumXY += p.x * p.y;
		sumXX += p.x * p.x;
	}

	const denom = n * sumXX - sumX * sumX;
	if (denom === 0) return { slope: 0, intercept: sumY / n };

	const slope = (n * sumXY - sumX * sumY) / denom;
	const intercept = (sumY - slope * sumX) / n;

	return { slope, intercept };
}

/**
 * Compute bandwidth forecast from session snapshots.
 *
 * - Groups snapshots by day for historical daily averages/peaks
 * - Runs linear regression on daily peak bandwidth
 * - Projects next 7 days
 * - Groups snapshots by hour-of-day for peak usage hours
 */
export function computeForecast(
	snapshots: SnapshotForForecast[],
	forecastDays = 7,
): BandwidthForecast {
	if (snapshots.length === 0) {
		return { historicalDaily: [], forecast: [], peakHours: [], trend: "stable" };
	}

	// Group by date
	const dailyMap = new Map<string, { totalBw: number; peakBw: number; count: number }>();
	// Group by hour
	const hourMap = new Map<number, { totalConcurrent: number; totalBw: number; count: number }>();

	for (const snap of snapshots) {
		const dateKey = snap.capturedAt.toISOString().split("T")[0]!;
		const hour = snap.capturedAt.getUTCHours();

		// Daily
		const day = dailyMap.get(dateKey) ?? { totalBw: 0, peakBw: 0, count: 0 };
		day.totalBw += snap.totalBandwidth;
		if (snap.totalBandwidth > day.peakBw) day.peakBw = snap.totalBandwidth;
		day.count++;
		dailyMap.set(dateKey, day);

		// Hourly
		const h = hourMap.get(hour) ?? { totalConcurrent: 0, totalBw: 0, count: 0 };
		h.totalConcurrent += snap.concurrentStreams;
		h.totalBw += snap.totalBandwidth;
		h.count++;
		hourMap.set(hour, h);
	}

	const historicalDaily = [...dailyMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, d]) => ({
			date,
			avgBandwidth: d.count > 0 ? Math.round(d.totalBw / d.count) : 0,
			peakBandwidth: d.peakBw,
		}));

	// Linear regression on daily peak bandwidth
	const regressionPoints = historicalDaily.map((d, i) => ({
		x: i,
		y: d.peakBandwidth,
	}));
	const { slope, intercept } = linearRegression(regressionPoints);

	// Project future days
	const lastDate = historicalDaily[historicalDaily.length - 1]?.date;
	const forecast: Array<{ date: string; predictedPeak: number }> = [];
	if (lastDate) {
		const baseDate = new Date(lastDate);
		const nextX = regressionPoints.length;
		for (let i = 1; i <= forecastDays; i++) {
			const futureDate = new Date(baseDate);
			futureDate.setDate(futureDate.getDate() + i);
			const predicted = Math.max(0, Math.round(intercept + slope * (nextX + i)));
			forecast.push({
				date: futureDate.toISOString().split("T")[0]!,
				predictedPeak: predicted,
			});
		}
	}

	// Peak hours
	const peakHours = [...hourMap.entries()]
		.sort(([a], [b]) => a - b)
		.map(([hour, h]) => ({
			hour,
			avgConcurrent: h.count > 0 ? Math.round((h.totalConcurrent / h.count) * 10) / 10 : 0,
			avgBandwidth: h.count > 0 ? Math.round(h.totalBw / h.count) : 0,
		}));

	// Determine trend from slope
	const avgPeak = historicalDaily.length > 0
		? historicalDaily.reduce((s, d) => s + d.peakBandwidth, 0) / historicalDaily.length
		: 0;
	// If slope > 5% of average per day, it's increasing; < -5% is decreasing
	const threshold = avgPeak * 0.05;
	const trend: BandwidthForecast["trend"] =
		slope > threshold ? "increasing" : slope < -threshold ? "decreasing" : "stable";

	return { historicalDaily, forecast, peakHours, trend };
}
