/** Sample-based forecasts; compatibility columns cannot certify native rates. */
import type {
	BandwidthForecast,
	ForecastSampleCoverage,
	SnapshotCollectionCoverage,
} from "@arr/shared";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";

export interface SnapshotForForecast {
	capturedAt: Date;
	totalBandwidth: number;
	concurrentStreams: number;
	measurementJson?: string | null;
}

/** Centered, scaled regression avoids overflowing finite large rates in sums. */
export function linearRegression(points: Array<{ x: number; y: number }>): {
	slope: number;
	intercept: number;
} {
	if (points.length < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };
	let scale = 1;
	for (const point of points) scale = Math.max(scale, Math.abs(point.y));
	// Ordinary rates need no scaling; retain precision before extrapolation.
	if (scale < 1e150) scale = 1;
	let meanX = 0;
	let meanY = 0;
	for (const [index, point] of points.entries()) {
		meanX += (point.x - meanX) / (index + 1);
		meanY += (point.y / scale - meanY) / (index + 1);
	}
	let variance = 0;
	let covariance = 0;
	for (const point of points) {
		const dx = point.x - meanX;
		variance += dx * dx;
		covariance += dx * (point.y / scale - meanY);
	}
	const normalizedSlope = variance === 0 ? 0 : covariance / variance;
	return { slope: normalizedSlope * scale, intercept: (meanY - normalizedSlope * meanX) * scale };
}

function collection(): SnapshotCollectionCoverage {
	return {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};
}
interface Aggregate {
	observedSessions: number;
	measuredSessions: number;
	observedSnapshots: number;
	measuredSnapshots: number;
	completeTotalSnapshots: number;
	completeMean: number;
	completePeak: number | null;
	knownMean: number;
	knownPeak: number | null;
	concurrentMean: number;
	bases: Set<"provider-reported" | "encoding-estimate">;
	collection: SnapshotCollectionCoverage;
}
function aggregate(): Aggregate {
	return {
		observedSessions: 0,
		measuredSessions: 0,
		observedSnapshots: 0,
		measuredSnapshots: 0,
		completeTotalSnapshots: 0,
		completeMean: 0,
		completePeak: null,
		knownMean: 0,
		knownPeak: null,
		concurrentMean: 0,
		bases: new Set(),
		collection: collection(),
	};
}
function coverage(value: Aggregate, raw = value.collection): ForecastSampleCoverage {
	const bandwidthBasis =
		value.bases.size > 1 ? "mixed" : (value.bases.values().next().value ?? null);
	return {
		version: 1,
		status:
			value.measuredSnapshots === 0 || bandwidthBasis === "mixed"
				? "unavailable"
				: value.completeTotalSnapshots === value.observedSnapshots &&
						raw.failedSnapshots === 0 &&
						raw.legacySnapshots === 0 &&
						raw.invalidSnapshots === 0
					? "complete"
					: "partial",
		bandwidthBasis,
		observedSessions: value.observedSessions,
		measuredSessions: value.measuredSessions,
		observedSnapshots: value.observedSnapshots,
		measuredSnapshots: value.measuredSnapshots,
		completeTotalSnapshots: value.completeTotalSnapshots,
		collection: { ...raw },
	};
}
function completeMean(value: Aggregate): number | null {
	return value.bases.size <= 1 && value.completeTotalSnapshots > 0 ? value.completeMean : null;
}
function knownMean(value: Aggregate): number | null {
	return value.bases.size <= 1 && value.measuredSnapshots > 0 ? value.knownMean : null;
}
const DAY_MS = 86_400_000;

export interface ForecastAccumulator {
	addSnapshots(snapshots: readonly SnapshotForForecast[]): void;
	getResult(
		forecastDays?: number,
		rawCollection?: SnapshotCollectionCoverage,
		rawByDate?: Record<string, SnapshotCollectionCoverage>,
	): BandwidthForecast;
}

export function createForecastAccumulator(): ForecastAccumulator {
	const global = aggregate();
	const days = new Map<string, Aggregate>();
	const hours = new Map<number, Aggregate>();
	return {
		addSnapshots(snapshots) {
			for (const snap of snapshots) {
				if (!Number.isFinite(snap.capturedAt.getTime())) {
					global.collection.invalidSnapshots++;
					continue;
				}
				const date = snap.capturedAt.toISOString().slice(0, 10);
				const day = days.get(date) ?? aggregate();
				days.set(date, day);
				const hour = snap.capturedAt.getUTCHours();
				const hourly = hours.get(hour) ?? aggregate();
				hours.set(hour, hourly);
				const parsed = parseSessionSnapshotMeasurement(snap.measurementJson);
				for (const target of [global, day, hourly]) {
					if (
						!Number.isSafeInteger(snap.concurrentStreams) ||
						snap.concurrentStreams < 0 ||
						parsed.status === "invalid" ||
						(parsed.status === "verified" &&
							parsed.measurement.observedSessions !== null &&
							parsed.measurement.observedSessions !== snap.concurrentStreams)
					) {
						target.collection.invalidSnapshots++;
						continue;
					}
					if (parsed.status === "legacy") {
						target.collection.legacySnapshots++;
						target.observedSessions += snap.concurrentStreams;
						target.observedSnapshots++;
						target.concurrentMean +=
							(snap.concurrentStreams - target.concurrentMean) / target.observedSnapshots;
						continue;
					}
					const receipt = parsed.measurement;
					if (receipt.status === "failed") {
						target.collection.failedSnapshots++;
						continue;
					}
					if (receipt.status === "idle") {
						target.collection.idleSnapshots++;
						continue;
					}
					const bandwidth = receipt.bandwidth;
					target.collection.activeSnapshots++;
					target.observedSnapshots++;
					target.observedSessions += receipt.observedSessions;
					target.measuredSessions += bandwidth.measuredSessions;
					target.concurrentMean +=
						(receipt.observedSessions - target.concurrentMean) / target.observedSnapshots;
					target.bases.add(receipt.bandwidthBasis);
					const total = bandwidth.knownTotalKbps;
					if (total === null) continue;
					target.measuredSnapshots++;
					target.knownMean += (total - target.knownMean) / target.measuredSnapshots;
					target.knownPeak = Math.max(target.knownPeak ?? total, total);
					if (bandwidth.status !== "complete") continue;
					target.completeTotalSnapshots++;
					target.completeMean += (total - target.completeMean) / target.completeTotalSnapshots;
					target.completePeak = Math.max(target.completePeak ?? total, total);
				}
			}
		},
		getResult(forecastDays = 7, rawCollection = global.collection, rawByDate) {
			const historicalDaily = [...new Set([...days.keys(), ...Object.keys(rawByDate ?? {})])]
				.sort()
				.map((date) => {
					const value = days.get(date) ?? aggregate();
					return {
						date,
						avgBandwidth: completeMean(value),
						peakBandwidth: value.bases.size > 1 ? null : value.completePeak,
						avgKnownSubtotal: knownMean(value),
						peakKnownSubtotal: value.bases.size > 1 ? null : value.knownPeak,
						measurement: coverage(value, rawByDate?.[date] ?? value.collection),
					};
				});
			const peakHours = [...hours.entries()]
				.sort(([a], [b]) => a - b)
				.map(([hour, value]) => ({
					hour,
					avgConcurrent: value.observedSnapshots > 0 ? value.concurrentMean : null,
					avgBandwidth: completeMean(value),
					avgKnownSubtotal: knownMean(value),
					measurement: coverage(value),
				}));
			const measured = coverage(global, rawCollection);
			const eligible = historicalDaily.filter(
				(day): day is typeof day & { peakBandwidth: number } => day.peakBandwidth !== null,
			);
			let projectionStatus: NonNullable<BandwidthForecast["measurement"]>["projectionStatus"] =
				measured.bandwidthBasis === "mixed"
					? "mixed-basis"
					: eligible.length < 2
						? "insufficient-data"
						: "available";
			let forecast: BandwidthForecast["forecast"] = [];
			let trend: BandwidthForecast["trend"] = "unknown";
			if (projectionStatus === "available") {
				const origin = new Date(eligible[0]!.date).getTime();
				const points = eligible.map((day) => ({
					x: (new Date(day.date).getTime() - origin) / DAY_MS,
					y: day.peakBandwidth,
				}));
				const { slope, intercept } = linearRegression(points);
				const last = new Date(historicalDaily[historicalDaily.length - 1]!.date).getTime();
				const horizon = Number.isSafeInteger(forecastDays)
					? Math.min(90, Math.max(0, forecastDays))
					: 7;
				for (let i = 1; i <= horizon; i++) {
					const date = last + i * DAY_MS;
					const predictedPeak = Math.max(0, intercept + slope * ((date - origin) / DAY_MS));
					if (!Number.isFinite(predictedPeak)) {
						projectionStatus = "numeric-unavailable";
						forecast = [];
						break;
					}
					forecast.push({ date: new Date(date).toISOString().slice(0, 10), predictedPeak });
				}
				if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
					projectionStatus = "numeric-unavailable";
					forecast = [];
				}
				if (projectionStatus === "available") {
					let average = 0;
					for (const [index, point] of points.entries())
						average += (point.y - average) / (index + 1);
					const threshold = average * 0.05;
					trend = slope > threshold ? "increasing" : slope < -threshold ? "decreasing" : "stable";
				}
			}
			return {
				historicalDaily,
				forecast,
				peakHours,
				trend,
				measurement: { ...measured, eligibleDays: eligible.length, projectionStatus },
			};
		},
	};
}

export function computeForecast(
	snapshots: SnapshotForForecast[],
	forecastDays = 7,
): BandwidthForecast {
	const accumulator = createForecastAccumulator();
	accumulator.addSnapshots(snapshots);
	return accumulator.getResult(forecastDays);
}
